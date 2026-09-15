import {
  readSubprocessOutput,
  terminateProcessTree,
} from "../src/runtime/subprocess.ts";

const GRAPHIFY_DISTRIBUTION = "graphifyy";
const GRAPHIFY_EXECUTABLE = "graphify";
const GRAPHIFY_VERSION = "0.9.53";

export function graphifyProvisionCommand(python: string): string[] {
  return [
    python,
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    `${GRAPHIFY_DISTRIBUTION}==${GRAPHIFY_VERSION}`,
  ];
}

export type ComparatorCommandRunner = (command: string[]) => Promise<string>;

export interface ComparatorProvisionDependencies {
  findExecutable?: (name: string) => string | null;
  run?: ComparatorCommandRunner;
}

export function comparatorCommandTimeout(command: string[]): number {
  if (command[1] === "--version") return 30_000;
  return 300_000;
}

async function captureCommandStderr(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onUpdate: (value: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  let captured = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      captured += chunk;
      if (captured.length > 65_536) captured = captured.slice(-65_536);
      onUpdate(captured);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  captured += decoder.decode();
  return captured.trim();
}

export async function runComparatorCommand(
  command: string[],
  timeoutMs = comparatorCommandTimeout(command),
): Promise<string> {
  const child = Bun.spawn(command, {
    detached: process.platform !== "win32",
    stderr: "pipe",
    stdout: "pipe",
  });
  const abort = new AbortController();
  let stderrTail = "";
  const completion = Promise.all([
    child.exited,
    captureCommandStderr(child.stderr, abort.signal, (value) => {
      stderrTail = value;
    }),
    readSubprocessOutput(child.stdout, abort.signal, () =>
      terminateProcessTree(child, { force: true }),
    ),
  ]);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
      reject(new Error("Comparator command deadline reached"));
    }, timeoutMs);
  });
  try {
    const [exitCode, stderr, stdout] = await Promise.race([
      completion,
      deadline,
    ]);
    if (exitCode !== 0)
      throw new Error(
        `${command.join(" ")} failed with exit ${exitCode}: ${stderr}`,
      );
    return stdout.trim();
  } catch (error) {
    if (!timedOut) throw error;
    await terminateProcessTree(child, { force: true });
    throw new Error(
      `${command.join(" ")} timed out after ${timeoutMs}ms: ${stderrTail.trim()}`,
    );
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

export async function provisionGraphifyComparator(
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
  dependencies: ComparatorProvisionDependencies = {},
): Promise<{ graphify: string }> {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32")
    throw new Error(`Unsupported comparator platform: ${platform}-${arch}`);
  const findExecutable = dependencies.findExecutable ?? Bun.which;
  const run = dependencies.run ?? runComparatorCommand;
  const existing = findExecutable(GRAPHIFY_EXECUTABLE);
  if (existing) {
    const version = await run([GRAPHIFY_EXECUTABLE, "--version"]);
    if (version === `graphify ${GRAPHIFY_VERSION}`)
      return { graphify: version };
  }
  const python = findExecutable("python") ?? findExecutable("python3");
  if (!python) throw new Error("Python is required to provision graphify");
  await run(graphifyProvisionCommand(python));
  const graphify = await run([GRAPHIFY_EXECUTABLE, "--version"]);
  if (graphify !== `graphify ${GRAPHIFY_VERSION}`)
    throw new Error(
      `Expected graphify ${GRAPHIFY_VERSION}, received ${graphify || "<empty>"}`,
    );
  return { graphify };
}

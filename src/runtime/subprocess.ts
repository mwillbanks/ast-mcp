export interface PlatformCommand {
  args: string[];
  command: string;
  windowsVerbatimArguments?: boolean;
}

export interface ManagedSubprocess {
  exitCode: number | null;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
  pid: number;
}

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export async function readSubprocessOutput(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onOverflow: () => Promise<void>,
) {
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_OUTPUT_BYTES) {
        await onOverflow();
        throw new Error(`command output exceeded ${MAX_OUTPUT_BYTES} bytes`);
      }
      chunks.push(result.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function batchArgument(value: string) {
  if (/[\0\r\n"%!^]/u.test(value))
    throw new Error(
      "Windows batch command arguments cannot contain quotes, expansion characters, or control characters",
    );
  if (/^[A-Za-z0-9_./:\\=-]+$/u.test(value)) return value;
  return `"${value}"`;
}

export function commandForPlatform(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec ?? "cmd.exe",
): PlatformCommand {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command))
    return { args, command };
  const commandLine = `call ${[command, ...args].map(batchArgument).join(" ")}`;
  return {
    args: ["/d", "/v:off", "/s", "/c", commandLine],
    command: comspec,
    windowsVerbatimArguments: true,
  };
}

function settledWithin(processHandle: ManagedSubprocess, timeoutMs: number) {
  return Promise.race([
    processHandle.exited.then(() => true),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
}

function signalPosixProcessTree(
  processHandle: ManagedSubprocess,
  signal: "SIGKILL" | "SIGTERM",
) {
  try {
    process.kill(-processHandle.pid, signal);
  } catch {
    processHandle.kill(signal);
  }
}

export async function terminateProcessTree(
  processHandle: ManagedSubprocess,
  options: {
    force?: boolean;
    graceMs?: number;
    platform?: NodeJS.Platform;
  } = {},
) {
  if (processHandle.exitCode !== null && !options.force) return;
  const graceMs = options.graceMs ?? 500;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    try {
      const taskkill = Bun.spawn(
        ["taskkill.exe", "/PID", String(processHandle.pid), "/T", "/F"],
        { stderr: "ignore", stdin: "ignore", stdout: "ignore" },
      );
      const taskkillSettled = await settledWithin(taskkill, graceMs);
      if (!taskkillSettled && taskkill.exitCode === null) taskkill.kill();
    } catch {
      processHandle.kill();
    }
    if (!(await settledWithin(processHandle, graceMs))) processHandle.kill();
    await settledWithin(processHandle, graceMs);
    return;
  }
  if (options.force) {
    signalPosixProcessTree(processHandle, "SIGKILL");
    await settledWithin(processHandle, graceMs);
    return;
  }
  signalPosixProcessTree(processHandle, "SIGTERM");
  if (await settledWithin(processHandle, graceMs)) return;
  signalPosixProcessTree(processHandle, "SIGKILL");
  await settledWithin(processHandle, graceMs);
}

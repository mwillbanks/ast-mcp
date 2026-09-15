import {
  commandForPlatform,
  terminateProcessTree,
} from "../../src/runtime/subprocess";

type PipeSubprocess = Bun.Subprocess<"pipe", "pipe", "pipe">;

interface LiveProcessOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

function capturedOutput(stdout: string[], stderr: string[]) {
  const output = [
    stdout.length > 0 ? `stdout:\n${stdout.join("").trim()}` : "",
    stderr.length > 0 ? `stderr:\n${stderr.join("").trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return output || "no process output";
}

async function drain(stream: ReadableStream<Uint8Array>, chunks: string[]) {
  const decoder = new TextDecoder();
  for await (const chunk of stream)
    chunks.push(decoder.decode(chunk, { stream: true }));
  chunks.push(decoder.decode());
}

export interface LiveProcess {
  diagnostics(): string;
  process: PipeSubprocess;
  readStdoutLine(timeoutMs?: number): Promise<string>;
  stop(): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<number>;
  waitForStderr(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>;
}

export function spawnLiveProcess(
  command: string,
  args: string[],
  options: LiveProcessOptions = {},
): LiveProcess {
  const platformCommand = commandForPlatform(command, args);
  const processHandle = Bun.spawn(
    [platformCommand.command, ...platformCommand.args],
    {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      stderr: "pipe",
      stdin: "pipe",
      stdout: "pipe",
      windowsVerbatimArguments: platformCommand.windowsVerbatimArguments,
    },
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutDrain = drain(processHandle.stdout, stdout);
  const stderrDrain = drain(processHandle.stderr, stderr);
  let stdoutOffset = 0;
  let stopPromise: Promise<void> | undefined;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function waitFor<T>(
    description: string,
    inspect: () => T | undefined,
    waitMs: number,
  ) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const result = inspect();
      if (result !== undefined) return result;
      if (processHandle.exitCode !== null)
        throw new Error(
          `${description} failed because the process exited with code ${processHandle.exitCode}: ${capturedOutput(stdout, stderr)}`,
        );
      await Bun.sleep(10);
    }
    throw new Error(
      `${description} timed out after ${waitMs}ms: ${capturedOutput(stdout, stderr)}`,
    );
  }

  return {
    diagnostics: () => capturedOutput(stdout, stderr),
    process: processHandle,
    async readStdoutLine(waitMs = timeoutMs) {
      return waitFor(
        "Waiting for a stdout line",
        () => {
          const value = stdout.join("");
          const newline = value.indexOf("\n", stdoutOffset);
          if (newline < 0) return undefined;
          const line = value.slice(stdoutOffset, newline);
          stdoutOffset = newline + 1;
          return line;
        },
        waitMs,
      );
    },
    async stop() {
      stopPromise ??= (async () => {
        await terminateProcessTree(processHandle, { graceMs: 2_000 });
        const drains = Promise.all([stdoutDrain, stderrDrain]);
        if (
          !(await Promise.race([
            drains.then(() => true),
            Bun.sleep(2_000).then(() => false),
          ]))
        ) {
          await terminateProcessTree(processHandle, { force: true });
          if (
            !(await Promise.race([
              drains.then(() => true),
              Bun.sleep(2_000).then(() => false),
            ]))
          )
            throw new Error(
              `Process pipes did not close after teardown: ${capturedOutput(stdout, stderr)}`,
            );
        }
      })();
      await stopPromise;
    },
    async waitForExit(waitMs = timeoutMs) {
      return waitFor(
        "Waiting for process exit",
        () => processHandle.exitCode ?? undefined,
        waitMs,
      );
    },
    async waitForStderr(pattern, waitMs = timeoutMs) {
      return waitFor(
        `Waiting for stderr to match ${pattern}`,
        () => stderr.join("").match(pattern) ?? undefined,
        waitMs,
      );
    },
  };
}

export async function spawnHttpMcpProcess(
  command: string,
  args: string[],
  options: LiveProcessOptions & { host?: string | false } = {},
) {
  const hostArgs =
    options.host === false ? [] : ["--host", options.host ?? "127.0.0.1"];
  const live = spawnLiveProcess(
    command,
    [...args, "--transport", "http", ...hostArgs, "--port", "0"],
    options,
  );
  try {
    const match = await live.waitForStderr(
      /ast-mcp: listening on (https?:\/\/\S+\/mcp)\s/u,
    );
    return { ...live, url: new URL(match[1] as string) };
  } catch (error) {
    await live.stop();
    throw error;
  }
}

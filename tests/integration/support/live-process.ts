import {
  commandForPlatform,
  terminateProcessTree,
} from "../../../src/runtime/subprocess";

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

interface StreamState {
  closed: boolean;
  failure?: { reason: unknown };
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  chunks: string[],
  state: StreamState,
  notify: () => void,
) {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      chunks.push(decoder.decode(chunk, { stream: true }));
      notify();
    }
    chunks.push(decoder.decode());
  } catch (error) {
    state.failure = { reason: error };
    throw error;
  } finally {
    state.closed = true;
    notify();
  }
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
  const changes = new Set<() => void>();
  const notify = () => {
    for (const change of changes) change();
  };
  let processExitCode: number | undefined;
  void processHandle.exited.then((code) => {
    processExitCode = code;
    notify();
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutState: StreamState = { closed: false };
  const stderrState: StreamState = { closed: false };
  const stdoutDrain = drain(processHandle.stdout, stdout, stdoutState, notify);
  const stderrDrain = drain(processHandle.stderr, stderr, stderrState, notify);
  const outputSettled = Promise.allSettled([stdoutDrain, stderrDrain]);
  const outputDrained = outputSettled.then((results) => {
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  });
  // Readiness and teardown surface failures; observe early rejection meanwhile.
  void outputDrained.catch(() => undefined);
  let stdoutOffset = 0;
  let stopPromise: Promise<void> | undefined;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function bounded<T>(
    pending: Promise<T>,
    milliseconds: number,
    fallback: () => T,
  ): Promise<T> {
    const timeout = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      try {
        timeout.resolve(fallback());
      } catch (error) {
        timeout.reject(error);
      }
    }, milliseconds);
    try {
      return await Promise.race([pending, timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitFor<T>(
    description: string,
    inspect: () => T | undefined,
    waitMs: number,
    stream?: { name: "stdout" | "stderr"; state: StreamState },
  ): Promise<T> {
    const controller = new AbortController();
    const operation = (async () => {
      for (;;) {
        const change = Promise.withResolvers<void>();
        const notify = () => change.resolve();
        changes.add(notify);
        try {
          const result = inspect();
          if (result !== undefined) return result;
          if (stream?.state.failure) throw stream.state.failure.reason;
          if (stream?.state.closed) {
            const reason =
              processHandle.exitCode !== null
                ? `the process exited with code ${processHandle.exitCode}`
                : `${stream.name} closed`;
            throw new Error(
              `${description} failed because ${reason}: ${capturedOutput(stdout, stderr)}`,
            );
          }
          if (controller.signal.aborted) throw controller.signal.reason;
          controller.signal.addEventListener("abort", notify, { once: true });
          await change.promise;
        } finally {
          changes.delete(notify);
          controller.signal.removeEventListener("abort", notify);
        }
      }
    })();
    try {
      return await bounded(operation, waitMs, () => {
        throw new Error(
          `${description} timed out after ${waitMs}ms: ${capturedOutput(stdout, stderr)}`,
        );
      });
    } finally {
      controller.abort(new Error("Readiness wait ended"));
    }
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
        { name: "stdout", state: stdoutState },
      );
    },
    async stop() {
      stopPromise ??= (async () => {
        await terminateProcessTree(processHandle, { graceMs: 2_000 });
        const settled = await bounded(
          outputSettled.then(() => true),
          2_000,
          () => false,
        );
        // Failed readers cannot prove that inherited pipes or descendants closed.
        if (!settled || stdoutState.failure || stderrState.failure) {
          await terminateProcessTree(processHandle, { force: true });
          if (
            !settled &&
            !(await bounded(
              outputSettled.then(() => true),
              2_000,
              () => false,
            ))
          )
            throw new Error(
              `Process pipes did not close after teardown: ${capturedOutput(stdout, stderr)}`,
            );
        }
        await outputDrained;
      })();
      await stopPromise;
    },
    // Report leader exit with bounded capture grace; descendants may still own pipes.
    async waitForExit(waitMs = timeoutMs) {
      const exitCode = await waitFor(
        "Waiting for process exit",
        () => processExitCode,
        waitMs,
      );
      await bounded(outputDrained, Math.min(1_000, waitMs), () => undefined);
      return exitCode;
    },
    async waitForStderr(pattern, waitMs = timeoutMs) {
      return waitFor(
        `Waiting for stderr to match ${pattern}`,
        () => stderr.join("").match(pattern) ?? undefined,
        waitMs,
        { name: "stderr", state: stderrState },
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

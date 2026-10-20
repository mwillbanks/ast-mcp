import {
  commandForPlatform,
  readSubprocessOutput,
  terminateProcessTree,
} from "./subprocess";

export function runCommandInput(
  command: string,
  args: string[],
  input: string,
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return (async () => {
    const invocation = commandForPlatform(command, args);
    const child = Bun.spawn([invocation.command, ...invocation.args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      stderr: "pipe",
      stdin: new Blob([input]),
      stdout: "pipe",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const stop = () => terminateProcessTree(child);
    const controller = new AbortController();
    const stdoutPromise = readSubprocessOutput(
      child.stdout,
      controller.signal,
      stop,
      true,
    );
    const stderrPromise = readSubprocessOutput(
      child.stderr,
      controller.signal,
      stop,
      true,
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const completion = Promise.all([
        child.exited,
        stdoutPromise,
        stderrPromise,
      ]);
      const completed = await Promise.race([
        completion.then((value) => value),
        new Promise<null>((resolve) => {
          deadline = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
      if (!completed) {
        await terminateProcessTree(child, { force: true });
        controller.abort();
        throw Object.assign(
          new Error(`${command} timed out after ${timeoutMs}ms`),
          { code: "command_timeout" },
        );
      }
      const [exitCode, stdout, stderr] = completed;
      if (exitCode !== 0) {
        const detail = (stderr || stdout || `exit code ${exitCode}`)
          .trim()
          .slice(0, 4096);
        throw new Error(`${command} failed: ${detail}`);
      }
      return { stderr, stdout };
    } catch (error) {
      await terminateProcessTree(child, { force: true }).catch(() => undefined);
      controller.abort();
      if (
        (error instanceof TypeError &&
          /encoded|encoding/i.test(error.message)) ||
        (error instanceof Error &&
          /command output exceeded/i.test(error.message))
      )
        throw Object.assign(
          new Error(
            "Command output must be valid UTF-8 within the 16777216-byte limit",
            { cause: error },
          ),
          { code: "command_invalid_output" },
        );
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  })();
}

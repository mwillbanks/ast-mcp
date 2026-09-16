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
    );
    const stderrPromise = readSubprocessOutput(
      child.stderr,
      controller.signal,
      stop,
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
        throw new Error(`${command} timed out after ${timeoutMs}ms`);
      }
      const [exitCode, stdout, stderr] = completed;
      if (exitCode !== 0) {
        const detail = (stderr || stdout || `exit code ${exitCode}`).trim();
        throw new Error(`${command} failed: ${detail}`);
      }
      return { stderr, stdout };
    } catch (error) {
      await terminateProcessTree(child, { force: true });
      controller.abort();
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  })();
}

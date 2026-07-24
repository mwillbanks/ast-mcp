import { execFile } from "node:child_process";
export function runCommandInput(
  command: string,
  args: string[],
  input: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || error.message).trim();
          reject(
            new Error(
              error.killed
                ? `${command} timed out after ${timeoutMs}ms${detail ? `: ${detail}` : ""}`
                : `${command} failed: ${detail}`,
              { cause: error },
            ),
          );
        } else resolve({ stderr, stdout });
      },
    );
    child.stdin?.end(input);
  });
}

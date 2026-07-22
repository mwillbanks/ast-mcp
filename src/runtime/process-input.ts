import { execFile } from "node:child_process";
export function runCommandInput(
  command: string,
  args: string[],
  input: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `${command} failed: ${(stderr || stdout || error.message).trim()}`,
              { cause: error },
            ),
          );
        else resolve({ stderr, stdout });
      },
    );
    child.stdin?.end(input);
  });
}

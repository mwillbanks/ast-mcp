import path from "node:path";

const binary = path.resolve(import.meta.dir, "../../node_modules/.bin/ast-bro");
type AstBroMapPayload = {
  files?: Array<{ error_count?: number; path?: unknown }>;
};

export async function astCapable(
  filePath: string,
  language?: string,
): Promise<boolean> {
  if (!language) return false;
  const processHandle = Bun.spawn([binary, "map", "--json", filePath], {
    cwd: path.dirname(filePath),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  const failure = stderr.trim() || `ast-bro map exited ${exitCode}`;
  if (exitCode !== 0) throw new Error(failure);
  const payload = JSON.parse(stdout) as AstBroMapPayload;
  const file = (payload.files ?? []).find(
    (candidate) => candidate.path === filePath,
  );
  return file?.error_count === 0;
}

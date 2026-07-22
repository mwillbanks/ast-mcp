import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function configuredRoots(): string[] {
  return (
    process.env.AST_MCP_ROOTS?.split(path.delimiter).filter(Boolean) ?? [
      process.cwd(),
    ]
  ).map((item) => path.resolve(item));
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function allowedRoots(): Promise<string[]> {
  const cwd = await realpath(process.cwd()).catch(() => process.cwd());
  const roots = await Promise.all(
    configuredRoots().map(async (root) => realpath(root).catch(() => root)),
  );
  if (
    process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS !== "1" &&
    roots.some((root) => !within(cwd, root))
  )
    throw new Error(
      "AST_MCP_ROOTS contains a root outside the server working directory; set AST_MCP_ALLOW_EXTERNAL_ROOTS=1 to opt in",
    );
  return roots;
}

export async function primaryRoot(): Promise<string> {
  return (await allowedRoots())[0] as string;
}

export async function rootForPath(filePath: string): Promise<string> {
  const root = (await allowedRoots()).find((candidate) =>
    within(candidate, filePath),
  );
  if (!root) throw new Error(`Path is outside AST_MCP_ROOTS: ${filePath}`);
  return root;
}
export async function resolveWritablePath(filePath: string): Promise<string> {
  const roots = await allowedRoots();
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(roots[0] as string, filePath);
  let existing = path.dirname(absolute);
  const missing: string[] = [];
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const resolved = path.join(existing, ...missing, path.basename(absolute));
  if (!roots.some((root) => within(root, resolved)))
    throw new Error(`Path is outside AST_MCP_ROOTS: ${filePath}`);
  if ((await lstat(resolved).catch(() => undefined))?.isSymbolicLink())
    throw new Error(`Symbolic-link targets are not writable: ${filePath}`);
  return resolved;
}
export function rootsForDisplay(): string[] {
  return configuredRoots();
}

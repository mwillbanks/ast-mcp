import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { currentConfig } from "../config";

async function configuredRoots(): Promise<string[]> {
  return (await currentConfig()).workspace.roots;
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function allowedRoots(): Promise<string[]> {
  const config = await currentConfig();
  const roots = await Promise.all(
    (await configuredRoots()).map(async (root) =>
      realpath(root).catch(() => root),
    ),
  );
  const trustedRoots = await Promise.all(
    config.trustedRoots.map(async (root) => realpath(root).catch(() => root)),
  );
  if (
    !config.safety.allowExternalRoots &&
    roots.some(
      (root) => !trustedRoots.some((trustedRoot) => within(trustedRoot, root)),
    )
  )
    throw new Error(
      "Configured workspace roots contain a root outside the trusted project boundary; set safety.allow_external_roots=true or AST_MCP_ALLOW_EXTERNAL_ROOTS=1 to opt in",
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
  const config = await currentConfig();
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
    throw new Error(
      `Path is outside AST_MCP_ROOTS/configured workspace roots: ${filePath}`,
    );
  const metadata = await lstat(resolved).catch(() => undefined);
  if (!metadata?.isSymbolicLink()) return resolved;
  if (!config.safety.followSymlinks)
    throw new Error(`Symbolic-link targets are not permitted: ${filePath}`);
  const target = await realpath(resolved);
  if (!roots.some((root) => within(root, target)))
    throw new Error(
      `Symbolic-link target is outside configured workspace roots: ${filePath}`,
    );
  return target;
}
export async function rootsForDisplay(): Promise<string[]> {
  return configuredRoots();
}

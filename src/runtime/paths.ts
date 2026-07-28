import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
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

async function workspaceRoots(): Promise<string[]> {
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

async function fileOperationRoots(): Promise<string[]> {
  const roots = await workspaceRoots();
  if (!(await currentConfig()).safety.allowTempDirectory) return roots;
  const temporaryRoot = await realpath(os.tmpdir()).catch(() => os.tmpdir());
  return roots.includes(temporaryRoot) ? roots : [...roots, temporaryRoot];
}

export async function primaryRoot(): Promise<string> {
  return (await workspaceRoots())[0] as string;
}

export async function configuredRootForPath(
  filePath: string,
): Promise<string | undefined> {
  return (await fileOperationRoots()).find((candidate) =>
    within(candidate, filePath),
  );
}

export async function rootForPath(filePath: string): Promise<string> {
  const root = await configuredRootForPath(filePath);
  if (root) return root;
  if ((await currentConfig()).safety.allowAnyPath)
    return path.dirname(filePath);
  throw new Error(
    `Path is outside configured file-operation roots: ${filePath}`,
  );
}

export async function pathsShareRoot(
  first: string,
  second: string,
): Promise<boolean> {
  if ((await currentConfig()).safety.allowAnyPath) return true;
  return (await rootForPath(first)) === (await rootForPath(second));
}
async function canonicalCandidate(filePath: string, root: string) {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(root, filePath);
  let existing = path.dirname(absolute);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(
        await realpath(existing),
        ...missing,
        path.basename(absolute),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function assertWithinBoundary(
  target: string,
  roots: string[],
  allowAnyPath: boolean,
  message: string,
) {
  if (!allowAnyPath && !roots.some((root) => within(root, target)))
    throw new Error(message);
}

async function resolvePath(
  filePath: string,
  roots: string[],
  allowAnyPath: boolean,
  boundary: string,
): Promise<string> {
  const resolved = await canonicalCandidate(filePath, roots[0] as string);
  assertWithinBoundary(
    resolved,
    roots,
    allowAnyPath,
    `Path is outside ${boundary}: ${filePath}`,
  );
  const metadata = await lstat(resolved).catch(() => undefined);
  if (!metadata?.isSymbolicLink()) return resolved;
  if (!(await currentConfig()).safety.followSymlinks)
    throw new Error(`Symbolic-link targets are not permitted: ${filePath}`);
  const target = await realpath(resolved);
  assertWithinBoundary(
    target,
    roots,
    allowAnyPath,
    `Symbolic-link target is outside ${boundary}: ${filePath}`,
  );
  return target;
}

export async function resolveWritablePath(filePath: string): Promise<string> {
  const config = await currentConfig();
  return resolvePath(
    filePath,
    await fileOperationRoots(),
    config.safety.allowAnyPath,
    "configured file-operation roots; use the OS temporary directory, configure workspace.roots, or explicitly set safety.allow_any_path=true",
  );
}

export async function resolveWorkspacePath(filePath: string): Promise<string> {
  return resolvePath(filePath, await workspaceRoots(), false, "AST_MCP_ROOTS");
}
export async function rootsForDisplay(): Promise<string[]> {
  return configuredRoots();
}

import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

export function pathWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function canonicalizePathSync(targetPath: string): string {
  let existing = path.resolve(targetPath);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(realpathSync(existing), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return path.join(existing, ...missing);
      }
      const parent = path.dirname(existing);
      if (parent === existing) return path.join(existing, ...missing);
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export function containingRoot(
  roots: string[],
  target: string,
): string | undefined {
  const canonicalTarget = canonicalizePathSync(target);
  return roots
    .map((root) => ({
      canonical: canonicalizePathSync(root),
      root,
    }))
    .filter(({ canonical }) => pathWithin(canonical, canonicalTarget))
    .sort((left, right) => right.canonical.length - left.canonical.length)[0]
    ?.canonical;
}

export function relativeRootFromPwd(roots: string[]): string | undefined {
  const pwd = process.env.PWD;
  if (!pwd) return undefined;
  const resolved = path.resolve(pwd);
  return (
    containingRoot(roots, resolved) ??
    roots
      .filter((root) => pathWithin(resolved, root))
      .sort((left, right) => right.length - left.length)[0]
  );
}

export function effectiveWorkspaceRoot(
  projectRoot: string,
  roots: string[],
): string {
  const project = path.resolve(projectRoot);
  const resolved = roots.map((root) => path.resolve(root));
  return (
    resolved.find((root) => pathWithin(project, root)) ??
    resolved.find((root) => pathWithin(root, project)) ??
    resolved[0] ??
    project
  );
}

export async function canonicalizePath(targetPath: string): Promise<string> {
  let existing = path.resolve(targetPath);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(existing), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

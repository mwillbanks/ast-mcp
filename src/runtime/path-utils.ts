import { realpath } from "node:fs/promises";
import path from "node:path";

export function pathWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
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

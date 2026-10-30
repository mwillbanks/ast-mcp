import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export type DirectoryIdentity = { real: string; ino: number; dev: number };
type AncestryPaths = Pick<typeof path, "resolve" | "dirname" | "relative">;
type AncestryOptions = {
  paths?: AncestryPaths;
  inspect?: (directory: string) => DirectoryIdentity;
};

function inspectDirectory(directory: string): DirectoryIdentity {
  const info = lstatSync(directory);
  if (!info.isDirectory())
    throw new Error("Created-directory boundary must be a directory");
  return { real: realpathSync(directory), ino: info.ino, dev: info.dev };
}

function sameDirectory(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
  paths: AncestryPaths,
) {
  if (left.dev !== right.dev) return false;
  // Some filesystems omit inode identifiers. Canonical location is the conservative fallback.
  if (left.ino !== 0 && right.ino !== 0) return left.ino === right.ino;
  return paths.relative(left.real, right.real) === "";
}

/** Return cleanup ownership only after proving the first directory created by recursive mkdir. */
export function createdDirectoryAncestors(
  directory: string,
  first: string,
  options: AncestryOptions = {},
): Map<string, DirectoryIdentity> {
  const paths = options.paths ?? path;
  const inspect = options.inspect ?? inspectDirectory;
  const boundary = inspect(paths.resolve(first));
  const candidates = new Map<string, DirectoryIdentity>();
  let current = paths.resolve(directory);
  // dirname must progress toward a root. The length bound also protects injected path adapters.
  for (let remaining = current.length + 1; remaining > 0; remaining -= 1) {
    const parent = paths.dirname(current);
    if (parent === current || candidates.has(current)) break;
    const identity = inspect(current);
    candidates.set(current, identity);
    if (sameDirectory(identity, boundary, paths)) return candidates;
    current = parent;
  }
  throw Object.assign(
    new Error(
      "Cannot verify created-directory ancestry; refusing cleanup ownership",
    ),
    { code: "configuration_conflict", retryable: true },
  );
}

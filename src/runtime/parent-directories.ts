import { lstat, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";

import { resolveWritablePath } from "./paths";

type DirectoryIdentity = { dev: number; ino: number };
const ownership = new WeakMap<
  readonly string[],
  Map<string, DirectoryIdentity>
>();

export async function revalidateWritePath(filePath: string): Promise<void> {
  if ((await resolveWritablePath(filePath)) !== filePath)
    throw Object.assign(
      new Error("Parent directory changed the resolved write path"),
      {
        code: "mutation_path_changed",
        retryable: true,
      },
    );
}

/** The caller owns the ledger even when creation or later validation fails. */
export async function ensureParentDirectories(
  filePath: string,
  created: string[],
  beforeSideEffect?: () => Promise<void>,
): Promise<void> {
  let identities = ownership.get(created);
  if (!identities) {
    identities = new Map();
    ownership.set(created, identities);
  }
  const missing: string[] = [];
  let directory = path.dirname(filePath);
  for (;;) {
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory())
        throw Object.assign(
          new Error("Destination parent is not a directory"),
          {
            code: "ENOTDIR",
          },
        );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(directory);
      const parent = path.dirname(directory);
      if (parent === directory) throw error;
      directory = parent;
    }
  }
  for (const candidate of missing.reverse()) {
    await beforeSideEffect?.();
    await revalidateWritePath(filePath);
    await revalidateWritePath(candidate);
    try {
      await mkdir(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const metadata = await lstat(candidate);
      if (!metadata.isDirectory()) throw error;
      await revalidateWritePath(filePath);
      continue;
    }
    // Capture ownership before any policy, cancellation, or physical-path recheck.
    created.push(candidate);
    const metadata = await lstat(candidate);
    identities.set(candidate, { dev: metadata.dev, ino: metadata.ino });
    await revalidateWritePath(filePath);
    await revalidateWritePath(candidate);
  }
  await revalidateWritePath(filePath);
}

export async function removeCreatedDirectories(
  directories: readonly string[],
): Promise<void> {
  const identities = ownership.get(directories);
  if (!identities) return;
  const errors: unknown[] = [];
  for (const directory of [...directories].reverse()) {
    const identity = identities.get(directory);
    if (!identity) continue;
    try {
      const metadata = await lstat(directory);
      if (
        !metadata.isDirectory() ||
        metadata.dev !== identity.dev ||
        metadata.ino !== identity.ino
      )
        continue;
      await revalidateWritePath(directory);
      await rmdir(directory);
      identities.delete(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST")
        errors.push(error);
    }
  }
  if (errors.length)
    throw Object.assign(
      new AggregateError(
        errors,
        "Created parent directory cleanup was incomplete",
      ),
      {
        details: { affectedPaths: [...directories] },
      },
    );
}

import { lstatSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { acquireTransactionLockSync } from "../runtime/transaction-lock";

export function canonicalConfigPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      lstatSync(filePath);
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code === "ENOENT")
        return path.join(
          realpathSync(path.dirname(filePath)),
          path.basename(filePath),
        );
      throw missing;
    }
    throw error;
  }
}

export async function configWriteTarget(
  filePath: string,
  allowMissing = false,
) {
  try {
    const target = canonicalConfigPath(filePath);
    const metadata = await stat(target);
    if (!metadata.isFile())
      throw new Error("Configuration must be a regular file");
    return { target, mode: metadata.mode };
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
    return { target: canonicalConfigPath(filePath), mode: 0o600 };
  }
}

export function assertConfigWriteTarget(
  filePath: string,
  expected: string,
): void {
  if (canonicalConfigPath(filePath) !== expected)
    throw Object.assign(
      new Error("Configuration target changed before commit; reload and retry"),
      {
        code: "configuration_conflict",
        retryable: true,
      },
    );
}

/** Serialize synchronous commits across account namespaces; process exit releases both guards. */
export function withConfigTransaction<T>(filePath: string, commit: () => T): T {
  const target = canonicalConfigPath(filePath);
  let guard: ReturnType<typeof acquireTransactionLockSync>;
  try {
    guard = acquireTransactionLockSync(target + ".config-commit", {
      sharedDatabasePath: target + ".config-commit.sqlite",
    });
  } catch (cause) {
    if ((cause as { code?: string }).code === "lock_busy")
      throw Object.assign(
        new Error("Another configuration commit is in progress; retry", {
          cause,
        }),
        { code: "configuration_busy", retryable: true },
      );
    throw cause;
  }
  try {
    guard.fence();
    return commit();
  } finally {
    guard.release();
  }
}

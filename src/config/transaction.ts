import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";

import { privateLockDatabasePathSync } from "../runtime/private-lock-directory";

/** Serialize only synchronous configuration commits; SQLite releases ownership after crashes. */
export function withConfigTransaction<T>(filePath: string, commit: () => T): T {
  const lockPath = privateLockDatabasePathSync(`${filePath}.config-commit`);
  const database = new Database(lockPath, { create: true });
  try {
    chmodSync(lockPath, 0o600);
    database.exec("PRAGMA busy_timeout = 0");
    try {
      database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_BUSY")
        throw Object.assign(
          new Error("Another configuration commit is in progress; retry", {
            cause: error,
          }),
          {
            code: "configuration_busy",
            retryable: true,
          },
        );
      throw error;
    }
    try {
      return commit();
    } finally {
      database.exec("ROLLBACK");
    }
  } finally {
    database.close();
  }
}

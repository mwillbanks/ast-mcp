import { Database } from "bun:sqlite";

import { privateLockDatabasePath } from "./private-lock-directory.ts";

export interface TransactionLockOptions {
  deadline?: Date | number;
  pollMs?: number;
  signal?: AbortSignal;
  tryOnly?: boolean;
}
export interface TransactionLock {
  fence(): void;
  release(): void;
}
function waiting(options: TransactionLockOptions, deadline: number): void {
  if (options.signal?.aborted)
    throw Object.assign(
      new Error("Transaction lock acquisition was cancelled"),
      { code: "lock_aborted", retryable: false },
    );
  if (Date.now() >= deadline)
    throw Object.assign(new Error("Transaction lock deadline expired"), {
      code: "lock_deadline",
      retryable: true,
    });
}
function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () =>
      finish(
        Object.assign(new Error("Transaction lock acquisition was cancelled"), {
          code: "lock_aborted",
          retryable: false,
        }),
      );
    const timer = setTimeout(() => finish(), milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Hold an OS-backed SQLite write transaction until explicit release or process exit. */
export async function acquireTransactionLock(
  lockIdentity: string,
  options: TransactionLockOptions = {},
): Promise<TransactionLock> {
  const deadline =
    options.deadline instanceof Date
      ? options.deadline.getTime()
      : (options.deadline ?? Date.now() + 10_000);
  waiting(options, deadline);
  const databasePath = await privateLockDatabasePath(lockIdentity);
  while (true) {
    waiting(options, deadline);
    let database: Database | undefined;
    try {
      database = new Database(databasePath, { create: true });
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN IMMEDIATE");
      const owned = database;
      let released = false;
      return {
        fence() {
          if (released || !owned.inTransaction)
            throw Object.assign(
              new Error("Transaction lock ownership was lost"),
              { code: "lock_fenced", retryable: false },
            );
        },
        release() {
          if (released) return;
          released = true;
          try {
            owned.exec("ROLLBACK");
          } finally {
            owned.close();
          }
        },
      };
    } catch (error) {
      database?.close();
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        !["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String(error.code))
      )
        throw error;
      if (options.tryOnly)
        throw Object.assign(new Error("Transaction lock is already held"), {
          code: "lock_busy",
          retryable: true,
        });
      await delay(
        Math.min(
          Math.max(1, options.pollMs ?? 10),
          Math.max(1, deadline - Date.now()),
        ),
        options.signal,
      );
    }
  }
}

import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";

import {
  privateLockDatabasePath,
  privateLockDatabasePathSync,
} from "./private-lock-directory.ts";

export interface TransactionLockOptions {
  deadline?: Date | number;
  pollMs?: number;
  signal?: AbortSignal;
  tryOnly?: boolean;
  /** An additional guard in a caller-authorized resource directory. */
  sharedDatabasePath?: string;
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

function databaseUnsafe(cause?: unknown): Error {
  return Object.assign(
    new Error(
      "The transaction guard must remain a private regular file with one link",
      { cause },
    ),
    { code: "lock_database_unsafe", retryable: false },
  );
}
function safeDatabase(metadata: BigIntStats, shared: boolean): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    (shared &&
      process.platform !== "win32" &&
      (metadata.mode & 0o777n) !== 0o600n)
  )
    throw databaseUnsafe();
}
interface DescriptorEntry {
  descriptor: number;
  references: number;
  dev: bigint;
  ino: bigint;
  deferred: Set<number>;
}
const descriptors = new Map<string, DescriptorEntry>();
const quarantinedDescriptors = new Set<number>();
function closeQuarantinedDescriptors(): void {
  if (descriptors.size !== 0) return;
  for (const descriptor of quarantinedDescriptors) closeSync(descriptor);
  quarantinedDescriptors.clear();
}
function retireDescriptor(descriptor: number, metadata?: BigIntStats): void {
  const owner = metadata && descriptors.get(metadata.dev + ":" + metadata.ino);
  if (owner) owner.deferred.add(descriptor);
  else if (metadata) closeSync(descriptor);
  else quarantinedDescriptors.add(descriptor);
  closeQuarantinedDescriptors();
}
function openDatabaseGuard(
  databasePath: string,
  shared: boolean,
): { fence(): void; release(): void } {
  let descriptor: number | undefined;
  let openedMetadata: BigIntStats | undefined;
  let retained: DescriptorEntry | undefined;
  let identityKey: string | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (retained && --retained.references === 0) {
      descriptors.delete(identityKey!);
      closeSync(retained.descriptor);
      for (const extra of retained.deferred) closeSync(extra);
    }
    closeQuarantinedDescriptors();
  };
  try {
    // A descriptor whose inode cannot be determined must not close another owner's fcntl locks.
    // Bound that exceptional quarantine; successful owners can still release and drain it.
    if (quarantinedDescriptors.size >= 64)
      throw databaseUnsafe(new Error("Guard descriptor quarantine is full"));
    if (shared) {
      try {
        descriptor = openSync(
          databasePath,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
          0o600,
        );
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
    }
    const before = lstatSync(databasePath, { bigint: true });
    safeDatabase(before, shared);
    identityKey = before.dev + ":" + before.ino;
    retained = descriptors.get(identityKey);
    if (retained) {
      retained.references++;
      if (descriptor !== undefined) retained.deferred.add(descriptor);
    } else {
      descriptor ??= openSync(
        databasePath,
        constants.O_RDWR |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      openedMetadata = fstatSync(descriptor, { bigint: true });
      safeDatabase(openedMetadata, shared);
      if (
        openedMetadata.dev !== before.dev ||
        openedMetadata.ino !== before.ino
      )
        throw databaseUnsafe();
      retained = {
        descriptor,
        references: 1,
        dev: openedMetadata.dev,
        ino: openedMetadata.ino,
        deferred: new Set(),
      };
      descriptors.set(identityKey, retained);
    }
    descriptor = undefined;
    const entry = retained;
    const fence = () => {
      try {
        const current = lstatSync(databasePath, { bigint: true });
        safeDatabase(current, shared);
        safeDatabase(fstatSync(entry.descriptor, { bigint: true }), shared);
        if (current.dev !== entry.dev || current.ino !== entry.ino)
          throw databaseUnsafe();
      } catch (cause) {
        throw databaseUnsafe(cause);
      }
    };
    fence();
    return { fence, release };
  } catch (cause) {
    if (descriptor !== undefined) {
      try {
        openedMetadata ??= fstatSync(descriptor, { bigint: true });
      } catch {
        /* Quarantine until live guards release. */
      }
      retireDescriptor(descriptor, openedMetadata);
    }
    release();
    throw databaseUnsafe(cause);
  }
}
function acquireDatabaseNow(
  databasePath: string,
  shared: boolean,
): TransactionLock {
  const guard = openDatabaseGuard(databasePath, shared);
  let database: Database | undefined;
  try {
    guard.fence();
    database = new Database(databasePath, { create: false, readwrite: true });
    guard.fence();
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN IMMEDIATE");
    guard.fence();
    const owned = database;
    let released = false;
    return {
      fence() {
        if (released || !owned.inTransaction)
          throw Object.assign(
            new Error("Transaction lock ownership was lost"),
            { code: "lock_fenced", retryable: false },
          );
        guard.fence();
      },
      release() {
        if (released) return;
        released = true;
        try {
          owned.exec("ROLLBACK");
        } finally {
          try {
            owned.close();
          } finally {
            guard.release();
          }
        }
      },
    };
  } catch (cause) {
    try {
      database?.close();
    } finally {
      guard.release();
    }
    throw cause;
  }
}
function busy(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String(error.code)),
  );
}
function busyError(): Error {
  return Object.assign(new Error("Transaction lock is already held"), {
    code: "lock_busy",
    retryable: true,
  });
}
function combine(
  privateGuard: TransactionLock,
  sharedGuard: TransactionLock,
): TransactionLock {
  let released = false;
  return {
    fence() {
      privateGuard.fence();
      sharedGuard.fence();
    },
    release() {
      if (released) return;
      released = true;
      try {
        sharedGuard.release();
      } finally {
        privateGuard.release();
      }
    },
  };
}
function lockDeadline(options: TransactionLockOptions): number {
  if (
    options.sharedDatabasePath &&
    !path.isAbsolute(options.sharedDatabasePath)
  )
    throw databaseUnsafe(new Error("Shared guard paths must be absolute"));
  return options.deadline instanceof Date
    ? options.deadline.getTime()
    : (options.deadline ?? Date.now() + 10_000);
}
async function acquireDatabaseLock(
  databasePath: string,
  options: TransactionLockOptions,
  deadline: number,
  shared: boolean,
): Promise<TransactionLock> {
  while (true) {
    waiting(options, deadline);
    try {
      return acquireDatabaseNow(databasePath, shared);
    } catch (error) {
      if (!busy(error)) throw error;
      if (options.tryOnly) throw busyError();
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

/** Hold private and optional shared OS transactions until explicit release or process exit. */
export async function acquireTransactionLock(
  lockIdentity: string,
  options: TransactionLockOptions = {},
): Promise<TransactionLock> {
  const deadline = lockDeadline(options);
  waiting(options, deadline);
  const databasePath = await privateLockDatabasePath(lockIdentity);
  const privateGuard = await acquireDatabaseLock(
    databasePath,
    options,
    deadline,
    false,
  );
  if (!options.sharedDatabasePath) return privateGuard;
  try {
    const sharedGuard = await acquireDatabaseLock(
      options.sharedDatabasePath,
      options,
      deadline,
      true,
    );
    return combine(privateGuard, sharedGuard);
  } catch (cause) {
    privateGuard.release();
    throw cause;
  }
}

/** Acquire synchronously without waiting, using the same descriptor and transaction ownership as async callers. */
export function acquireTransactionLockSync(
  lockIdentity: string,
  options: TransactionLockOptions = {},
): TransactionLock {
  const deadline = lockDeadline(options);
  waiting(options, deadline);
  let privateGuard: TransactionLock | undefined;
  try {
    privateGuard = acquireDatabaseNow(
      privateLockDatabasePathSync(lockIdentity),
      false,
    );
    waiting(options, deadline);
    if (!options.sharedDatabasePath) return privateGuard;
    return combine(
      privateGuard,
      acquireDatabaseNow(options.sharedDatabasePath, true),
    );
  } catch (cause) {
    privateGuard?.release();
    if (busy(cause)) throw busyError();
    throw cause;
  }
}

/** Reserved coordination files must not enter project indexing or dirty-worktree fingerprints. */
export function isTransactionLockArtifact(filePath: string): boolean {
  const normalized =
    process.platform === "win32" || process.platform === "darwin"
      ? filePath.toLowerCase()
      : filePath;
  if (
    /(?:^|[\\/])(?:\.ast-mcp-mutation-locks|\.ast-mcp-locks|ast-mcp-locks)(?:[\\/]|$)/.test(
      normalized,
    )
  )
    return true;
  const basename = path.basename(normalized);
  if (
    /^\..+\.ast-mcp\.lock(?:\.(?:pending|stale)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(
      basename,
    )
  )
    return true;
  return /(?:\.ast-mcp\.lock\.sqlite|\.ast-mcp-checkout\.lock\.sqlite|\.ast-mcp-storage-writer\.sqlite|\.ast-mcp-export\.lock\.sqlite|\.config-commit\.sqlite)(?:-journal|-wal|-shm)?$/.test(
    basename,
  );
}

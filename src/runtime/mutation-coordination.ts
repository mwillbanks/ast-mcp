import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statfsSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  macPathHasNoAcl,
  macVolumeEnforcesOwnership,
} from "./mac-file-access.ts";
import { systemAccount } from "./private-lock-directory.ts";
import { assertTransactionLockBudget } from "./transaction-lock.ts";

interface CoordinationOptions {
  deadline?: Date | number;
  pollMs?: number;
  signal?: AbortSignal;
  tryOnly?: boolean;
}

export interface MutationCoordinationLease {
  token: string;
  fence(): Promise<void>;
  release(): Promise<void>;
}

interface Owner {
  pid: number;
  token: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isBusy(error: unknown): boolean {
  return /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/u.test(
    String((error as { code?: unknown })?.code ?? ""),
  );
}

// Network and unknown filesystems must use the shared on-volume guard. The
// temporary coordinator cannot arbitrate concurrent access from two machines.
const localFilesystems = new Set([
  0xef53, // ext
  0x58465342, // XFS
  0x9123683e, // Btrfs
  0x01021994, // tmpfs
]);

/** Choose the account-private coordinator only for a locally owned scope. */
export function canUseTemporaryMutationCoordination(
  canonical: string,
): boolean {
  if (process.platform !== "darwin" && process.platform !== "linux")
    return false;
  const uid = process.geteuid!();
  let candidate = canonical;
  let nearest: string | undefined;
  let childOwned = false;
  while (true) {
    const parent = path.dirname(candidate);
    let info;
    try {
      info = lstatSync(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (parent === candidate) return false;
      candidate = parent;
      continue;
    }
    if (!nearest) {
      if (info.uid !== uid) return false;
      nearest = candidate;
    }
    if (info.isSymbolicLink() || (info.uid !== uid && info.uid !== 0))
      return false;
    const stickyParent =
      info.isDirectory() && childOwned && (info.mode & 0o1000) !== 0;
    if ((info.mode & 0o022) !== 0 && !stickyParent) return false;
    if (process.platform === "darwin" && !macPathHasNoAcl(candidate))
      return false;
    if (parent === candidate) break;
    childOwned = info.uid === uid;
    candidate = parent;
  }
  const type = statfsSync(nearest).type;
  return process.platform === "darwin"
    ? type === 26 && macVolumeEnforcesOwnership(nearest)
    : localFilesystems.has(type >>> 0);
}

function coordinationError(code: string, message: string, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function unsafe(): Error {
  return coordinationError(
    "lock_database_unsafe",
    "Temporary mutation coordination storage is not private",
  );
}

async function privateTempDirectory(root: string): Promise<string> {
  const account = await systemAccount();
  const temp = realpathSync.native(root);
  const metadata = lstatSync(temp);
  if (
    !metadata.isDirectory() ||
    (metadata.uid !== 0 && metadata.uid !== account.uid) ||
    ((metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0) ||
    (process.platform === "darwin" &&
      (!macPathHasNoAcl(temp) || !macVolumeEnforcesOwnership(temp)))
  )
    throw unsafe();
  const directory = path.join(temp, `ast-mcp-coordination-${account.uid}`);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const privateMetadata = lstatSync(directory);
  if (
    !privateMetadata.isDirectory() ||
    privateMetadata.uid !== account.uid ||
    (privateMetadata.mode & 0o777) !== 0o700 ||
    (process.platform === "darwin" && !macPathHasNoAcl(directory))
  )
    throw unsafe();
  return directory;
}

function validateFile(
  filePath: string,
  optional = false,
): BigIntStats | undefined {
  try {
    const metadata = lstatSync(filePath, { bigint: true });
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1n ||
      metadata.uid !== BigInt(process.geteuid!()) ||
      (metadata.mode & 0o777n) !== 0o600n ||
      (process.platform === "darwin" && !macPathHasNoAcl(filePath))
    )
      throw unsafe();
    return metadata;
  } catch (error) {
    if (optional && isMissing(error)) return;
    throw error;
  }
}

function processExited(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw coordinationError(
      "lock_record_invalid",
      "Invalid writer process identity",
    );
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // Treat a live, reused, or inaccessible PID as owned, never as abandoned.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

class CoordinationStore {
  readonly #db: Database;
  readonly #identity: BigIntStats;
  readonly #directoryIdentity: BigIntStats;
  readonly #first;
  readonly #enqueue;
  readonly #dequeue;
  readonly #enter;
  readonly #owner;
  readonly #remove;
  readonly #claim;

  constructor(readonly filePath: string) {
    this.#directoryIdentity = lstatSync(path.dirname(filePath), {
      bigint: true,
    });
    this.#identity = validateFile(filePath)!;
    validateFile(filePath + "-wal", true);
    validateFile(filePath + "-shm", true);
    this.#db = new Database(filePath, { create: false, strict: true });
    try {
      this.#db.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 0");
      const mode = this.#db
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL")
        .get();
      if (mode?.journal_mode !== "wal")
        throw coordinationError(
          "lock_database_unavailable",
          "Cannot enable mutation WAL",
        );
      this.#db.exec("PRAGMA synchronous = NORMAL");
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS mutation_owners_v1 (
          resource TEXT PRIMARY KEY NOT NULL,
          pid INTEGER NOT NULL,
          token TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS mutation_waiters_v1 (
          sequence INTEGER PRIMARY KEY,
          resource TEXT NOT NULL,
          pid INTEGER NOT NULL,
          token TEXT UNIQUE NOT NULL,
          deadline INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mutation_waiters_resource_v1
          ON mutation_waiters_v1 (resource, sequence);
      `);
      this.#owner = this.#db.query<Owner, [string]>(
        "SELECT pid, token FROM mutation_owners_v1 WHERE resource = ?",
      );
      this.#remove = this.#db.query<never, [string, string]>(
        "DELETE FROM mutation_owners_v1 WHERE resource = ? AND token = ?",
      );
      const insert = this.#db.query<never, [string, number, string]>(
        "INSERT INTO mutation_owners_v1(resource, pid, token) VALUES (?, ?, ?)",
      );
      this.#first = this.#db.query<Owner & { deadline: number }, [string]>(
        "SELECT pid, token, deadline FROM mutation_waiters_v1 WHERE resource = ? ORDER BY sequence LIMIT 1",
      );
      const count = this.#db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM mutation_waiters_v1 WHERE resource = ?",
      );
      const enqueue = this.#db.query<never, [string, number, string, number]>(
        "INSERT INTO mutation_waiters_v1 (resource, pid, token, deadline) VALUES (?, ?, ?, ?)",
      );
      this.#dequeue = this.#db.query<never, [string]>(
        "DELETE FROM mutation_waiters_v1 WHERE token = ?",
      );
      const clearExpired = this.#db.query<never, [string, number]>(
        "DELETE FROM mutation_waiters_v1 WHERE resource = ? AND deadline <= ?",
      );
      const waiters = this.#db.query<Owner, [string]>(
        "SELECT pid, token FROM mutation_waiters_v1 WHERE resource = ?",
      );
      this.#enqueue = this.#db.transaction(
        (resource: string, token: string, deadline: number) => {
          clearExpired.run(resource, Date.now());
          if (count.get(resource)!.count >= 256) {
            for (const waiter of waiters.all(resource)) {
              if (processExited(waiter.pid)) this.#dequeue.run(waiter.token);
            }
            if (count.get(resource)!.count >= 256) throw queueFull();
          }
          enqueue.run(resource, process.pid, token, deadline);
        },
      );
      const claim = (resource: string, token: string, queued: boolean) => {
        clearExpired.run(resource, Date.now());
        let first = this.#first.get(resource);
        while (first && processExited(first.pid)) {
          this.#dequeue.run(first.token);
          first = this.#first.get(resource);
        }
        if (queued ? first?.token !== token : first !== null) return false;
        const owner = this.#owner.get(resource);
        if (owner) {
          if (!processExited(owner.pid)) return false;
          this.#remove.run(resource, owner.token);
        }
        insert.run(resource, process.pid, token);
        if (queued) this.#dequeue.run(token);
        return true;
      };
      this.#claim = this.#db.transaction(claim);
      this.#enter = this.#db.transaction(
        (resource: string, token: string, deadline: number) => {
          if (claim(resource, token, false)) return true;
          this.#enqueue(resource, token, deadline);
          return false;
        },
      );
      this.verify();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  verify(): void {
    const directory = path.dirname(this.filePath);
    const dir = lstatSync(directory, { bigint: true });
    if (
      !dir.isDirectory() ||
      dir.dev !== this.#directoryIdentity.dev ||
      dir.ino !== this.#directoryIdentity.ino ||
      dir.uid !== BigInt(process.geteuid!()) ||
      (dir.mode & 0o777n) !== 0o700n ||
      (process.platform === "darwin" && !macPathHasNoAcl(directory))
    )
      throw unsafe();
    const current = validateFile(this.filePath);
    if (
      current?.dev !== this.#identity.dev ||
      current.ino !== this.#identity.ino
    )
      throw unsafe();
  }

  enter(
    resource: string,
    token: string,
    deadline: number,
    tryOnly: boolean,
  ): boolean {
    this.verify();
    if (tryOnly) return this.#claim.immediate(resource, token, false);
    return this.#enter.immediate(resource, token, deadline);
  }

  queuedClaim(resource: string, token: string): boolean {
    this.verify();
    // A read avoids grabbing the database writer lock for live owners.
    const current = this.#owner.get(resource);
    if (current && !processExited(current.pid)) return false;
    const first = this.#first.get(resource);
    if (
      first &&
      first.token !== token &&
      first.deadline > Date.now() &&
      !processExited(first.pid)
    )
      return false;
    return this.#claim.immediate(resource, token, true);
  }

  close(): void {
    this.#db.close();
  }

  fence(resource: string, token: string): void {
    this.verify();
    if (this.#owner.get(resource)?.token !== token)
      throw coordinationError("lock_fenced", "Mutation ownership was lost");
  }

  cancel(token: string): void {
    this.verify();
    this.#dequeue.run(token);
  }

  release(resource: string, token: string): void {
    this.verify();
    this.#remove.run(resource, token);
  }
}

function queueFull(): Error {
  return coordinationError(
    "lock_queue_full",
    "Mutation coordination queue is full",
    true,
  );
}

async function releaseAndRetry(operation: () => void): Promise<void> {
  const releaseDeadline = Date.now() + 5_000;
  while (true) {
    try {
      operation();
      return;
    } catch (error) {
      if (!isBusy(error) || Date.now() >= releaseDeadline) throw error;
      await delay(5);
    }
  }
}

export function createTemporaryMutationCoordinator(root: string) {
  const pending = new Map<string, number>();
  let coordinator: Promise<CoordinationStore> | undefined;

  function getCoordinator(): Promise<CoordinationStore> {
    coordinator ??= privateTempDirectory(root)
      .then((directory) => {
        const filePath = path.join(directory, "mutation-leases-v1.sqlite");
        try {
          closeSync(
            openSync(
              filePath,
              constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
              0o600,
            ),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        return new CoordinationStore(filePath);
      })
      .catch((error) => {
        coordinator = undefined;
        throw error;
      });
    return coordinator;
  }

  async function acquire(
    resource: string,
    options: CoordinationOptions = {},
  ): Promise<MutationCoordinationLease> {
    const deadline =
      options.deadline instanceof Date
        ? options.deadline.getTime()
        : (options.deadline ?? Date.now() + 10_000);
    const token = randomUUID();
    const pause = () =>
      delay(
        Math.max(1, Math.min(options.pollMs ?? 10, deadline - Date.now())),
        undefined,
        { signal: options.signal },
      ).catch(() => assertTransactionLockBudget(deadline, options.signal));
    const waiters = pending.get(resource) ?? 0;
    if (waiters >= 256) throw queueFull();
    pending.set(resource, waiters + 1);
    let store: CoordinationStore | undefined;
    let queued = false;
    try {
      while (true) {
        assertTransactionLockBudget(deadline, options.signal);
        try {
          store = await getCoordinator();
          assertTransactionLockBudget(deadline, options.signal);
          if (queued) {
            if (store.queuedClaim(resource, token)) break;
          } else {
            if (store.enter(resource, token, deadline, !!options.tryOnly))
              break;
            queued = !options.tryOnly;
          }
        } catch (error) {
          if (!isBusy(error)) throw error;
        }
        if (options.tryOnly)
          throw coordinationError(
            "lock_busy",
            "Mutation ownership is already held",
            true,
          );
        await pause();
      }
    } catch (error) {
      const abandoned = store;
      if (queued && abandoned)
        await releaseAndRetry(() => abandoned.cancel(token)).catch(() => {
          process.stderr.write("ast-mcp: mutation queue cleanup failed\n");
        });
      throw error;
    } finally {
      const remaining = (pending.get(resource) ?? 1) - 1;
      if (remaining) pending.set(resource, remaining);
      else pending.delete(resource);
    }
    const owned = store!;
    return {
      token,
      async fence() {
        owned.fence(resource, token);
      },
      release: () => releaseAndRetry(() => owned.release(resource, token)),
    };
  }

  return {
    acquire,
    /** Close an idle coordinator after its callers release all leases. */
    async close() {
      (await coordinator)?.close();
      coordinator = undefined;
    },
  };
}

export const { acquire: acquireMutationCoordination } =
  createTemporaryMutationCoordinator("/tmp");

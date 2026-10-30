import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { sha256 } from "../../runtime/hash.ts";
import {
  canonicalizePath,
  canonicalizePathSync,
} from "../../runtime/path-utils.ts";
import {
  ensurePrivateLockDirectory as ensureMutationLockDirectory,
  systemAccount,
} from "../../runtime/private-lock-directory.ts";
import { acquireTransactionLock } from "../../runtime/transaction-lock.ts";

export interface FileLockOptions {
  deadline?: Date | number;
  leaseMs?: number;
  now?: () => number;
  ownerId?: string;
  pollMs?: number;
  signal?: AbortSignal;
  sharedDatabasePath?: string;
}

export interface FileLockLease {
  epoch: number;
  expiresAt: number;
  fence(): Promise<void>;
  lockPath: string;
  ownerId: string;
  release(): Promise<void>;
  renew(): Promise<void>;
  token: string;
}

interface LockRecord {
  accountId?: string;
  protocol?: "account-sqlite-v1";
  createdAt: number;
  epoch: number;
  expiresAt: number;
  ownerId: string;
  pid: number;
  token: string;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_POLL_MS = 10;
const ORPHAN_ARTIFACT_GRACE_MS = 60_000;
const ORPHAN_CLEANUP_LIMIT = 32;
const queues = new Map<string, Promise<void>>();

function lockError(
  code: "lock_aborted" | "lock_deadline" | "lock_fenced",
  message: string,
  retryable: boolean,
): Error {
  return Object.assign(new Error(message), { code, retryable });
}

function exactRecord(value: unknown): LockRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    ...(record.protocol === "account-sqlite-v1" ? ["accountId"] : []),
    "createdAt",
    "epoch",
    "expiresAt",
    "ownerId",
    "pid",
    ...(record.protocol === "account-sqlite-v1" ? ["protocol"] : []),
    "token",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  )
    return null;
  if (
    !Number.isSafeInteger(record.createdAt) ||
    !Number.isSafeInteger(record.epoch) ||
    !Number.isSafeInteger(record.expiresAt) ||
    !Number.isSafeInteger(record.pid) ||
    typeof record.ownerId !== "string" ||
    typeof record.token !== "string" ||
    (record.protocol === "account-sqlite-v1" &&
      typeof record.accountId !== "string")
  )
    return null;
  return record as unknown as LockRecord;
}

function parseLockRecord(source: string): LockRecord | null {
  const lines = source.split("\n");
  let initial: LockRecord | null;
  try {
    initial = exactRecord(JSON.parse(lines[0] ?? ""));
  } catch {
    return null;
  }
  if (!initial) return null;
  let current = initial;
  // The final line is uncommitted unless its terminating newline was written.
  for (const line of lines.slice(1, -1)) {
    if (!line.trim()) continue;
    let frame: { record?: unknown; sha256?: unknown };
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (!frame || typeof frame !== "object") continue;
    const record = exactRecord(frame.record);
    if (!record || frame.sha256 !== sha256(JSON.stringify(record))) continue;
    if (
      record.accountId !== initial.accountId ||
      record.protocol !== initial.protocol ||
      record.createdAt !== initial.createdAt ||
      record.epoch !== initial.epoch ||
      record.ownerId !== initial.ownerId ||
      record.pid !== initial.pid ||
      record.token !== initial.token
    )
      return null;
    current = record;
  }
  return current;
}

async function readRecord(lock: string): Promise<LockRecord | null> {
  let source: string;
  try {
    source = await Bun.file(lock).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (source.length === 0)
    throw Object.assign(new Error("File lock record is initializing"), {
      code: "lock_record_initializing",
      retryable: true,
    });
  const record = parseLockRecord(source);
  if (!record)
    throw Object.assign(new Error("File lock record is malformed"), {
      code: "lock_record_malformed",
      retryable: false,
    });
  return record;
}

export async function mutationLockPath(filePath: string): Promise<string> {
  const canonical = await canonicalizePath(filePath);
  const targetDirectory = path.dirname(canonical);
  let directory = targetDirectory;
  while (true) {
    try {
      if (!(await lstat(directory)).isDirectory())
        throw new Error(`Lock parent is not a directory: ${directory}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(directory);
      if (parent === directory) throw error;
      directory = parent;
    }
  }
  const basename = path.basename(canonical);
  const name =
    directory === targetDirectory
      ? `${basename.startsWith(".") ? "" : "."}${basename}.ast-mcp.lock`
      : `.${sha256(canonical).slice(0, 24)}.ast-mcp.lock`;
  return path.join(directory, name);
}

interface CoordinationDiscovery {
  stats: Map<string, Promise<Awaited<ReturnType<typeof lstat>>>>;
  metadata: Map<string, Promise<string>>;
}

function coordinationDiscovery(): CoordinationDiscovery {
  return { stats: new Map(), metadata: new Map() };
}

function discoveryStat(discovery: CoordinationDiscovery, target: string) {
  let pending = discovery.stats.get(target);
  if (!pending) {
    pending = lstat(target);
    discovery.stats.set(target, pending);
  }
  return pending;
}

async function gitMetadataPointer(
  directory: string,
  marker: string,
): Promise<string> {
  const handle = await open(marker, "r");
  try {
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const match = bytes
      .subarray(0, bytesRead)
      .toString("utf8")
      .trim()
      .match(/^gitdir: (.+)$/);
    if (bytesRead > 4096 || !match)
      throw new Error("Invalid Git metadata pointer");
    const metadata = await canonicalizePath(path.resolve(directory, match[1]!));
    if (!(await lstat(metadata)).isDirectory())
      throw new Error("Git metadata is not a directory");
    return metadata;
  } catch (cause) {
    throw new Error("Git metadata pointer is unavailable or invalid", {
      cause,
    });
  } finally {
    await handle.close();
  }
}

export async function mutationSharedDatabasePath(
  filePath: string,
): Promise<string> {
  return discoverSharedDatabasePath(filePath, coordinationDiscovery());
}

async function discoverSharedDatabasePath(
  filePath: string,
  discovery: CoordinationDiscovery,
): Promise<string> {
  const canonical = await canonicalizePath(filePath);
  let directory = path.dirname(canonical);
  try {
    if ((await discoveryStat(discovery, canonical)).isDirectory())
      directory = canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let fallback: string | undefined;
  let configured: string | undefined;
  let metadata: string | undefined;
  for (let depth = 0; depth < 256; depth++) {
    try {
      if ((await discoveryStat(discovery, directory)).isDirectory())
        fallback ??= directory;
      const marker = path.join(directory, ".git");
      let git;
      try {
        git = await discoveryStat(discovery, marker);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (git) {
        if (git.isDirectory()) metadata = marker;
        else if (git.isFile() && git.size <= 4096) {
          let pending = discovery.metadata.get(marker);
          if (!pending) {
            pending = gitMetadataPointer(directory, marker);
            discovery.metadata.set(marker, pending);
          }
          metadata = await pending;
        } else throw new Error("Unsafe Git metadata marker");
        break;
      }
      if (!configured) {
        try {
          const config = await discoveryStat(
            discovery,
            path.join(directory, "ast-mcp.toml"),
          );
          if (config.isFile()) configured = directory;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    if (depth === 255) throw new Error("Mutation lock ancestor limit exceeded");
    directory = parent;
  }
  if (!fallback) throw new Error("Mutation lock parent is unavailable");
  const root = metadata
    ? path.join(metadata, "ast-mcp-locks")
    : configured
      ? path.join(configured, ".ast-mcp-locks")
      : path.join(fallback, ".ast-mcp-mutation-locks");
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Unsafe mutation coordination directory");
  return path.join(root, `${sha256(lockPathIdentity(canonical))}.sqlite`);
}

function assertWaiting(options: FileLockOptions, now: number): void {
  if (options.signal?.aborted)
    throw lockError(
      "lock_aborted",
      "File lock acquisition was cancelled",
      false,
    );
  const deadline =
    options.deadline instanceof Date
      ? options.deadline.getTime()
      : options.deadline;
  if (deadline !== undefined && now >= deadline)
    throw lockError("lock_deadline", "File lock deadline expired", true);
}

async function delay(
  milliseconds: number,
  options: FileLockOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () =>
      finish(
        lockError("lock_aborted", "File lock acquisition was cancelled", false),
      );
    const timer = setTimeout(() => finish(), milliseconds);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    timer.unref?.();
  });
}

async function restoreMovedLock(
  lock: string,
  tombstone: string,
): Promise<boolean> {
  try {
    await link(tombstone, lock);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

async function removeIfOwned(lock: string, token: string): Promise<void> {
  const tombstone = `${lock}.stale-${randomUUID()}`;
  try {
    await rename(lock, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let removeTombstone = false;
  try {
    const record = await readRecord(tombstone);
    removeTombstone =
      record?.token === token || (await restoreMovedLock(lock, tombstone));
  } catch (error) {
    removeTombstone = await restoreMovedLock(lock, tombstone);
    throw error;
  } finally {
    if (removeTombstone) await rm(tombstone, { force: true });
  }
}

async function writePendingRecord(
  lock: string,
  record: LockRecord,
): Promise<string> {
  const pending = `${lock}.pending-${randomUUID()}`;
  const handle = await open(pending, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record), "utf8");
    await handle.sync();
  } catch (error) {
    await rm(pending, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  return pending;
}

async function publishNewRecord(
  lock: string,
  record: LockRecord,
): Promise<void> {
  const pending = await writePendingRecord(lock, record);
  try {
    await link(pending, lock);
  } finally {
    await rm(pending, { force: true });
  }
}

async function replaceOwnedRecord(
  lock: string,
  active: LockRecord,
  renewed: LockRecord,
): Promise<void> {
  // Keep the lock pathname present throughout renewal. An open handle also
  // prevents a displaced owner from overwriting a newer owner's inode.
  const handle = await open(lock, "r+");
  try {
    const source = await handle.readFile("utf8");
    const observed = parseLockRecord(source);
    if (
      !observed ||
      observed.token !== active.token ||
      observed.epoch !== active.epoch ||
      observed.expiresAt !== active.expiresAt
    )
      throw lockError("lock_fenced", "File lock ownership was fenced", false);
    // Append committed frames instead of overwriting the last valid lease.
    // A crash or short write leaves the preceding frame readable and expirable.
    const bytes = Buffer.from(
      "\n" +
        JSON.stringify({
          record: renewed,
          sha256: sha256(JSON.stringify(renewed)),
        }) +
        "\n",
    );
    const position = Buffer.byteLength(source);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        position + offset,
      );
      if (bytesWritten === 0) throw new Error("lock_record_write_incomplete");
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupOrphanArtifacts(lock: string): Promise<void> {
  const directory = path.dirname(lock);
  const basename = path.basename(lock);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const cutoff = Date.now() - ORPHAN_ARTIFACT_GRACE_MS;
  const candidates = entries
    .filter(
      (entry) =>
        entry.startsWith(`${basename}.pending-`) ||
        entry.startsWith(`${basename}.stale-`),
    )
    .sort()
    .slice(0, ORPHAN_CLEANUP_LIMIT);
  for (const candidate of candidates) {
    const artifact = path.join(directory, candidate);
    try {
      const metadata = await lstat(artifact);
      if (metadata.isFile() && metadata.mtimeMs <= cutoff)
        await rm(artifact, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function recoverInitializing(
  lock: string,
  initializingSince: number,
): Promise<boolean> {
  if (Date.now() - initializingSince < 250) return false;
  const tombstone = `${lock}.stale-${randomUUID()}`;
  try {
    await rename(lock, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  let removeTombstone = false;
  try {
    if ((await Bun.file(tombstone).text()).length !== 0) {
      removeTombstone = await restoreMovedLock(lock, tombstone);
      return false;
    }
    removeTombstone = true;
    return true;
  } catch (error) {
    removeTombstone = await restoreMovedLock(lock, tombstone);
    throw error;
  } finally {
    if (removeTombstone) await rm(tombstone, { force: true });
  }
}

async function recoverExpired(
  lock: string,
  record: LockRecord,
  now: number,
  accountId: string,
  accountUid: number,
): Promise<number | null> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const earlyRecovery =
    record.protocol === "account-sqlite-v1" &&
    record.accountId === accountId &&
    (process.platform === "win32" || metadata.uid === accountUid);
  if (earlyRecovery) now = Math.max(now, record.expiresAt);
  if (record.expiresAt > now) return null;
  const observed = await readRecord(lock);
  if (
    !observed ||
    observed.token !== record.token ||
    observed.epoch !== record.epoch ||
    observed.expiresAt > now
  )
    return null;
  const tombstone = `${lock}.stale-${randomUUID()}`;
  try {
    const latest = await lstat(lock);
    if (latest.dev !== metadata.dev || latest.ino !== metadata.ino) return null;
    await rename(lock, tombstone);
    let removeTombstone = false;
    try {
      const moved = await readRecord(tombstone);
      if (
        !moved ||
        moved.token !== observed.token ||
        moved.epoch !== observed.epoch ||
        moved.expiresAt !== observed.expiresAt ||
        moved.expiresAt > now
      ) {
        removeTombstone = await restoreMovedLock(lock, tombstone);
        return null;
      }
      removeTombstone = true;
      return Math.max(0, observed.epoch, record.epoch) + 1;
    } catch (error) {
      removeTombstone = await restoreMovedLock(lock, tombstone);
      throw error;
    } finally {
      if (removeTombstone) await rm(tombstone, { force: true });
    }
  } catch (error) {
    if (
      ["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return null;
    throw error;
  }
}

export function lockPathIdentity(canonical: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? canonical.toLowerCase()
    : canonical;
}

export async function acquireFileLock(
  filePath: string,
  options: FileLockOptions = {},
): Promise<FileLockLease> {
  const canonical = await canonicalizePath(filePath);
  const identity = lockPathIdentity(canonical);
  const account = await systemAccount();
  const accountId = sha256(
    process.platform === "win32"
      ? lockPathIdentity(canonicalizePathSync(account.homedir))
      : String(account.uid),
  );
  const directory = await ensureMutationLockDirectory(account);
  const lock = await mutationLockPath(canonical);
  const transaction = await acquireTransactionLock(
    path.join(directory, `file-${sha256(identity)}.sqlite`),
    {
      ...options,
      sharedDatabasePath:
        options.sharedDatabasePath ??
        (await mutationSharedDatabasePath(canonical)),
    },
  );
  try {
    const now = options.now ?? Date.now;
    const leaseMs = Math.max(100, options.leaseMs ?? DEFAULT_LEASE_MS);
    const pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);
    const ownerId = options.ownerId ?? `${process.pid}:${randomUUID()}`;
    let epoch = 1;
    let malformedSince: number | null = null;
    await cleanupOrphanArtifacts(lock);
    while (true) {
      const timestamp = now();
      assertWaiting(options, timestamp);
      const token = randomUUID();
      const record: LockRecord = {
        accountId,
        protocol: "account-sqlite-v1",
        createdAt: timestamp,
        epoch,
        expiresAt: timestamp + leaseMs,
        ownerId,
        pid: process.pid,
        token,
      };
      try {
        await publishNewRecord(lock, record);
        let expiresAt = record.expiresAt;
        let released = false;
        let pendingAccess = Promise.resolve();
        const fenceOnce = async () => {
          transaction.fence();
          const active = await readRecord(lock);
          if (
            released ||
            !active ||
            active.token !== token ||
            active.epoch !== epoch ||
            active.expiresAt <= now()
          )
            throw lockError(
              "lock_fenced",
              "File lock ownership was fenced",
              false,
            );
        };
        const renewOnce = async () => {
          transaction.fence();
          // Acquisition cancellation must not release ownership while an operation
          // is still rolling back or completing its journal entry.
          if (released)
            throw lockError(
              "lock_fenced",
              "File lock ownership was fenced",
              false,
            );
          const active = await readRecord(lock);
          if (
            !active ||
            active.token !== token ||
            active.epoch !== epoch ||
            active.expiresAt <= now()
          )
            throw lockError(
              "lock_fenced",
              "File lock ownership was fenced",
              false,
            );
          const renewed: LockRecord = {
            ...active,
            expiresAt: now() + leaseMs,
          };
          await replaceOwnedRecord(lock, active, renewed);
          const latest = await readRecord(lock);
          if (
            !latest ||
            latest.token !== token ||
            latest.epoch !== epoch ||
            latest.expiresAt !== renewed.expiresAt
          )
            throw lockError(
              "lock_fenced",
              "File lock ownership was fenced",
              false,
            );
          expiresAt = renewed.expiresAt;
        };
        const exclusive = <Result>(
          action: () => Promise<Result>,
        ): Promise<Result> => {
          const result = pendingAccess.then(action);
          pendingAccess = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        };
        const fence = (): Promise<void> => exclusive(fenceOnce);
        const renew = (): Promise<void> => exclusive(renewOnce);
        return {
          epoch,
          get expiresAt() {
            return expiresAt;
          },
          fence,
          lockPath: lock,
          ownerId,
          async release() {
            if (released) return;
            await pendingAccess;
            released = true;
            try {
              await removeIfOwned(lock, token);
            } finally {
              transaction.release();
            }
          },
          renew,
          token,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: LockRecord | null;
        try {
          existing = await readRecord(lock);
        } catch (readError) {
          const code = (readError as { code?: string }).code;
          if (
            (code === "lock_record_initializing" ||
              code === "lock_record_malformed") &&
            malformedSince === null
          )
            malformedSince = Date.now();
          const withinInitializationGrace =
            malformedSince !== null && Date.now() - malformedSince < 250;
          if (
            code === "lock_record_initializing" &&
            !withinInitializationGrace &&
            (await recoverInitializing(lock, malformedSince ?? Date.now()))
          ) {
            epoch += 1;
            malformedSince = null;
            continue;
          }
          if (
            (code === "lock_record_initializing" ||
              code === "lock_record_malformed") &&
            withinInitializationGrace
          ) {
            await delay(pollMs, options);
            continue;
          }
          throw readError;
        }
        if (!existing) continue;
        // Only marked records owned by this account share the kernel guard.
        // Foreign and legacy owners retain their lease through actual expiry.
        const recoveredEpoch = await recoverExpired(
          lock,
          existing,
          timestamp,
          accountId,
          account.uid,
        );
        if (recoveredEpoch !== null) {
          epoch = recoveredEpoch;
          continue;
        }
        await delay(pollMs, options);
      }
    }
  } catch (error) {
    transaction.release();
    throw error;
  }
}

async function withQueue<Result>(
  filePath: string,
  options: FileLockOptions,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = queues.get(filePath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const queued = previous.then(() => current);
  queues.set(filePath, queued);
  try {
    while (true) {
      assertWaiting(options, (options.now ?? Date.now)());
      const waiting = new AbortController();
      try {
        const won = await Promise.race([
          previous.then(() => true),
          delay(options.pollMs ?? DEFAULT_POLL_MS, {
            ...options,
            signal: options.signal
              ? AbortSignal.any([options.signal, waiting.signal])
              : waiting.signal,
          }).then(() => false),
        ]);
        if (won) break;
      } finally {
        waiting.abort();
      }
    }
    return await operation();
  } finally {
    releaseQueue();
    // A cancelled waiter must retain the preceding owner's queue lifetime.
    void queued.then(() => {
      if (queues.get(filePath) === queued) queues.delete(filePath);
    });
  }
}

export async function withFencedFileLock<Result>(
  filePath: string,
  operation: (lease: FileLockLease) => Promise<Result>,
  options: FileLockOptions = {},
): Promise<Result> {
  return withFencedFileLockDiscovery(filePath, operation, options);
}

async function withFencedFileLockDiscovery<Result>(
  filePath: string,
  operation: (lease: FileLockLease) => Promise<Result>,
  options: FileLockOptions,
  discovery?: CoordinationDiscovery,
): Promise<Result> {
  const canonical = canonicalizePathSync(filePath);
  const identity = lockPathIdentity(canonical);
  return withQueue(identity, options, async () => {
    const lease = await acquireFileLock(
      canonical,
      discovery && !options.sharedDatabasePath
        ? {
            ...options,
            sharedDatabasePath: await discoverSharedDatabasePath(
              canonical,
              discovery,
            ),
          }
        : options,
    );
    const heartbeatMs = Math.max(
      25,
      Math.floor((options.leaseMs ?? DEFAULT_LEASE_MS) / 3),
    );
    const heartbeat = setInterval(() => {
      void lease.renew().catch(() => undefined);
    }, heartbeatMs);
    heartbeat.unref?.();
    try {
      return await operation(lease);
    } finally {
      clearInterval(heartbeat);
      await lease.release();
    }
  });
}

export async function withFencedFileLocks<Result>(
  filePaths: readonly string[],
  operation: (leases: readonly FileLockLease[]) => Promise<Result>,
  options: FileLockOptions = {},
): Promise<Result> {
  const canonicalPaths = new Map<string, string>();
  for (const filePath of filePaths) {
    const canonical = canonicalizePathSync(filePath);
    const identity = lockPathIdentity(canonical);
    canonicalPaths.set(identity, canonical);
  }
  const sorted = [...canonicalPaths.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, canonical]) => canonical);
  // Cache observations only for this acquisition batch; later calls revalidate markers.
  const discovery = coordinationDiscovery();
  const leases: FileLockLease[] = [];
  const acquire = async (index: number): Promise<Result> => {
    if (index === sorted.length) return operation(leases);
    const filePath = sorted[index];
    if (!filePath) return operation(leases);
    return withFencedFileLockDiscovery(
      filePath,
      async (lease) => {
        leases.push(lease);
        try {
          return await acquire(index + 1);
        } finally {
          leases.pop();
        }
      },
      options,
      discovery,
    );
  };
  return acquire(0);
}

export function clearMutationLockQueuesForTests(): void {
  queues.clear();
}

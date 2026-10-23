import { randomUUID } from "node:crypto";
import { link, lstat, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "../../runtime/hash.ts";
import { canonicalizePathSync } from "../../runtime/path-utils.ts";

export interface FileLockOptions {
  deadline?: Date | number;
  leaseMs?: number;
  now?: () => number;
  ownerId?: string;
  pollMs?: number;
  signal?: AbortSignal;
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
    "createdAt",
    "epoch",
    "expiresAt",
    "ownerId",
    "pid",
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
    typeof record.token !== "string"
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
  const targetDirectory = path.dirname(filePath);
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
  const basename = path.basename(filePath);
  const name =
    directory === targetDirectory
      ? `${basename.startsWith(".") ? "" : "."}${basename}.ast-mcp.lock`
      : `.${sha256(filePath).slice(0, 24)}.ast-mcp.lock`;
  return path.join(directory, name);
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
): Promise<number | null> {
  if (record.expiresAt > now) return null;
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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

export async function acquireFileLock(
  filePath: string,
  options: FileLockOptions = {},
): Promise<FileLockLease> {
  const lock = await mutationLockPath(filePath);
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
          await removeIfOwned(lock, token);
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
      const recoveredEpoch = await recoverExpired(lock, existing, timestamp);
      if (recoveredEpoch !== null) {
        epoch = recoveredEpoch;
        continue;
      }
      await delay(pollMs, options);
    }
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
    if (queues.get(filePath) === queued) queues.delete(filePath);
  }
}

export async function withFencedFileLock<Result>(
  filePath: string,
  operation: (lease: FileLockLease) => Promise<Result>,
  options: FileLockOptions = {},
): Promise<Result> {
  const canonical =
    process.platform === "win32" ? canonicalizePathSync(filePath) : filePath;
  const identity =
    process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return withQueue(identity, options, async () => {
    const lease = await acquireFileLock(canonical, options);
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
    if (path.basename(filePath).includes(".ast-mcp.lock")) continue;
    const canonical =
      process.platform === "win32" ? canonicalizePathSync(filePath) : filePath;
    const identity =
      process.platform === "win32" ? canonical.toLowerCase() : canonical;
    canonicalPaths.set(identity, canonical);
  }
  const sorted = [...canonicalPaths.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, canonical]) => canonical);
  const leases: FileLockLease[] = [];
  const acquire = async (index: number): Promise<Result> => {
    if (index === sorted.length) return operation(leases);
    const filePath = sorted[index];
    if (!filePath) return operation(leases);
    return withFencedFileLock(
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
    );
  };
  return acquire(0);
}

export function clearMutationLockQueuesForTests(): void {
  queues.clear();
}

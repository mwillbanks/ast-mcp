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
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw Object.assign(new Error("File lock record is malformed"), {
      code: "lock_record_malformed",
      retryable: false,
    });
  }
  const record = exactRecord(parsed);
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
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(
        lockError("lock_aborted", "File lock acquisition was cancelled", false),
      );
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    timer.unref?.();
  });
}

async function restoreMovedLock(
  lock: string,
  tombstone: string,
): Promise<void> {
  try {
    await link(tombstone, lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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
  try {
    const record = await readRecord(tombstone);
    if (record?.token !== token) await restoreMovedLock(lock, tombstone);
  } finally {
    await rm(tombstone, { force: true });
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
  const pending = await writePendingRecord(lock, renewed);
  const tombstone = `${lock}.stale-${randomUUID()}`;
  try {
    await rename(lock, tombstone);
    const moved = await readRecord(tombstone);
    if (
      !moved ||
      moved.token !== active.token ||
      moved.epoch !== active.epoch ||
      moved.expiresAt !== active.expiresAt
    ) {
      await restoreMovedLock(lock, tombstone);
      throw lockError("lock_fenced", "File lock ownership was fenced", false);
    }
    try {
      await link(pending, lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw lockError("lock_fenced", "File lock ownership was fenced", false);
      throw error;
    }
  } finally {
    await Promise.all([
      rm(pending, { force: true }),
      rm(tombstone, { force: true }),
    ]);
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
  try {
    if ((await Bun.file(tombstone).text()).length !== 0) {
      await restoreMovedLock(lock, tombstone);
      return false;
    }
    return true;
  } finally {
    await rm(tombstone, { force: true });
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
    await rm(tombstone, { force: true });
    return Math.max(0, observed.epoch, record.epoch) + 1;
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
        assertWaiting(options, now());
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
      const won = await Promise.race([
        previous.then(() => true),
        delay(options.pollMs ?? DEFAULT_POLL_MS, options).then(() => false),
      ]);
      if (won) break;
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

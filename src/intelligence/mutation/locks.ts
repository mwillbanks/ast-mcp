import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../../runtime/hash.ts";

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
    source = await readFile(lock, "utf8");
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
  const name =
    directory === targetDirectory
      ? `.${path.basename(filePath)}.ast-mcp.lock`
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

async function removeIfOwned(lock: string, token: string): Promise<void> {
  const record = await readRecord(lock);
  if (record?.token === token) await rm(lock, { force: true });
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
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.close();
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
        const renewal = await open(lock, "r+");
        try {
          const before = await renewal.stat();
          const current = exactRecord(
            JSON.parse(await renewal.readFile("utf8")),
          );
          if (
            !current ||
            current.token !== token ||
            current.epoch !== epoch ||
            current.expiresAt !== active.expiresAt
          )
            throw lockError(
              "lock_fenced",
              "File lock ownership was fenced",
              false,
            );
          const latest = await lstat(lock);
          if (latest.dev !== before.dev || latest.ino !== before.ino)
            throw lockError(
              "lock_fenced",
              "File lock ownership was fenced",
              false,
            );
          const renewed: LockRecord = {
            ...current,
            expiresAt: now() + leaseMs,
          };
          await renewal.truncate(0);
          await renewal.write(JSON.stringify(renewed), 0, "utf8");
          expiresAt = renewed.expiresAt;
        } finally {
          await renewal.close();
        }
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
        if (code === "lock_record_malformed" && malformedSince === null)
          malformedSince = Date.now();
        const withinInitializationGrace =
          malformedSince !== null && Date.now() - malformedSince < 250;
        if (
          code === "lock_record_initializing" ||
          (code === "lock_record_malformed" && withinInitializationGrace)
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
  return withQueue(filePath, options, async () => {
    const lease = await acquireFileLock(filePath, options);
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
  const sorted = [...new Set(filePaths)].sort();
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

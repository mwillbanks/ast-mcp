import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  ensurePrivateLockDirectory,
  systemAccount,
} from "../../runtime/private-lock-directory.ts";
import { syncDirectory } from "../../runtime/snapshot-blob.ts";
import {
  GenerationIdSchema,
  RepositoryRelativePathSchema,
  Sha256Schema,
} from "../contracts/common.ts";

const maxMarkerBytes = 64 * 1024;
const maxDirtyPaths = 256;
const maxScheduledCheckouts = 32;
const claimRetryMs = 250;
const maxClaimRetries = 120;
const quietMs = 75;
const maxWaitMs = 250;

const journalSchema = z.enum(["sqlite-v1", "lance-v1"]);
export type RefreshJournalOwner = z.infer<typeof journalSchema>;

const fields = {
  epoch: z.uuid(),
  journal: journalSchema.optional(),
  scope: Sha256Schema,
  storageScope: Sha256Schema,
};
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pendingSchema = z
  .strictObject({
    ...fields,
    kind: z.literal("pending"),
    firstDirtyAt: timestamp,
    indexRefresh: z.literal(false).optional(),
    inFlight: z.boolean().optional(),
    lastDirtyAt: timestamp,
    paths: z.array(RepositoryRelativePathSchema).max(maxDirtyPaths).nullable(),
    publishedGenerationId: GenerationIdSchema.optional(),
  })
  .refine(({ firstDirtyAt, lastDirtyAt }) => firstDirtyAt <= lastDirtyAt);
const cleanSchema = z.strictObject({
  ...fields,
  kind: z.literal("clean"),
  publishedGenerationId: GenerationIdSchema,
});
const markerSchema = z.strictObject({
  version: z.literal(1),
  state: z.discriminatedUnion("kind", [cleanSchema, pendingSchema]),
});

export type PendingRefreshState = Readonly<
  Omit<z.infer<typeof pendingSchema>, "paths"> & {
    paths: readonly string[] | null;
  }
>;
export type RefreshState =
  | PendingRefreshState
  | Readonly<z.infer<typeof cleanSchema>>;

function markerError(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code, { cause }), { code });
}

async function markerLocation(transactionPath: string) {
  const account = await systemAccount();
  const directory = await ensurePrivateLockDirectory(account);
  const key = path.basename(transactionPath);
  if (
    !/^transaction-[a-f0-9]{64}$/u.test(key) ||
    path.join(directory, key) !== transactionPath
  )
    throw markerError("mutation_refresh_marker_scope_invalid");
  return {
    directory,
    file: transactionPath + ".refresh.json",
    uid: account.uid,
  };
}

function assertPrivateFile(metadata: Stats, uid: number, opened = false): void {
  if (
    !metadata.isFile() ||
    (metadata.nlink !== 1 && !(opened && metadata.nlink === 0)) ||
    metadata.size > maxMarkerBytes ||
    (process.platform !== "win32" &&
      (metadata.uid !== uid || (metadata.mode & 0o777) !== 0o600))
  )
    throw markerError("mutation_refresh_marker_unsafe");
}

type MarkerLocation = Awaited<ReturnType<typeof markerLocation>>;

async function readMarker({
  file,
  uid,
}: MarkerLocation): Promise<RefreshState | null> {
  const handle = await (async () => {
    try {
      if (process.platform === "win32")
        assertPrivateFile(await lstat(file), uid);
      return await open(
        file,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw markerError("mutation_refresh_marker_unreadable", error);
    }
  })();
  if (!handle) return null;
  try {
    const metadata = await handle.stat();
    // A replacement can unlink this already-open, complete marker.
    assertPrivateFile(metadata, uid, true);
    const bytes = Buffer.alloc(metadata.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        size,
        bytes.length - size,
        size,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size !== metadata.size)
      throw markerError("mutation_refresh_marker_unsafe");
    try {
      return markerSchema.parse(
        JSON.parse(bytes.subarray(0, size).toString("utf8")),
      ).state;
    } catch (error) {
      throw markerError("mutation_refresh_marker_malformed", error);
    }
  } finally {
    await handle.close();
  }
}

export async function readRefreshState(
  transactionPath: string,
): Promise<RefreshState | null> {
  return readMarker(await markerLocation(transactionPath));
}

function encodeMarker(state: RefreshState): string {
  return JSON.stringify({ version: 1, state });
}

async function removeTemporary(file: string): Promise<void> {
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/** Call with the checkout lease held. The marker survives an interrupted source write. */
async function writeMarker(
  { directory, file }: MarkerLocation,
  content: string,
  firstWrite = false,
): Promise<void> {
  const temporary = file + ".tmp";
  await removeTemporary(temporary);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    await syncDirectory(directory);
    if (firstWrite) await syncDirectory(path.dirname(directory));
  } catch (error) {
    await removeTemporary(temporary).catch(() => undefined);
    throw error;
  }
}

function aggregatePaths(
  previous: PendingRefreshState | null,
  relativePaths: readonly string[],
  scope: string,
  storageScope: string,
): string[] | null {
  if (
    previous &&
    (previous.scope !== scope ||
      previous.storageScope !== storageScope ||
      previous.paths === null)
  )
    return null;
  const paths = new Set(previous?.paths ?? []);
  for (const file of relativePaths) {
    if (!RepositoryRelativePathSchema.safeParse(file).success) return null;
    paths.add(file);
    if (paths.size > maxDirtyPaths) return null;
  }
  return [...paths].sort();
}

/** Durably record dirtiness before changing source under the checkout lease. */
export async function markRefreshPending(
  transactionPath: string,
  relativePaths: readonly string[],
  scope: string,
  storageScope: string,
  options: {
    indexRefresh?: false;
    inFlight?: boolean;
    journal?: RefreshJournalOwner;
    publishedGenerationId?: string;
  } = {},
): Promise<PendingRefreshState> {
  if (
    !Sha256Schema.safeParse(scope).success ||
    !Sha256Schema.safeParse(storageScope).success
  )
    throw markerError("mutation_refresh_marker_scope_invalid");
  const location = await markerLocation(transactionPath);
  const state = await readMarker(location);
  const previous = state?.kind === "pending" ? state : null;
  const journal =
    options.journal ??
    (state?.storageScope === storageScope ? state.journal : undefined);
  const publishedGenerationId =
    state?.scope === scope && state.storageScope === storageScope
      ? (state.publishedGenerationId ?? options.publishedGenerationId)
      : options.publishedGenerationId;
  if (
    publishedGenerationId !== undefined &&
    !GenerationIdSchema.safeParse(publishedGenerationId).success
  )
    throw markerError("mutation_refresh_generation_invalid");
  const now = Math.max(Date.now(), previous?.lastDirtyAt ?? 0);
  const pending: PendingRefreshState = {
    kind: "pending",
    epoch: randomUUID(),
    firstDirtyAt: previous?.firstDirtyAt ?? now,
    ...(options.indexRefresh === false && { indexRefresh: false }),
    inFlight: options.inFlight ?? false,
    ...(journal && { journal }),
    lastDirtyAt: now,
    paths: aggregatePaths(previous, relativePaths, scope, storageScope),
    ...(publishedGenerationId && { publishedGenerationId }),
    scope,
    storageScope,
  };
  const content = encodeMarker(pending);
  const next =
    Buffer.byteLength(content) <= maxMarkerBytes
      ? pending
      : { ...pending, paths: null };
  await writeMarker(
    location,
    next === pending ? content : encodeMarker(next),
    state === null,
  );
  return next;
}

/** Advance the epoch after the journal has reached a terminal state under the lease. */
export async function markRefreshReady(
  transactionPath: string,
  expectedEpoch: string,
): Promise<PendingRefreshState> {
  const location = await markerLocation(transactionPath);
  const state = await readMarker(location);
  if (state?.kind !== "pending" || state.epoch !== expectedEpoch)
    throw markerError("mutation_refresh_marker_stale");
  const ready = {
    ...state,
    epoch: randomUUID(),
    inFlight: false,
    lastDirtyAt: Math.max(Date.now(), state.lastDirtyAt),
  };
  await writeMarker(location, encodeMarker(ready));
  return ready;
}

/** Publish a clean epoch only after the matching refresh commits under the lease. */
export async function markRefreshPublished(
  transactionPath: string,
  expectedEpoch: string,
  publishedGenerationId: string,
): Promise<void> {
  const location = await markerLocation(transactionPath);
  const state = await readMarker(location);
  if (
    state?.kind !== "pending" ||
    state.epoch !== expectedEpoch ||
    state.inFlight !== false
  )
    throw markerError("mutation_refresh_marker_stale");
  if (!GenerationIdSchema.safeParse(publishedGenerationId).success)
    throw markerError("mutation_refresh_generation_invalid");
  await writeMarker(
    location,
    encodeMarker({
      kind: "clean",
      epoch: randomUUID(),
      ...(state.journal && { journal: state.journal }),
      publishedGenerationId,
      scope: state.scope,
      storageScope: state.storageScope,
    }),
  );
}

interface RefreshWork {
  state: PendingRefreshState;
  targetScope: string;
  run: (state: PendingRefreshState) => Promise<void | "retry">;
  retries: number;
  retryAt?: number;
}

interface ScheduledRefresh {
  pending?: RefreshWork;
  running?: RefreshWork;
  timer?: ReturnType<typeof setTimeout>;
  ceilingAt?: number;
}

const scheduled = new Map<string, ScheduledRefresh>();

export function mutationRefreshDueAt(state: PendingRefreshState): number {
  return Math.min(state.firstDirtyAt + maxWaitMs, state.lastDirtyAt + quietMs);
}

function armRefresh(key: string, slot: ScheduledRefresh): void {
  if (slot.timer) clearTimeout(slot.timer);
  const pending = slot.pending;
  if (!pending) return;
  const dueAt = mutationRefreshDueAt(pending.state);
  slot.timer = setTimeout(
    () => {
      slot.timer = undefined;
      slot.pending = undefined;
      slot.ceilingAt = undefined;
      slot.running = pending;
      void runRefresh(key, slot, pending);
    },
    Math.max(
      0,
      Math.min((slot.ceilingAt ?? 0) - performance.now(), dueAt - Date.now()),
      (pending.retryAt ?? 0) - performance.now(),
    ),
  );
  slot.timer.unref?.();
}

async function runRefresh(
  key: string,
  slot: ScheduledRefresh,
  pending: RefreshWork,
): Promise<void> {
  try {
    const outcome = await pending.run(pending.state);
    if (
      outcome === "retry" &&
      !slot.pending &&
      pending.retries < maxClaimRetries
    )
      slot.pending = {
        ...pending,
        retries: pending.retries + 1,
        retryAt: performance.now() + claimRetryMs,
      };
  } catch {
    process.stderr.write("ast-mcp: deferred mutation refresh failed\n");
  } finally {
    slot.running = undefined;
    if (slot.pending) armRefresh(key, slot);
    else scheduled.delete(key);
  }
}

/** Coalesce pending epochs locally. The callback verifies the epoch again under the lease. */
export function scheduleMutationRefresh(
  key: string,
  state: PendingRefreshState,
  work: RefreshWork["run"],
  targetScope = state.scope,
): void {
  let slot = scheduled.get(key);
  if (!slot) {
    if (scheduled.size >= maxScheduledCheckouts) {
      process.stderr.write(
        "ast-mcp: deferred mutation refresh queue is full\n",
      );
      return;
    }
    slot = {};
    scheduled.set(key, slot);
  }
  const matches = (scheduled: RefreshWork | undefined) =>
    scheduled?.state.epoch === state.epoch &&
    scheduled.targetScope === targetScope;
  if (matches(slot.running) || matches(slot.pending)) return;
  slot.pending = { state, targetScope, run: work, retries: 0 };
  slot.ceilingAt ??= performance.now() + maxWaitMs;
  if (!slot.running) armRefresh(key, slot);
}

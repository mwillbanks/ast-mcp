import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { configurationResolutionOptions } from "../../config/identity.ts";
import {
  currentConfig,
  type ResolvedConfig,
  resolveConfig,
} from "../../config/index.ts";
import { withCheckoutAdmission } from "../../runtime/checkout-admission.ts";
import { createDeadline } from "../../runtime/deadline.ts";
import { sha256, sha256Handle } from "../../runtime/hash.ts";
import { withFileLock, withFileLocks } from "../../runtime/locks.ts";
import { canonicalizePath, pathWithin } from "../../runtime/path-utils.ts";
import {
  ensurePrivateLockDirectory as ensureMutationLockDirectory,
  systemAccount,
} from "../../runtime/private-lock-directory.ts";
import {
  openSnapshotBlob,
  inspectSnapshotBlob,
  closeSnapshotHandles,
  copySnapshotBlob,
  publishSnapshotNoReplace,
  releaseSnapshotCapture,
  removeSnapshotBlob,
  removeSnapshotTemporary,
  snapshotNamespace,
  sweepSnapshotBlobs,
  syncDirectory,
} from "../../runtime/snapshot-blob.ts";
import { acquireTransactionLock } from "../../runtime/transaction-lock.ts";
import { createIdentity } from "../contracts/common.ts";
import { ParserWorkerPool } from "../parser/pool.ts";
import { LanceIntelligenceStore } from "../storage/store.ts";
import {
  currentWorkspace,
  type WorkspaceHandle,
} from "../workspace/context.ts";
import {
  gitDirtyOverlayId,
  runGitRaw,
  withWorkspaceGitContext,
} from "../workspace/git.ts";
export { ensurePrivateLockDirectory as ensureMutationLockDirectory } from "../../runtime/private-lock-directory.ts";
import {
  markRefreshPending,
  markRefreshPublished,
  markRefreshReady,
  mutationRefreshDueAt,
  readRefreshState,
  scheduleMutationRefresh,
  type PendingRefreshState,
  type RefreshJournalOwner,
  type RefreshState,
} from "./experimental-deferred-refresh.ts";
import {
  type MutationRefreshFinalizer,
  refreshMutationIntelligence,
} from "./freshness.ts";
import {
  hasUnfinishedLegacyMutations,
  LanceMutationJournal,
} from "./journal.ts";
import { activeMutationLifecycle, withMutationLifecycle } from "./lifecycle.ts";
import { lockPathIdentity, mutationSharedDatabasePath } from "./locks.ts";
import { openNarrowLanceMutationJournal } from "./narrow-lance-journal.ts";
import { openPrivateMutationJournal } from "./private-journal.ts";
import type {
  MutationBatchPlan,
  MutationFileCommit,
  MutationJournalRecord,
  MutationJournalFile,
  MutationLifecycle,
  MutationRefreshResult,
} from "./types.ts";

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error)
    return String((error as { code: unknown }).code);
  return error instanceof Error ? error.name : "mutation_failed";
}

export function mutationOperationId(input: {
  files: readonly {
    candidateSha256: string | null;
    filePath: string;
    sourceSha256: string | null;
  }[];
  nonce: string;
  storageDomainId: string;
  workspaceId: string;
}): string {
  return createIdentity("job", {
    operationId: createIdentity("mutation-operation", {
      ...input,
      files: input.files.map(({ candidateSha256, filePath, sourceSha256 }) => ({
        candidateSha256,
        filePath,
        sourceSha256,
      })),
    }),
    storageDomainId: input.storageDomainId,
    workspaceId: input.workspaceId,
  });
}

async function assertRecoveryPath(
  workspace: WorkspaceHandle,
  filePath: string,
  retained?: FileHandle,
): Promise<void> {
  const canonicalRoot = await canonicalizePath(workspace.checkoutRoot);
  let canonicalTarget: string;
  if (retained) {
    const held = await retained.stat();
    const current = await lstat(filePath);
    if (
      !held.isFile() ||
      current.isSymbolicLink() ||
      held.dev !== current.dev ||
      held.ino !== current.ino
    )
      throw new Error("mutation_recovery_hash_mismatch");
    // macOS realpath requires read permission on mode-zero regular files.
    canonicalTarget = path.join(
      await canonicalizePath(path.dirname(filePath)),
      path.basename(filePath),
    );
  } else canonicalTarget = await canonicalizePath(filePath);
  if (
    path.relative(canonicalRoot, canonicalTarget) === "" ||
    !pathWithin(canonicalRoot, canonicalTarget)
  )
    throw new Error("mutation_path_outside_workspace");
}

function remainingRecoveryBudget(deadline?: Date | number): number | undefined {
  if (deadline === undefined) return undefined;
  const absolute = deadline instanceof Date ? deadline.getTime() : deadline;
  if (!Number.isFinite(absolute))
    throw new RangeError("Invalid recovery deadline");
  const remaining = Math.ceil(absolute - Date.now());
  if (remaining <= 0)
    throw new DOMException(
      "Mutation recovery deadline exceeded",
      "TimeoutError",
    );
  return Math.min(remaining, 0xffffffff);
}

async function hashRecoveryFile(
  filePath: string,
  signal?: AbortSignal,
  retained?: FileHandle,
  hashTimeoutMs?: number,
): Promise<string> {
  const handle =
    retained ??
    (await open(
      filePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    ));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("mutation_recovery_hash_mismatch");
    const digest = await sha256Handle(handle, signal, hashTimeoutMs);
    const after = await handle.stat();
    const current = await lstat(filePath);
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      current.isSymbolicLink() ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("mutation_recovery_hash_mismatch");
    return digest;
  } finally {
    if (!retained) await handle.close();
  }
}

interface NamespaceOnlyRename {
  rollback: boolean;
  signal?: AbortSignal;
  deadline?: Date | number;
}

async function syncMutationFile(
  filePath: string,
  readonlySource?: { mode: number; sha256: string },
  options?: NamespaceOnlyRename,
): Promise<void> {
  let handle: FileHandle;
  let readonly = false;
  try {
    handle = await open(
      filePath,
      (process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY) |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== "win32" ||
      !readonlySource ||
      (code !== "EACCES" && code !== "EPERM")
    )
      throw error;
    const current = await lstat(filePath);
    if (
      current.isSymbolicLink() ||
      (current.mode & 0o200) !== 0 ||
      (current.mode & 0o7777) !== readonlySource.mode
    )
      throw error;
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    readonly = true;
  }
  try {
    const held = await handle.stat();
    const current = await lstat(filePath);
    if (
      !held.isFile() ||
      current.isSymbolicLink() ||
      held.dev !== current.dev ||
      held.ino !== current.ino
    )
      throw new Error("mutation_recovery_hash_mismatch");
    if (readonly) {
      if (
        (held.mode & 0o200) !== 0 ||
        (held.mode & 0o7777) !== readonlySource!.mode ||
        (current.mode & 0o7777) !== readonlySource!.mode ||
        (await hashRecoveryFile(
          filePath,
          options?.signal,
          handle,
          remainingRecoveryBudget(options?.deadline),
        )) !== readonlySource!.sha256 ||
        ((await handle.stat()).mode & 0o7777) !== readonlySource!.mode
      )
        throw new Error("mutation_recovery_hash_mismatch");
      // Rename changed directory entries only; these readonly bytes and mode match the journal.
    } else await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Include created directory entries, without syncing unchanged ancestors. */
async function mutationDirectories(
  files: readonly { filePath: string }[],
  fence: () => Promise<void>,
): Promise<Set<string>> {
  const directories = new Set<string>();
  for (const { filePath } of files) {
    let directory = await canonicalizePath(path.dirname(filePath));
    for (;;) {
      await fence();
      directories.add(directory);
      try {
        await lstat(directory);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(directory);
        if (parent === directory) throw error;
        directory = parent;
      }
    }
  }
  return directories;
}

async function syncMutationPaths(
  workspace: WorkspaceHandle,
  files: MutationBatchPlan["files"],
  fence: () => Promise<void>,
  requireCheckout = true,
  syncFiles = true,
  capturedDirectories: ReadonlySet<string> = new Set(),
  namespaceRename?: NamespaceOnlyRename,
): Promise<void> {
  const directories = await mutationDirectories(files, fence);
  for (const directory of capturedDirectories) directories.add(directory);
  const root = await canonicalizePath(workspace.checkoutRoot);
  for (const [index, file] of files.entries()) {
    const { filePath } = file;
    await fence();
    let readonlySource: { mode: number; sha256: string } | undefined;
    if (namespaceRename) {
      const source = namespaceRename.rollback ? file : files[index - 1];
      const digest = namespaceRename.rollback
        ? file.sourceSha256
        : file.candidateSha256;
      // The rename producer journals adjacent source/destination pairs.
      if (
        source &&
        digest &&
        source.sourceSha256 === digest &&
        source.sourceMode != null &&
        (namespaceRename.rollback ||
          (source.filePath !== filePath &&
            source.candidateSha256 === null &&
            file.sourceSha256 === null))
      )
        readonlySource = { mode: source.sourceMode & 0o7777, sha256: digest };
    }
    if (syncFiles)
      await syncMutationFile(filePath, readonlySource, namespaceRename).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
    const directory = await canonicalizePath(path.dirname(filePath));
    const withinCheckout = directory === root || pathWithin(root, directory);
    if (requireCheckout && !withinCheckout)
      throw new Error("mutation_path_outside_workspace");
  }
  for (const directory of [...directories].sort(
    (a, b) => b.length - a.length,
  )) {
    await fence();
    await syncDirectory(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

class RecoveryMaterials extends Map<string, FileHandle> {
  readonly targets = new Map<string, FileHandle>();
  readonly extraTargets = new Set<FileHandle>();
  readonly cleanReadonly = new Set<string>();
  readonly inline = new Map<string, Buffer>();
  constructor(readonly namespace: string) {
    super();
  }
  async prepare(
    file: MutationJournalFile,
    signal?: AbortSignal,
    hashTimeoutMs?: number,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (file.sourceBlob) {
      if (file.sourceBlob.sha256 !== file.sourceSha256)
        throw new Error("mutation_recovery_material_mismatch");
      this.set(
        file.filePath,
        await openSnapshotBlob(
          file.sourceBlob,
          this.namespace,
          signal,
          hashTimeoutMs,
        ),
      );
    } else if (file.sourceContentBase64 !== null) {
      const source = Buffer.from(file.sourceContentBase64, "base64");
      if (sha256(source) !== file.sourceSha256)
        throw new Error("mutation_recovery_material_mismatch");
      this.inline.set(file.filePath, source);
    } else if (file.sourceSha256 !== null) {
      throw new Error("mutation_recovery_material_missing");
    }
  }
  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await closeSnapshotHandles(
        new Set([
          ...this.values(),
          ...this.targets.values(),
          ...this.extraTargets,
        ]),
      );
    } finally {
      this.clear();
      this.targets.clear();
      this.extraTargets.clear();
      this.cleanReadonly.clear();
      this.inline.clear();
    }
  }
}

async function restoreMutationRecord(
  workspace: WorkspaceHandle,
  record: MutationJournalRecord,
  options: {
    deadline?: Date | number;
    fence?: () => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const remaining = remainingRecoveryBudget(options.deadline);
  using deadline =
    remaining === undefined
      ? undefined
      : createDeadline(remaining, options.signal);
  if (deadline) options = { ...options, signal: deadline.signal };
  for (const file of record.files) {
    await assertRecoveryPath(workspace, file.filePath);
    if (
      (file.sourceUid === null) !== (file.sourceGid === null) ||
      (process.platform === "win32" && file.sourceUid !== null)
    )
      throw new Error("mutation_recovery_unsupported_owner");
  }
  await withFileLocks(
    record.files.map((file) => file.filePath),
    async (leases) => {
      const fence = async () => {
        await options.fence?.();
        for (const lease of leases) await lease.fence();
      };
      const fencePath = async (filePath: string, retained?: FileHandle) => {
        await fence();
        await assertRecoveryPath(workspace, filePath, retained);
      };
      const hashTimeout = () => remainingRecoveryBudget(options.deadline);
      const recoveryHash = (
        filePath: string,
        signal?: AbortSignal,
        retained?: FileHandle,
      ) => hashRecoveryFile(filePath, signal, retained, hashTimeout());
      await using materials = new RecoveryMaterials(
        snapshotNamespace(workspace),
      );
      const directories = await mutationDirectories(record.files, fence);
      // Validate every source and current target before the first recovery write.
      for (const file of record.files) {
        await materials.prepare(file, options.signal, hashTimeout());
        await assertRecoveryPath(workspace, file.filePath);
        const actual = await recoveryHash(file.filePath, options.signal).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          },
        );
        if (
          actual !== null &&
          actual !== file.sourceSha256 &&
          actual !== file.candidateSha256 &&
          actual !== file.committedSha256
        )
          throw new Error("mutation_recovery_hash_mismatch");
      }
      for (const file of record.files) {
        await assertRecoveryPath(workspace, file.filePath);
        const exists = await lstat(file.filePath).then(
          () => true,
          (error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return false;
            throw error;
          },
        );
        if (file.sourceSha256 === null) {
          if (!exists) continue;
          const actual = await recoveryHash(file.filePath, options.signal);
          if (
            actual !== file.candidateSha256 &&
            actual !== file.committedSha256
          )
            throw new Error("mutation_recovery_hash_mismatch");
          await fencePath(file.filePath);
          await unlink(file.filePath);
          continue;
        }
        const source = materials.inline.get(file.filePath);
        let expectedCurrent: string | null = null;
        if (exists) {
          const actual = await recoveryHash(file.filePath, options.signal);
          expectedCurrent = actual;
          if (actual === file.sourceSha256) {
            const readonlyWindows =
              process.platform === "win32" &&
              ((await lstat(file.filePath)).mode & 0o200) === 0;
            let handle = await open(
              file.filePath,
              (process.platform === "win32" && !readonlyWindows
                ? constants.O_RDWR
                : constants.O_RDONLY) |
                constants.O_NONBLOCK |
                constants.O_NOFOLLOW,
            );
            materials.targets.set(file.filePath, handle);
            if (
              (await recoveryHash(file.filePath, options.signal, handle)) !==
              file.sourceSha256
            )
              throw new Error("mutation_recovery_hash_mismatch");
            if (readonlyWindows) {
              const metadata = await handle.stat();
              const stillReadonly = (metadata.mode & 0o200) === 0;
              if (
                stillReadonly &&
                (file.sourceMode === null ||
                  (metadata.mode & 0o7777) === (file.sourceMode & 0o7777)) &&
                (file.sourceUid === null || metadata.uid === file.sourceUid) &&
                (file.sourceGid === null || metadata.gid === file.sourceGid)
              ) {
                // No recovery change needs flushing; retain identity through final verification.
                materials.cleanReadonly.add(file.filePath);
                continue;
              }
              await fencePath(file.filePath, handle);
              if (stillReadonly) {
                if (file.sourceMode === null || (file.sourceMode & 0o200) === 0)
                  throw new Error("mutation_recovery_metadata_unflushable");
                await handle.chmod(file.sourceMode);
              }
              const writable = await open(
                file.filePath,
                constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
              );
              materials.extraTargets.add(writable);
              await fencePath(file.filePath, handle);
              const opened = await writable.stat();
              if (
                opened.dev !== metadata.dev ||
                opened.ino !== metadata.ino ||
                (await recoveryHash(
                  file.filePath,
                  options.signal,
                  writable,
                )) !== file.sourceSha256
              )
                throw new Error("mutation_recovery_hash_mismatch");
              materials.extraTargets.add(handle);
              materials.targets.set(file.filePath, writable);
              handle = writable;
            }
            if (file.sourceUid !== null && file.sourceGid !== null) {
              await fencePath(file.filePath);
              await handle.chown(file.sourceUid, file.sourceGid);
            }
            if (file.sourceMode !== null) {
              await fencePath(file.filePath);
              await handle.chmod(file.sourceMode);
            }
            await handle.sync();
            continue;
          }
          if (
            actual !== file.candidateSha256 &&
            actual !== file.committedSha256
          )
            throw new Error("mutation_recovery_hash_mismatch");
        }
        const temporary = path.join(
          path.dirname(file.filePath),
          `.${path.basename(file.filePath)}.recovery-${randomUUID()}`,
        );
        await fencePath(temporary);
        let temporaryCreated = false;
        let temporaryIdentity: { dev: number; ino: number } | undefined;
        const restorationErrors: unknown[] = [];
        try {
          let output: FileHandle;
          if (file.sourceBlob) {
            const identity = await copySnapshotBlob(
              materials.get(file.filePath)!,
              temporary,
              file.sourceBlob,
              options.signal,
            );
            temporaryCreated = true;
            temporaryIdentity = identity;
            output = await open(
              temporary,
              (process.platform === "win32"
                ? constants.O_RDWR
                : constants.O_RDONLY) | constants.O_NOFOLLOW,
            );
            materials.targets.set(file.filePath, output);
            const actual = await output.stat();
            if (actual.dev !== identity.dev || actual.ino !== identity.ino)
              throw new Error("mutation_recovery_hash_mismatch");
          } else {
            output = await open(temporary, "wx+", 0o600);
            temporaryCreated = true;
            materials.targets.set(file.filePath, output);
            temporaryIdentity = await output.stat();
            await output.writeFile(source!);
            await output.sync();
          }
          if (file.sourceUid !== null && file.sourceGid !== null) {
            await fencePath(temporary);
            await output.chown(file.sourceUid, file.sourceGid);
          }
          if (file.sourceMode !== null) {
            await fencePath(temporary);
            await output.chmod(file.sourceMode);
          }
          await fencePath(temporary, output);
          await output.sync();
          await fencePath(file.filePath);
          await assertRecoveryPath(workspace, temporary, output);
          const actualBeforeReplace = await recoveryHash(
            file.filePath,
            options.signal,
          ).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (actualBeforeReplace !== expectedCurrent)
            throw new Error("mutation_recovery_hash_mismatch");
          await fencePath(file.filePath);
          const held = await output.stat();
          const published = await lstat(temporary);
          if (
            published.isSymbolicLink() ||
            held.dev !== published.dev ||
            held.ino !== published.ino
          )
            throw new Error("mutation_recovery_hash_mismatch");
          if (expectedCurrent === null) {
            const target = await publishSnapshotNoReplace(
              temporary,
              file.filePath,
              output,
              { sha256: file.sourceSha256, size: held.size },
              async (retained) => {
                await fencePath(file.filePath, retained);
                await assertRecoveryPath(workspace, temporary, output);
              },
              {
                signal: options.signal,
                hashTimeoutMs: remainingRecoveryBudget(options.deadline),
              },
            );
            if (target !== output) {
              materials.extraTargets.add(output);
              materials.targets.set(file.filePath, target);
            }
          } else {
            await rename(temporary, file.filePath);
          }
        } catch (error) {
          restorationErrors.push(error);
          throw error;
        } finally {
          const failures = [...restorationErrors];
          if (temporaryCreated && temporaryIdentity) {
            try {
              await removeSnapshotTemporary(temporary, temporaryIdentity);
            } catch (error) {
              failures.push(error);
            }
            if (restorationErrors.length) {
              try {
                await syncDirectory(path.dirname(temporary));
              } catch (error) {
                failures.push(error);
              }
            }
          }
          if (failures.length > restorationErrors.length)
            throw new AggregateError(
              failures,
              "Mutation recovery temporary cleanup failed",
            );
        }
      }
      for (const file of record.files) {
        await assertRecoveryPath(
          workspace,
          file.filePath,
          materials.targets.get(file.filePath),
        );
        const exists = await lstat(file.filePath).then(
          () => true,
          () => false,
        );
        if (file.sourceSha256 === null) {
          if (exists) throw new Error("mutation_recovery_verification_failed");
        } else {
          if (!exists) throw new Error("mutation_recovery_verification_failed");
          const [actual, metadata] = await Promise.all([
            recoveryHash(
              file.filePath,
              options.signal,
              materials.targets.get(file.filePath),
            ),
            lstat(file.filePath),
          ]);
          if (
            actual !== file.sourceSha256 ||
            (file.sourceMode !== null &&
              (metadata.mode & 0o7777) !== (file.sourceMode & 0o7777)) ||
            (file.sourceUid !== null && metadata.uid !== file.sourceUid) ||
            (file.sourceGid !== null && metadata.gid !== file.sourceGid)
          )
            throw new Error("mutation_recovery_verification_failed");
          if (!materials.cleanReadonly.has(file.filePath))
            await materials.targets.get(file.filePath)!.sync();
        }
      }
      await syncMutationPaths(
        workspace,
        record.files,
        fence,
        true,
        false,
        directories,
      );
    },
    {
      deadline: options.deadline ?? Date.now() + 10_000,
      signal: options.signal,
    },
  );
}

export class LanceMutationLifecycle implements MutationLifecycle {
  readonly journal: LanceMutationJournal;
  readonly #plans = new Map<string, MutationBatchPlan>();
  readonly #directories = new Map<string, ReadonlySet<string>>();
  readonly #refreshes = new Map<string, PendingRefreshState>();

  constructor(
    private readonly store: LanceIntelligenceStore | undefined,
    private readonly workspace: WorkspaceHandle,
    private readonly refresh: typeof refreshMutationIntelligence = refreshMutationIntelligence,
    private readonly options: {
      deadline?: Date | number;
      fence?: () => Promise<void>;
      journal?: LanceMutationJournal;
      refreshTimeoutMs?: number;
      signal?: AbortSignal;
      skipUnindexedRefresh?: boolean;
      refreshMarker?: {
        background: boolean;
        config: ResolvedConfig;
        journal?: RefreshJournalOwner;
        publishedGenerationId?: string;
        transactionPath: string;
      };
    } = {},
  ) {
    if (!options.journal && !store)
      throw new Error("mutation_journal_unavailable");
    this.journal = options.journal ?? new LanceMutationJournal(store!);
  }

  async recover(): Promise<void> {
    await this.options.fence?.();
    const checkoutRoot = await canonicalizePath(this.workspace.checkoutRoot);
    const recovered = await this.journal.recover(
      this.workspace.workspaceId,
      (record) => restoreMutationRecord(this.workspace, record, this.options),
      checkoutRoot,
    );
    for (const operationId of recovered) {
      this.#plans.delete(operationId);
      this.#directories.delete(operationId);
      const record = await this.journal.get(operationId);
      for (const file of record?.files ?? [])
        if (file.sourceBlob)
          await removeSnapshotBlob(
            file.sourceBlob,
            snapshotNamespace(this.workspace),
          ).catch(() => undefined);
    }
    const unfinished = await this.journal.unfinished(
      this.workspace.workspaceId,
      checkoutRoot,
    );
    await sweepSnapshotBlobs(
      snapshotNamespace(this.workspace),
      new Set(
        unfinished.flatMap((record) =>
          record.files.flatMap((file) =>
            file.sourceBlob ? [file.sourceBlob.id] : [],
          ),
        ),
      ),
    );
    if (unfinished.length > 0) throw new Error("mutation_recovery_required");
  }

  async begin(plan: MutationBatchPlan): Promise<void> {
    this.options.signal?.throwIfAborted();
    await this.options.fence?.();
    if (
      !plan.workspace ||
      plan.workspace.workspaceId !== this.workspace.workspaceId ||
      plan.workspace.selectedRevision.revisionId !==
        this.workspace.selectedRevision.revisionId ||
      plan.workspace.storageDomain.domainId !==
        this.workspace.storageDomain.domainId
    )
      throw new Error("mutation_workspace_mismatch");
    if (!this.workspace.writeEligibility.eligible)
      throw new Error("workspace_read_only");
    // Begin only journals. Producers fully verify all captured bytes after begin,
    // before changing any target, so a durable rollback owner exists on failure.
    for (const file of plan.files)
      if (file.sourceBlob)
        await inspectSnapshotBlob(
          file.sourceBlob,
          snapshotNamespace(this.workspace),
          this.options.signal,
        );
    const directories = await mutationDirectories(plan.files, async () => {
      this.options.signal?.throwIfAborted();
      await this.options.fence?.();
    });
    const marker = this.options.refreshMarker;
    if (marker) {
      const pending = await markRefreshPending(
        marker.transactionPath,
        plan.files.map((file) =>
          repositoryRelativeMutationPath(this.workspace, file.filePath),
        ),
        refreshScope(this.workspace, configurationIdentity(marker.config)),
        refreshStorageScope(this.workspace),
        {
          ...(!marker.background && { indexRefresh: false as const }),
          inFlight: true,
          journal: marker.journal,
          publishedGenerationId: marker.publishedGenerationId,
        },
      );
      this.#refreshes.set(plan.operationId, pending);
      this.options.signal?.throwIfAborted();
      await this.options.fence?.();
    }
    await this.journal.begin(plan);
    this.#directories.set(plan.operationId, directories);
    for (const file of plan.files)
      if (file.sourceBlob)
        releaseSnapshotCapture(
          file.sourceBlob,
          snapshotNamespace(this.workspace),
        );
    this.#plans.set(plan.operationId, plan);
  }

  async committed(
    operationId: string,
    file: MutationFileCommit,
  ): Promise<void> {
    if (!this.#plans.has(operationId))
      throw new Error("mutation_operation_unknown");
    await this.options.fence?.();
    await this.journal.committed(operationId, file);
  }

  async complete(
    operationId: string,
    _files: readonly MutationFileCommit[],
  ): Promise<MutationRefreshResult> {
    const plan = this.#plans.get(operationId);
    if (!plan) throw new Error("mutation_operation_unknown");
    await this.options.fence?.();
    const refreshPending = this.options.refreshMarker?.background;
    let result: MutationRefreshResult;
    try {
      result =
        refreshPending || this.options.skipUnindexedRefresh
          ? {
              dirtyOverlayId: this.workspace.dirtyOverlayId,
              generationId: null,
              indexedAt: new Date().toISOString(),
              parsedFiles: [],
              skippedFiles: [],
              ...(refreshPending && { refreshPending: true as const }),
            }
          : await this.refreshCommitted(operationId);
      await this.options.fence?.();
      await syncMutationPaths(
        this.workspace,
        plan.files,
        async () => {
          await this.options.fence?.();
        },
        false,
        // Attribute and text producers sync retained descriptors before closing.
        !["file_chattr", "file_patch", "file_write"].includes(plan.tool),
        this.#directories.get(operationId),
        plan.tool === "file_rename"
          ? {
              rollback: false,
              signal: this.options.signal,
              deadline: this.options.deadline,
            }
          : undefined,
      );
      this.options.signal?.throwIfAborted();
      await this.journal.transition(operationId, "succeeded");
    } catch (error) {
      await this.journal.transition(
        operationId,
        "recovery-required",
        errorCode(error),
      );
      throw error;
    }
    this.#plans.delete(operationId);
    this.#directories.delete(operationId);
    await this.finishRefresh(operationId, result.generationId);
    return result;
  }

  private async finishRefresh(
    operationId: string,
    generationId?: string | null,
  ): Promise<void> {
    const pending = this.#refreshes.get(operationId);
    const marker = this.options.refreshMarker;
    if (!pending || !marker) return;
    this.#refreshes.delete(operationId);
    let ready = pending;
    try {
      ready = await markRefreshReady(marker.transactionPath, pending.epoch);
      if (generationId) {
        await markRefreshPublished(
          marker.transactionPath,
          ready.epoch,
          generationId,
        );
        return;
      }
    } catch {
      // A terminal journal stays authoritative if the marker update fails.
      process.stderr.write("ast-mcp: mutation refresh marker update failed\n");
    }
    if (marker.background)
      enqueueRefresh(
        this.workspace,
        marker.transactionPath,
        ready,
        marker.config,
      );
  }

  private async refreshCommitted(
    operationId: string,
  ): Promise<MutationRefreshResult> {
    await this.journal.transition(operationId, "refreshing");
    const parsers = new ParserWorkerPool({ minWorkers: 0, maxWorkers: 1 });
    const timeout = new AbortController();
    const timeoutError = Object.assign(
      new Error("Mutation intelligence refresh timed out"),
      {
        code: "intelligence_refresh_timeout",
        retryable: true,
        suggestedNextCall: "Run index explicitly before retrying this mutation",
      },
    );
    const timer = setTimeout(
      () => timeout.abort(timeoutError),
      this.options.refreshTimeoutMs ?? 30_000,
    );
    const signal = this.options.signal
      ? AbortSignal.any([this.options.signal, timeout.signal])
      : timeout.signal;
    try {
      const refresh = (store: LanceIntelligenceStore) =>
        this.refresh({
          parse: (request, options) => parsers.parse(request, options),
          signal,
          store,
          workspace: this.workspace,
        });
      const result = await (this.store
        ? refresh(this.store)
        : withMutationStore(this.workspace, refresh));
      signal.throwIfAborted();
      return result;
    } catch (error) {
      throw timeout.signal.aborted && !this.options.signal?.aborted
        ? timeoutError
        : error;
    } finally {
      clearTimeout(timer);
      await parsers.close();
    }
  }

  async failed(operationId: string, error: unknown): Promise<void> {
    if (!this.#plans.has(operationId)) return;
    await this.journal.transition(
      operationId,
      "recovery-required",
      errorCode(error),
    );
  }

  async rolledBack(operationId: string): Promise<void> {
    const plan = this.#plans.get(operationId);
    if (!plan) return;
    await syncMutationPaths(
      this.workspace,
      plan.files,
      async () => {
        await this.options.fence?.();
      },
      false,
      !["file_chattr", "file_patch", "file_write"].includes(plan.tool),
      this.#directories.get(operationId),
      plan.tool === "file_rename"
        ? {
            rollback: true,
            signal: this.options.signal,
            deadline: this.options.deadline,
          }
        : undefined,
    );
    await this.journal.transition(operationId, "rolled-back");
    this.#plans.delete(operationId);
    this.#directories.delete(operationId);
    await this.finishRefresh(operationId);
  }
}

/** One private checkout-lock namespace per operating-system account. */
export async function mutationTransactionLockPath(
  checkoutRoot: string,
): Promise<string> {
  const account = await systemAccount();
  const directory = await ensureMutationLockDirectory(account);
  const checkout = await canonicalizePath(checkoutRoot);
  const identity = lockPathIdentity(checkout);
  return path.join(directory, `transaction-${sha256(identity)}`);
}

function repositoryRelativeMutationPath(
  workspace: WorkspaceHandle,
  filePath: string,
): string {
  if (!pathWithin(workspace.checkoutRoot, filePath))
    throw new Error("mutation_workspace_mismatch");
  return path
    .relative(workspace.checkoutRoot, filePath)
    .split(path.sep)
    .join("/");
}

interface CheckoutMutationOptions {
  deadline?: Date | number;
  signal?: AbortSignal;
  tryOnly?: boolean;
}

async function withCheckoutMutationLease<T>(
  workspace: WorkspaceHandle,
  transactionPath: string,
  options: CheckoutMutationOptions,
  operation: (fence: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const deadline =
    options.deadline instanceof Date
      ? options.deadline.getTime()
      : (options.deadline ?? Date.now() + 10_000);
  const sharedDatabasePath = await mutationSharedDatabasePath(
    workspace.checkoutRoot,
  );
  return withCheckoutAdmission(
    transactionPath,
    { deadline, signal: options.signal, tryOnly: options.tryOnly },
    () =>
      withFileLock(
        transactionPath,
        async (lease) => {
          options.signal?.throwIfAborted();
          return operation(() => lease.fence());
        },
        {
          deadline,
          onReleaseError: () => {
            process.stderr.write("ast-mcp: checkout lock cleanup failed\n");
          },
          signal: options.signal,
          sharedDatabasePath,
          tryOnly: options.tryOnly,
        },
      ),
  );
}

async function withMutationStore<T>(
  workspace: WorkspaceHandle,
  operation: (store: LanceIntelligenceStore) => Promise<T>,
): Promise<T> {
  const store = await LanceIntelligenceStore.open(workspace.storageDomain);
  try {
    return await operation(store);
  } finally {
    await store.shutdownCoordinator().catch(() => {
      process.stderr.write("ast-mcp: storage coordinator cleanup failed\n");
    });
  }
}

function refreshStorageScope(workspace: WorkspaceHandle): string {
  return sha256(workspace.storageDomain.domainId);
}

function refreshScope(
  workspace: WorkspaceHandle,
  configuration: string | number,
): string {
  return sha256(
    JSON.stringify([
      workspace.storageDomain.domainId,
      workspace.selectedRevision.revisionId,
      configuration,
    ]),
  );
}

function acquireRefreshClaim(
  transactionPath: string,
  options: CheckoutMutationOptions,
) {
  const tryOnly = options.tryOnly ?? true;
  return acquireTransactionLock(transactionPath + ".refresh-job", {
    ...options,
    tryOnly,
  }).catch((error: unknown) => {
    if (errorCode(error) !== (tryOnly ? "lock_busy" : "lock_deadline"))
      throw error;
    return undefined;
  });
}

function configurationIdentity(config: Readonly<ResolvedConfig>): string {
  return sha256(JSON.stringify({ ...config, generation: 0 }));
}

async function refreshCheckoutIdentity(
  workspace: WorkspaceHandle,
  signal?: AbortSignal,
) {
  const [checkout, head] = await Promise.all([
    lstat(workspace.checkoutRoot, { bigint: true }),
    workspace.git.isGit
      ? runGitRaw(
          workspace.checkoutRoot,
          ["rev-parse", "--verify", "HEAD"],
          signal,
        )
      : null,
  ]);
  if (!checkout.isDirectory()) throw refreshPendingError();
  return {
    checkout: checkout.dev + ":" + checkout.ino,
    head:
      head?.code === 0
        ? Buffer.from(head.stdout).toString("utf8").trim()
        : null,
  };
}

function refreshOverlay(workspace: WorkspaceHandle) {
  return gitDirtyOverlayId(
    workspace.git,
    workspace.repositoryId,
    workspace.selectedRevision.revisionId,
    workspace.storageDomain.storagePath,
  );
}

async function withStagedRefresh(
  workspace: WorkspaceHandle,
  transactionPath: string,
  pending: PendingRefreshState,
  options: CheckoutMutationOptions,
  claim: NonNullable<Awaited<ReturnType<typeof acquireRefreshClaim>>>,
  config: ResolvedConfig,
  operation: (
    finalize: MutationRefreshFinalizer,
  ) => Promise<MutationRefreshResult>,
): Promise<MutationRefreshResult> {
  const configurationOptions = configurationResolutionOptions(config);
  const readConfigurationIdentity = async () =>
    configurationIdentity(await resolveConfig(configurationOptions));
  const [before, configuration, beforeOverlay] = await Promise.all([
    refreshCheckoutIdentity(workspace, options.signal),
    readConfigurationIdentity(),
    refreshOverlay(workspace),
  ]);
  if (
    before.head !== workspace.git.headOid ||
    configuration !== configurationIdentity(config) ||
    refreshScope(workspace, configuration) !== pending.scope
  )
    throw refreshPendingError();

  return operation(async (publish) => {
    // Hash the external overlay outside the lease. The epoch fences managed
    // writes; external tools can still edit after this check.
    const afterOverlay = await refreshOverlay(workspace);
    return withCheckoutMutationLease(
      workspace,
      transactionPath,
      { ...options, tryOnly: true },
      async (fence) => {
        const latest = await readRefreshState(transactionPath);
        if (
          latest?.kind !== "pending" ||
          latest.scope !== pending.scope ||
          latest.inFlight !== false ||
          latest.epoch !== pending.epoch
        )
          throw refreshPendingError();

        const [after, currentConfiguration] = await Promise.all([
          refreshCheckoutIdentity(workspace, options.signal),
          readConfigurationIdentity(),
        ]);
        if (
          before.checkout !== after.checkout ||
          before.head !== after.head ||
          configuration !== currentConfiguration
        )
          throw refreshPendingError();

        options.signal?.throwIfAborted();
        claim.fence();
        await fence();
        if (beforeOverlay !== afterOverlay) {
          // Advance the current epoch so the coalescer retries external edits.
          await markRefreshReady(transactionPath, pending.epoch);
          throw refreshPendingError();
        }

        const publication = await publish();
        options.signal?.throwIfAborted();
        claim.fence();
        await fence();
        await markRefreshPublished(
          transactionPath,
          pending.epoch,
          publication.generationId,
        );
        return publication;
      },
    );
  });
}

async function withSelectedMutationJournal<T>(
  workspace: WorkspaceHandle,
  transactionPath: string,
  owner: RefreshJournalOwner,
  operation: (journal: LanceMutationJournal) => Promise<T>,
  options: { requireExisting?: boolean; journalMode?: "delete" | "wal" },
): Promise<T> {
  const opened =
    owner === "lance-v1"
      ? await openNarrowLanceMutationJournal(
          workspace.storageDomain,
          workspace.checkoutRoot,
          options,
        )
      : await openPrivateMutationJournal(
          transactionPath,
          workspace.storageDomain.domainId,
          options,
        );
  try {
    return await operation(opened.journal);
  } finally {
    opened.close();
  }
}

function readMutationState(workspace: WorkspaceHandle) {
  return LanceIntelligenceStore.readMutationState(
    workspace.storageDomain,
    workspace,
  );
}

function recoverRefresh(
  workspace: WorkspaceHandle,
  transactionPath: string,
  marker: RefreshState | undefined,
  options: CheckoutMutationOptions,
  fence: () => Promise<void>,
  knownState?: Awaited<ReturnType<typeof readMutationState>>,
): Promise<void> {
  if (marker?.journal)
    return withSelectedMutationJournal(
      workspace,
      transactionPath,
      marker.journal,
      (journal) =>
        new LanceMutationLifecycle(
          undefined,
          workspace,
          refreshMutationIntelligence,
          {
            ...options,
            fence,
            journal,
          },
        ).recover(),
      { requireExisting: true },
    );
  return recoverLegacyMutations(workspace, options, fence, knownState);
}

async function recoverLegacyMutations(
  workspace: WorkspaceHandle,
  options: CheckoutMutationOptions,
  fence: () => Promise<void>,
  knownState?: Awaited<ReturnType<typeof readMutationState>>,
): Promise<void> {
  const { legacyPayloads } = knownState ?? (await readMutationState(workspace));
  if (
    !hasUnfinishedLegacyMutations(
      legacyPayloads,
      workspace.workspaceId,
      workspace.checkoutRoot,
    )
  )
    return;
  await withMutationStore(workspace, (store) =>
    new LanceMutationLifecycle(store, workspace, refreshMutationIntelligence, {
      ...options,
      fence,
    }).recover(),
  );
}

function enqueueRefresh(
  workspace: WorkspaceHandle,
  transactionPath: string,
  observed: RefreshState,
  config: ResolvedConfig,
): void {
  const scope = refreshScope(workspace, configurationIdentity(config));
  const storageScope = refreshStorageScope(workspace);
  const isCurrent = (
    marker: RefreshState | null,
  ): marker is PendingRefreshState =>
    marker?.kind === "pending" && marker.scope === scope;
  const canTransition = (marker: RefreshState | null): boolean =>
    marker !== null &&
    marker.scope !== scope &&
    marker.storageScope === storageScope;
  const eligible = (marker: RefreshState | null): marker is RefreshState =>
    !(marker?.kind === "pending" && marker.indexRefresh === false) &&
    (isCurrent(marker) || canTransition(marker));
  if (!eligible(observed)) return;
  const now = Date.now();
  const ticket: PendingRefreshState =
    observed.kind === "pending"
      ? observed
      : {
          kind: "pending",
          epoch: observed.epoch,
          firstDirtyAt: now,
          lastDirtyAt: now,
          paths: null,
          scope: observed.scope,
          storageScope: observed.storageScope,
        };
  scheduleMutationRefresh(
    transactionPath,
    ticket,
    async (): Promise<void | "retry"> => {
      const queued = await readRefreshState(transactionPath);
      if (!eligible(queued)) return;
      if (
        queued.kind === "pending" &&
        queued.epoch !== ticket.epoch &&
        Date.now() < mutationRefreshDueAt(queued)
      )
        return "retry";
      using deadline = createDeadline(30_000);
      const options = {
        deadline: Date.now() + 30_000,
        signal: deadline.signal,
      };
      const claim = await acquireRefreshClaim(transactionPath, options);
      if (!claim) return "retry";

      let attemptedEpoch = queued.epoch;
      try {
        await withWorkspaceGitContext(
          { signal: options.signal, timeoutMs: 30_000 },
          async () => {
            const marker = await readRefreshState(transactionPath);
            if (!eligible(marker)) return;
            let transitionCheckout: string | undefined;
            if (canTransition(marker)) {
              // Confirm the originating request still represents the current scope
              // before replacing a marker belonging to a different configuration.
              const [inputs, resolved] = await Promise.all([
                refreshCheckoutIdentity(workspace, options.signal),
                resolveConfig(configurationResolutionOptions(config)),
              ]);
              if (
                inputs.head !== workspace.git.headOid ||
                configurationIdentity(resolved) !==
                  configurationIdentity(config)
              )
                return;
              transitionCheckout = inputs.checkout;
            }
            const pending =
              isCurrent(marker) && marker.inFlight === false
                ? marker
                : await withCheckoutMutationLease(
                    workspace,
                    transactionPath,
                    options,
                    async (fence) => {
                      const latest = await readRefreshState(transactionPath);
                      if (isCurrent(latest) && latest.inFlight === false)
                        return latest;
                      claim.fence();
                      await fence();
                      if (!isCurrent(latest)) {
                        if (
                          transitionCheckout === undefined ||
                          !canTransition(latest)
                        )
                          return null;
                        const checkout = await lstat(workspace.checkoutRoot, {
                          bigint: true,
                        });
                        if (
                          !checkout.isDirectory() ||
                          checkout.dev + ":" + checkout.ino !==
                            transitionCheckout
                        )
                          return null;
                      }
                      const recovering = isCurrent(latest)
                        ? latest
                        : await markRefreshPending(
                            transactionPath,
                            [],
                            scope,
                            storageScope,
                            { inFlight: true },
                          );
                      await recoverRefresh(
                        workspace,
                        transactionPath,
                        recovering,
                        options,
                        fence,
                      );
                      await fence();
                      return markRefreshReady(
                        transactionPath,
                        recovering.epoch,
                      );
                    },
                  );
            if (!pending) return;
            attemptedEpoch = pending.epoch;
            const parsers = new ParserWorkerPool({
              minWorkers: 0,
              maxWorkers: 1,
              nativePackContext: {
                config,
                checkoutRoot: workspace.checkoutRoot,
              },
            });
            try {
              await withStagedRefresh(
                workspace,
                transactionPath,
                pending,
                options,
                claim,
                config,
                (finalize) =>
                  withMutationStore(workspace, (store) =>
                    refreshMutationIntelligence({
                      finalize,
                      parse: (request, parserOptions) =>
                        parsers.parse(request, parserOptions),
                      signal: options.signal,
                      store,
                      workspace,
                    }),
                  ),
              );
            } finally {
              await parsers.close();
            }
          },
        );
      } catch (error) {
        const code = errorCode(error);
        if (code === "coordinator_unavailable") return "retry";
        if (code === "lock_busy") {
          const latest = await readRefreshState(transactionPath);
          if (isCurrent(latest) && latest.epoch === attemptedEpoch)
            return "retry";
        } else if (code !== "intelligence_refresh_pending") {
          throw error;
        }
      } finally {
        claim.release();
        await enqueueFollowUpRefresh(
          workspace,
          transactionPath,
          attemptedEpoch,
          config,
        );
      }
    },
    scope,
  );
}

async function enqueueFollowUpRefresh(
  workspace: WorkspaceHandle,
  transactionPath: string,
  attemptedEpoch: string,
  config: ResolvedConfig,
  retryCurrent = false,
): Promise<void> {
  const latest = await readRefreshState(transactionPath);
  if (
    latest?.kind === "pending" &&
    latest.indexRefresh !== false &&
    latest.scope === refreshScope(workspace, configurationIdentity(config)) &&
    (retryCurrent || latest.epoch !== attemptedEpoch)
  )
    enqueueRefresh(workspace, transactionPath, latest, config);
}

function refreshPendingError() {
  return Object.assign(
    new Error("Working intelligence requires a fresh index"),
    {
      code: "intelligence_refresh_pending",
      retryable: true,
      suggestedNextCall: "index with action=refresh",
    },
  );
}

export interface MutationIndexObservation {
  epoch?: string;
  pending: boolean;
  generationId?: string;
}

export async function observeMutationIndex(
  workspace: WorkspaceHandle,
): Promise<MutationIndexObservation> {
  if (workspace.selectedRevision.selector.kind !== "working")
    return { pending: false };
  const transactionPath = await mutationTransactionLockPath(
    workspace.checkoutRoot,
  );
  const state = await readRefreshState(transactionPath);
  if (!state) return { pending: false };
  if (
    state.kind === "pending" &&
    state.indexRefresh === false &&
    state.storageScope === refreshStorageScope(workspace)
  )
    return { epoch: state.epoch, pending: state.inFlight !== false };
  const config = await currentConfig();
  const scope = refreshScope(workspace, configurationIdentity(config));
  if (state.scope !== scope) {
    enqueueRefresh(workspace, transactionPath, state, config);
    return { epoch: state.epoch, pending: true };
  }
  if (state.kind === "pending")
    enqueueRefresh(workspace, transactionPath, state, config);
  return {
    epoch: state.epoch,
    pending: state.kind === "pending",
    generationId: state.publishedGenerationId,
  };
}

export async function withFreshMutationRead<T>(
  workspace: WorkspaceHandle,
  operation: (publishedGenerationId?: string) => Promise<T>,
): Promise<T> {
  const before = await observeMutationIndex(workspace);
  if (before.pending) throw refreshPendingError();
  const result = await operation(before.generationId);
  const after = await observeMutationIndex(workspace);
  if (after.epoch !== before.epoch || after.pending)
    throw refreshPendingError();
  return result;
}

export function assertPublishedMutationGeneration(
  expected: string | undefined,
  actual: string | undefined,
): void {
  if (expected && actual !== expected) throw refreshPendingError();
}

export async function withDeferredIndexPublication(
  workspace: WorkspaceHandle,
  operation: (
    finalize?: MutationRefreshFinalizer,
  ) => Promise<MutationRefreshResult>,
  signal?: AbortSignal,
): Promise<MutationRefreshResult> {
  if (workspace.selectedRevision.selector.kind !== "working")
    return operation();
  const transactionPath = await mutationTransactionLockPath(
    workspace.checkoutRoot,
  );
  const options = { signal };
  const config = await currentConfig();
  const scope = refreshScope(workspace, configurationIdentity(config));
  // An explicit build can wait for the existing refresh without holding the
  // checkout lease. The background scheduler continues to use a try-only claim.
  const claim = await acquireRefreshClaim(transactionPath, {
    ...options,
    tryOnly: false,
  });
  if (!claim) throw refreshPendingError();
  let attemptedEpoch: string | undefined;
  let retryCurrent = false;
  try {
    const pending = await withCheckoutMutationLease(
      workspace,
      transactionPath,
      options,
      async (fence) => {
        const previous = await readRefreshState(transactionPath);
        if (
          previous?.kind === "pending" &&
          previous.scope === scope &&
          previous.indexRefresh !== false &&
          previous.inFlight === false
        )
          return previous;
        const storageScope = refreshStorageScope(workspace);
        if (
          previous?.kind === "pending" &&
          previous.storageScope !== storageScope &&
          previous.inFlight !== false
        )
          throw refreshPendingError();

        const mutationState =
          previous?.journal && previous.storageScope === storageScope
            ? undefined
            : await readMutationState(workspace);
        const recovering = await markRefreshPending(
          transactionPath,
          [],
          scope,
          storageScope,
          {
            inFlight: true,
            publishedGenerationId: mutationState?.publishedGenerationId,
          },
        );
        await recoverRefresh(
          workspace,
          transactionPath,
          recovering,
          options,
          fence,
          mutationState,
        );
        await fence();
        return markRefreshReady(transactionPath, recovering.epoch);
      },
    );
    attemptedEpoch = pending.epoch;
    let generationId: string | undefined;
    const result = await withStagedRefresh(
      workspace,
      transactionPath,
      pending,
      options,
      claim,
      config,
      (finalize) =>
        operation(async (publish) => {
          const publication = await finalize(publish);
          generationId = publication.generationId;
          return publication;
        }),
    );
    if (!generationId || result.generationId !== generationId)
      throw refreshPendingError();
    return result;
  } catch (error) {
    if (errorCode(error) !== "lock_busy") throw error;
    retryCurrent = true;
    throw refreshPendingError();
  } finally {
    claim.release();
    if (attemptedEpoch)
      await enqueueFollowUpRefresh(
        workspace,
        transactionPath,
        attemptedEpoch,
        config,
        retryCurrent,
      );
  }
}

export async function withLanceMutationLifecycle<T>(
  operation: () => Promise<T>,
  options: CheckoutMutationOptions & { preview?: boolean } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  if (options.preview || activeMutationLifecycle()) return operation();
  const workspace = currentWorkspace();
  if (!workspace) return operation();
  // Workspace IDs change with revisions and overlays. Guard the actual checkout.
  const transactionPath = await mutationTransactionLockPath(
    workspace.checkoutRoot,
  );
  return withCheckoutMutationLease(
    workspace,
    transactionPath,
    options,
    async (fence) => {
      const state = await readRefreshState(transactionPath);
      const storageScope = refreshStorageScope(workspace);
      if (
        state?.kind === "pending" &&
        state.storageScope !== storageScope &&
        state.inFlight !== false
      )
        throw refreshPendingError();

      const sameStorage = state?.storageScope === storageScope ? state : null;
      const previousOwner = sameStorage?.journal;
      const mutationState = previousOwner
        ? undefined
        : await readMutationState(workspace);
      if (previousOwner !== "sqlite-v1")
        await recoverRefresh(
          workspace,
          transactionPath,
          sameStorage ?? undefined,
          options,
          fence,
          mutationState,
        );
      const repositoryIndexed = previousOwner
        ? sameStorage?.kind !== "pending" || sameStorage.indexRefresh !== false
        : Boolean(sameStorage || mutationState?.repositoryIndexed);
      return withSelectedMutationJournal(
        workspace,
        transactionPath,
        "sqlite-v1",
        async (journal) => {
          const lifecycle = new LanceMutationLifecycle(
            undefined,
            workspace,
            refreshMutationIntelligence,
            {
              ...options,
              fence,
              journal,
              skipUnindexedRefresh: !repositoryIndexed,
              refreshMarker: {
                background: repositoryIndexed,
                config: await currentConfig(),
                journal: "sqlite-v1",
                publishedGenerationId: mutationState?.publishedGenerationId,
                transactionPath,
              },
            },
          );
          await lifecycle.recover();
          if (
            sameStorage?.kind === "pending" &&
            sameStorage.indexRefresh === false &&
            sameStorage.inFlight !== false
          )
            await markRefreshReady(transactionPath, sameStorage.epoch);
          options.signal?.throwIfAborted();
          return withMutationLifecycle(lifecycle, operation);
        },
        {
          requireExisting: previousOwner === "sqlite-v1",
          journalMode: "delete",
        },
      );
    },
  );
}

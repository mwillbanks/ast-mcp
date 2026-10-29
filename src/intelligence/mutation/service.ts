import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  open,
  type FileHandle,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

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
  releaseSnapshotCapture,
  removeSnapshotBlob,
  snapshotNamespace,
  sweepSnapshotBlobs,
  syncDirectory,
} from "../../runtime/snapshot-blob.ts";
import { createIdentity } from "../contracts/common.ts";
import { ParserWorkerPool } from "../parser/pool.ts";
import { LanceIntelligenceStore } from "../storage/store.ts";
import {
  currentWorkspace,
  type WorkspaceHandle,
} from "../workspace/context.ts";
export { ensurePrivateLockDirectory as ensureMutationLockDirectory } from "../../runtime/private-lock-directory.ts";
import { refreshMutationIntelligence } from "./freshness.ts";
import { LanceMutationJournal } from "./journal.ts";
import { activeMutationLifecycle, withMutationLifecycle } from "./lifecycle.ts";
import { lockPathIdentity, mutationSharedDatabasePath } from "./locks.ts";
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

async function recoveryHash(
  filePath: string,
  signal?: AbortSignal,
  retained?: FileHandle,
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
    const digest = await sha256Handle(handle, signal);
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

async function syncMutationFile(filePath: string): Promise<void> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("mutation_recovery_hash_mismatch");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncMutationPaths(
  workspace: WorkspaceHandle,
  files: readonly { filePath: string }[],
  fence: () => Promise<void>,
  requireCheckout = true,
  syncFiles = true,
): Promise<void> {
  const directories = new Set<string>();
  const root = await canonicalizePath(workspace.checkoutRoot);
  for (const { filePath } of files) {
    await fence();
    if (syncFiles)
      await syncMutationFile(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    let directory = await canonicalizePath(path.dirname(filePath));
    const withinCheckout = directory === root || pathWithin(root, directory);
    if (requireCheckout && !withinCheckout)
      throw new Error("mutation_path_outside_workspace");
    const boundary = withinCheckout ? root : path.parse(directory).root;
    for (; ; directory = path.dirname(directory)) {
      directories.add(directory);
      if (directory === boundary) break;
    }
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
  readonly inline = new Map<string, Buffer>();
  constructor(readonly namespace: string) {
    super();
  }
  async prepare(
    file: MutationJournalFile,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (file.sourceBlob) {
      if (file.sourceBlob.sha256 !== file.sourceSha256)
        throw new Error("mutation_recovery_material_mismatch");
      this.set(
        file.filePath,
        await openSnapshotBlob(file.sourceBlob, this.namespace, signal),
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
      await closeSnapshotHandles([...this.values(), ...this.targets.values()]);
    } finally {
      this.clear();
      this.targets.clear();
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
      await using materials = new RecoveryMaterials(
        snapshotNamespace(workspace),
      );
      // Validate every source and current target before the first recovery write.
      for (const file of record.files) {
        await materials.prepare(file, options.signal);
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
            const handle = await open(
              file.filePath,
              constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
            );
            materials.targets.set(file.filePath, handle);
            if (
              (await recoveryHash(file.filePath, options.signal, handle)) !==
              file.sourceSha256
            )
              throw new Error("mutation_recovery_hash_mismatch");
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
            output = await open(
              temporary,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            materials.targets.set(file.filePath, output);
            const actual = await output.stat();
            if (actual.dev !== identity.dev || actual.ino !== identity.ino)
              throw new Error("mutation_recovery_hash_mismatch");
          } else {
            output = await open(temporary, "wx+", 0o600);
            temporaryCreated = true;
            materials.targets.set(file.filePath, output);
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
            await link(temporary, file.filePath);
          } else {
            await rename(temporary, file.filePath);
          }
        } finally {
          if (temporaryCreated) await unlink(temporary).catch(() => undefined);
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
          await materials.targets.get(file.filePath)!.sync();
        }
      }
      await syncMutationPaths(workspace, record.files, fence, true, false);
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

  constructor(
    private readonly store: LanceIntelligenceStore,
    private readonly workspace: WorkspaceHandle,
    private readonly refresh: typeof refreshMutationIntelligence = refreshMutationIntelligence,
    private readonly options: {
      deadline?: Date | number;
      fence?: () => Promise<void>;
      refreshTimeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    this.journal = new LanceMutationJournal(store);
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
      plan.workspace.storageDomain.domainId !== this.store.domain.domainId
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
    await this.journal.begin(plan);
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
    await this.journal.transition(operationId, "refreshing");
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
    const parsers = new ParserWorkerPool({ minWorkers: 0, maxWorkers: 1 });
    try {
      const result = await this.refresh({
        parse: (request, options) => parsers.parse(request, options),
        signal,
        store: this.store,
        workspace: this.workspace,
      });
      signal.throwIfAborted();
      await this.options.fence?.();
      if (plan.files.some((file) => file.sourceBlob))
        await syncMutationPaths(
          this.workspace,
          plan.files,
          async () => {
            await this.options.fence?.();
          },
          false,
          // Attribute and text producers sync retained descriptors before closing.
          !["file_chattr", "file_patch", "file_write"].includes(plan.tool),
        );
      await this.journal.transition(operationId, "succeeded");
      this.#plans.delete(operationId);
      return result;
    } catch (error) {
      const failure =
        timeout.signal.aborted && !this.options.signal?.aborted
          ? timeoutError
          : error;
      await this.journal.transition(
        operationId,
        "recovery-required",
        errorCode(failure),
      );
      throw failure;
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
    if (plan.files.some((file) => file.sourceBlob))
      await syncMutationPaths(
        this.workspace,
        plan.files,
        async () => {
          await this.options.fence?.();
        },
        false,
        !["file_chattr", "file_patch", "file_write"].includes(plan.tool),
      );
    await this.journal.transition(operationId, "rolled-back");
    this.#plans.delete(operationId);
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

export async function withLanceMutationLifecycle<T>(
  operation: () => Promise<T>,
  options: {
    deadline?: Date | number;
    preview?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  if (options.preview || activeMutationLifecycle()) return operation();
  const workspace = currentWorkspace();
  if (!workspace) return operation();
  // Workspace IDs change with revision and overlay state. The checkout lock must
  // cover recovery and the entire transaction across requests and processes.
  const transactionPath = await mutationTransactionLockPath(
    workspace.checkoutRoot,
  );
  return withFileLock(
    transactionPath,
    async (lease) => {
      options.signal?.throwIfAborted();
      const store = await LanceIntelligenceStore.open(workspace.storageDomain);
      try {
        const indexed = await store.latestGeneration(workspace.workspaceId);
        // Overlay and configuration changes produce new workspace IDs. Retain
        // freshness when this repository already has a published manifest.
        const repositoryIndexed =
          indexed ||
          (
            await store.rows(
              "revision_manifests",
              `repository_id = '${workspace.repositoryId.replaceAll("'", "''")}'`,
              { limit: 1 },
            )
          ).length > 0;
        const refresh: typeof refreshMutationIntelligence = repositoryIndexed
          ? refreshMutationIntelligence
          : async () => ({
              dirtyOverlayId: workspace.dirtyOverlayId,
              generationId: null,
              indexedAt: new Date().toISOString(),
              parsedFiles: [],
              skippedFiles: [],
            });
        const lifecycle = new LanceMutationLifecycle(
          store,
          workspace,
          refresh,
          {
            deadline: options.deadline,
            fence: () => lease.fence(),
            signal: options.signal,
          },
        );
        await lifecycle.recover();
        options.signal?.throwIfAborted();
        return await withMutationLifecycle(lifecycle, operation);
      } finally {
        await store.shutdownCoordinator();
      }
    },
    {
      deadline: options.deadline ?? Date.now() + 10_000,
      signal: options.signal,
      sharedDatabasePath: await mutationSharedDatabasePath(
        workspace.checkoutRoot,
      ),
    },
  );
}

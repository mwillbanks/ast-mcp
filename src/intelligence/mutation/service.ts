import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { sha256 } from "../../runtime/hash.ts";
import { withFileLock, withFileLocks } from "../../runtime/locks.ts";
import { canonicalizePath, pathWithin } from "../../runtime/path-utils.ts";
import {
  ensurePrivateLockDirectory as ensureMutationLockDirectory,
  systemAccount,
} from "../../runtime/private-lock-directory.ts";
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
import type {
  MutationBatchPlan,
  MutationFileCommit,
  MutationJournalRecord,
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
    operationId: createIdentity("mutation-operation", input),
    storageDomainId: input.storageDomainId,
    workspaceId: input.workspaceId,
  });
}

async function assertRecoveryPath(
  workspace: WorkspaceHandle,
  filePath: string,
): Promise<void> {
  const canonicalRoot = await canonicalizePath(workspace.checkoutRoot);
  const canonicalTarget = await canonicalizePath(filePath);
  if (
    path.relative(canonicalRoot, canonicalTarget) === "" ||
    !pathWithin(canonicalRoot, canonicalTarget)
  )
    throw new Error("mutation_path_outside_workspace");
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
      const fencePath = async (filePath: string) => {
        await fence();
        await assertRecoveryPath(workspace, filePath);
      };
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
        if (file.sourceContentBase64 === null) {
          if (!exists) continue;
          const actual = sha256(await Bun.file(file.filePath).bytes());
          if (
            actual !== file.candidateSha256 &&
            actual !== file.committedSha256
          )
            throw new Error("mutation_recovery_hash_mismatch");
          await fencePath(file.filePath);
          await unlink(file.filePath);
          continue;
        }
        const source = Buffer.from(file.sourceContentBase64, "base64");
        if (sha256(source) !== file.sourceSha256)
          throw new Error("mutation_recovery_material_mismatch");
        if (exists) {
          const actual = sha256(await Bun.file(file.filePath).bytes());
          if (actual === file.sourceSha256) {
            if (file.sourceUid !== null && file.sourceGid !== null) {
              await fencePath(file.filePath);
              await chown(file.filePath, file.sourceUid, file.sourceGid);
            }
            if (file.sourceMode !== null) {
              await fencePath(file.filePath);
              await chmod(file.filePath, file.sourceMode);
            }
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
        await writeFile(temporary, source, {
          flag: "wx",
          mode:
            process.platform === "win32"
              ? undefined
              : (file.sourceMode ?? undefined),
        });
        try {
          if (file.sourceUid !== null && file.sourceGid !== null) {
            await fencePath(temporary);
            await chown(temporary, file.sourceUid, file.sourceGid);
          }
          if (file.sourceMode !== null) {
            await fencePath(temporary);
            await chmod(temporary, file.sourceMode);
          }
          await fencePath(file.filePath);
          await assertRecoveryPath(workspace, temporary);
          await rename(temporary, file.filePath);
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
      }
      for (const file of record.files) {
        await assertRecoveryPath(workspace, file.filePath);
        const exists = await lstat(file.filePath).then(
          () => true,
          () => false,
        );
        if (file.sourceSha256 === null) {
          if (exists) throw new Error("mutation_recovery_verification_failed");
        } else {
          if (!exists) throw new Error("mutation_recovery_verification_failed");
          const [actual, metadata] = await Promise.all([
            Bun.file(file.filePath)
              .bytes()
              .then((content) => sha256(content)),
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
        }
      }
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
    await this.journal.recover(
      this.workspace.workspaceId,
      (record) => restoreMutationRecord(this.workspace, record, this.options),
      checkoutRoot,
    );
    if (
      (await this.journal.unfinished(this.workspace.workspaceId, checkoutRoot))
        .length > 0
    )
      throw new Error("mutation_recovery_required");
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
    this.#plans.set(plan.operationId, plan);
    await this.journal.begin(plan);
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
    await this.journal.transition(operationId, "failed", errorCode(error));
  }

  async rolledBack(operationId: string): Promise<void> {
    if (!this.#plans.has(operationId)) return;
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
  const identity =
    process.platform === "win32" ? checkout.toLowerCase() : checkout;
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
    },
  );
}

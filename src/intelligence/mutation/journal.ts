import { isAbsolute, normalize, resolve } from "node:path";

import { z } from "zod";

import { canonicalizePath, pathWithin } from "../../runtime/path-utils.ts";
import {
  JobIdSchema,
  RevisionIdSchema,
  Sha256Schema,
  StorageDomainIdSchema,
  TimestampSchema,
  WorkspaceIdSchema,
} from "../contracts/common.ts";
import type { IntelligenceJob } from "../contracts/storage.ts";
import type { LanceIntelligenceStore } from "../storage/store.ts";
import type {
  MutationBatchPlan,
  MutationFileCommit,
  MutationJournalRecord,
  MutationJournalState,
} from "./types.ts";

const journalUpdates = new Map<string, Promise<void>>();

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

function persistentState(
  state: MutationJournalState,
): IntelligenceJob["state"] {
  if (state === "succeeded" || state === "recovered") return "succeeded";
  if (state === "rolled-back") return "cancelled";
  if (state === "failed" || state === "recovery-required") return "failed";
  return "running";
}

const CanonicalAbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && normalize(value) === value, {
    message: "Expected a canonical absolute path",
  });

const MutationJournalFileSchema = z
  .object({
    candidateSha256: Sha256Schema.nullable(),
    committedDeleted: z.boolean(),
    committedSha256: Sha256Schema.nullable(),
    filePath: CanonicalAbsolutePathSchema,
    sourceContentBase64: z
      .string()
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .nullable(),
    sourceGid: z.number().int().nonnegative().nullable(),
    sourceMode: z.number().int().nonnegative().nullable(),
    sourceSha256: Sha256Schema.nullable(),
    sourceUid: z.number().int().nonnegative().nullable(),
  })
  .strict();

const MutationJournalRecordSchema = z
  .object({
    attempt: z.number().int().nonnegative(),
    checkoutRoot: CanonicalAbsolutePathSchema.optional(),
    createdAt: TimestampSchema,
    errorCode: z.string().min(1).nullable(),
    // A rename journals both its source and destination for each request.
    files: z.array(MutationJournalFileSchema).max(100),
    operationId: JobIdSchema,
    revisionId: RevisionIdSchema,
    schemaVersion: z.literal("ast-mcp.mutation-journal.v1"),
    state: z.enum([
      "running",
      "refreshing",
      "succeeded",
      "failed",
      "rolled-back",
      "recovery-required",
      "recovered",
    ]),
    storageDomainId: StorageDomainIdSchema,
    tool: z.enum([
      "file_patch",
      "file_write",
      "file_delete",
      "file_rename",
      "file_chattr",
    ]),
    updatedAt: TimestampSchema,
    workspaceId: WorkspaceIdSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const limit = record.tool === "file_rename" ? 100 : 50;
    if (record.files.length > limit)
      context.addIssue({
        code: "custom",
        message: `Mutation journal permits at most ${limit} paths for ${record.tool}`,
        path: ["files"],
      });
  });

function parseRecord(
  value: unknown,
  required = false,
): MutationJournalRecord | null {
  if (typeof value !== "string") {
    if (required) throw new Error("mutation_journal_malformed");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    if (required) throw new Error("mutation_journal_malformed");
    return null;
  }
  if (
    !required &&
    (!parsed ||
      typeof parsed !== "object" ||
      ((parsed as { schemaVersion?: unknown }).schemaVersion !==
        "ast-mcp.mutation-journal.v1" &&
        !(
          "operationId" in parsed ||
          "checkoutRoot" in parsed ||
          "files" in parsed
        )))
  )
    return null;
  const result = MutationJournalRecordSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(`mutation_journal_malformed: ${result.error.message}`);
  return result.data;
}

/** Scope shared-store recovery before validating unrelated journal payloads. */
function recoveryRecord(
  value: unknown,
  workspaceId?: string,
  checkoutRoot?: string,
): MutationJournalRecord | null {
  if (!checkoutRoot) return parseRecord(value);
  let parsed: unknown;
  try {
    if (typeof value !== "string") throw new Error();
    parsed = JSON.parse(value);
  } catch {
    // Workspace identities change with overlays. A row's workspace_id alone
    // cannot prove that an opaque payload belongs to a different checkout.
    throw new Error("mutation_recovery_scope_unknown");
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error("mutation_journal_malformed");
  const envelope = parsed as Record<string, unknown>;
  if (
    envelope.schemaVersion !== "ast-mcp.mutation-journal.v1" &&
    !(
      typeof envelope.schemaVersion === "string" &&
      envelope.schemaVersion.startsWith("ast-mcp.mutation-journal.")
    ) &&
    ![
      "file_patch",
      "file_write",
      "file_delete",
      "file_rename",
      "file_chattr",
    ].includes(String(envelope.tool)) &&
    // These fields distinguish mutation records from ordinary intelligence
    // jobs, even when both mutation discriminators have been damaged.
    !(
      "operationId" in envelope ||
      "checkoutRoot" in envelope ||
      "files" in envelope
    )
  )
    return null;
  if (
    envelope.workspaceId === workspaceId ||
    envelope.checkoutRoot === checkoutRoot
  )
    return parseRecord(value, true);
  if (CanonicalAbsolutePathSchema.safeParse(envelope.checkoutRoot).success) {
    // A conflicting envelope cannot conceal paths in the current checkout.
    // Unrelated malformed payloads remain outside strict recovery validation.
    if (Array.isArray(envelope.files))
      for (const file of envelope.files) {
        const candidate =
          file && typeof file === "object" ? file.filePath : undefined;
        if (
          typeof candidate === "string" &&
          isAbsolute(candidate) &&
          pathWithin(checkoutRoot, resolve(candidate))
        )
          throw new Error("mutation_recovery_scope_unknown");
      }
    return null;
  }
  // Legacy records lack a checkout root. Only a complete set of canonical,
  // non-overlapping paths proves that their recovery is unrelated.
  if (!Array.isArray(envelope.files) || envelope.files.length === 0)
    throw new Error("mutation_recovery_scope_unknown");
  for (const file of envelope.files) {
    const candidate =
      file && typeof file === "object" ? file.filePath : undefined;
    if (
      !CanonicalAbsolutePathSchema.safeParse(candidate).success ||
      pathWithin(checkoutRoot, candidate)
    )
      throw new Error("mutation_recovery_scope_unknown");
  }
  return null;
}

export class LanceMutationJournal {
  constructor(
    private readonly store: LanceIntelligenceStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async begin(plan: MutationBatchPlan): Promise<MutationJournalRecord | null> {
    const workspace = plan.workspace;
    if (!workspace) return null;
    const timestamp = this.now().toISOString();
    const record: MutationJournalRecord = {
      attempt: 0,
      checkoutRoot: await canonicalizePath(workspace.checkoutRoot),
      createdAt: timestamp,
      errorCode: null,
      files: plan.files.map((file) => ({
        ...file,
        committedDeleted: false,
        committedSha256: null,
        sourceContentBase64: file.sourceContentBase64 ?? null,
        sourceGid: file.sourceGid ?? null,
        sourceMode: file.sourceMode ?? null,
        sourceUid: file.sourceUid ?? null,
      })),
      operationId: plan.operationId,
      revisionId: workspace.selectedRevision.revisionId,
      schemaVersion: "ast-mcp.mutation-journal.v1",
      state: "running",
      storageDomainId: workspace.storageDomain.domainId,
      tool: plan.tool,
      updatedAt: timestamp,
      workspaceId: workspace.workspaceId,
    };
    await this.write(record);
    return record;
  }

  async get(operationId: string): Promise<MutationJournalRecord | null> {
    const rows = await this.store.rows(
      "jobs",
      `job_id = ${sqlString(operationId)}`,
    );
    if (!rows[0]) return null;
    return parseRecord(rows[0].payload_json, true);
  }

  async committed(
    operationId: string,
    commit: MutationFileCommit,
  ): Promise<void> {
    await this.update(operationId, (record) => ({
      ...record,
      files: record.files.map((file) =>
        file.filePath === commit.filePath
          ? {
              ...file,
              committedDeleted: commit.deleted === true,
              committedSha256: commit.sha256,
            }
          : file,
      ),
      state: "running",
    }));
  }

  async transition(
    operationId: string,
    state: MutationJournalState,
    errorCode: string | null = null,
  ): Promise<void> {
    await this.update(operationId, (record) => ({
      ...record,
      errorCode,
      state,
    }));
  }

  async unfinished(
    workspaceId?: string,
    checkoutRoot?: string,
  ): Promise<MutationJournalRecord[]> {
    const rows = await this.store.rows(
      "jobs",
      checkoutRoot
        ? "state = 'running' OR state = 'failed'"
        : workspaceId
          ? `workspace_id = ${sqlString(workspaceId)}`
          : undefined,
    );
    return rows
      .map((row) => recoveryRecord(row.payload_json, workspaceId, checkoutRoot))
      .filter((record): record is MutationJournalRecord => Boolean(record))
      .filter(
        (record) =>
          ["running", "refreshing", "recovery-required"].includes(
            record.state,
          ) ||
          (record.state === "failed" &&
            record.files.some((file) => file.committedSha256 !== null)),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async recover(
    workspaceId: string,
    restore: (record: MutationJournalRecord) => Promise<void>,
    checkoutRoot?: string,
  ): Promise<readonly string[]> {
    const recovered: string[] = [];
    for (const record of await this.unfinished(workspaceId, checkoutRoot)) {
      try {
        const validated = MutationJournalRecordSchema.parse(record);
        if (
          validated.workspaceId !== workspaceId &&
          (!checkoutRoot || validated.checkoutRoot !== checkoutRoot)
        )
          throw new Error("mutation_workspace_mismatch");
        await restore(validated);
        await this.transition(record.operationId, "recovered");
        recovered.push(record.operationId);
      } catch (error) {
        await this.transition(
          record.operationId,
          "recovery-required",
          error instanceof Error ? error.name : "recovery_failed",
        );
      }
    }
    return recovered;
  }

  private async update(
    operationId: string,
    update: (record: MutationJournalRecord) => MutationJournalRecord,
  ): Promise<void> {
    // Serialize the complete read-modify-write, including updates through
    // separate journal objects sharing this process and storage directory.
    const key = `${this.store.storagePath}\0${operationId}`;
    const previous = journalUpdates.get(key) ?? Promise.resolve();
    const pending = previous.then(async () => {
      const current = await this.get(operationId);
      if (!current) throw new Error("mutation_journal_missing");
      await this.write({
        ...update(current),
        attempt: current.attempt + 1,
        updatedAt: this.now().toISOString(),
      });
    });
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    journalUpdates.set(key, settled);
    try {
      await pending;
    } finally {
      if (journalUpdates.get(key) === settled) journalUpdates.delete(key);
    }
  }

  private async write(record: MutationJournalRecord): Promise<void> {
    // Reject invalid records before they can poison durable recovery.
    MutationJournalRecordSchema.parse(record);
    await this.store.putRows(
      "jobs",
      [
        {
          attempt: record.attempt,
          created_at: record.createdAt,
          error_code: record.errorCode,
          idempotency_key: record.operationId,
          job_id: record.operationId,
          payload_json: JSON.stringify(record),
          revision_id: record.revisionId,
          state: persistentState(record.state),
          storage_domain_id: record.storageDomainId,
          type: "index-source",
          updated_at: record.updatedAt,
          workspace_id: record.workspaceId,
        },
      ],
      { immutable: false },
    );
  }
}

import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
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
    createdAt: TimestampSchema,
    errorCode: z.string().min(1).nullable(),
    files: z.array(MutationJournalFileSchema).max(50),
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
  .strict();

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
      (parsed as { schemaVersion?: unknown }).schemaVersion !==
        "ast-mcp.mutation-journal.v1")
  )
    return null;
  const result = MutationJournalRecordSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(`mutation_journal_malformed: ${result.error.message}`);
  return result.data;
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

  async unfinished(workspaceId?: string): Promise<MutationJournalRecord[]> {
    const rows = await this.store.rows(
      "jobs",
      workspaceId ? `workspace_id = ${sqlString(workspaceId)}` : undefined,
    );
    return rows
      .map((row) => parseRecord(row.payload_json))
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
  ): Promise<readonly string[]> {
    const recovered: string[] = [];
    for (const record of await this.unfinished(workspaceId)) {
      try {
        const validated = MutationJournalRecordSchema.parse(record);
        if (validated.workspaceId !== workspaceId)
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
    const current = await this.get(operationId);
    if (!current) throw new Error("mutation_journal_missing");
    await this.write({
      ...update(current),
      attempt: current.attempt + 1,
      updatedAt: this.now().toISOString(),
    });
  }

  private async write(record: MutationJournalRecord): Promise<void> {
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

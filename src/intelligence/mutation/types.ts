import type { WorkspaceHandle } from "../workspace/context.ts";

export type MutationTool =
  | "file_patch"
  | "file_write"
  | "file_delete"
  | "file_rename"
  | "file_chattr";

export interface MutationFilePlan {
  candidateSha256: string | null;
  filePath: string;
  sourceContentBase64?: string | null;
  sourceGid?: number | null;
  sourceMode?: number | null;
  sourceSha256: string | null;
  sourceUid?: number | null;
}

export interface MutationBatchPlan {
  files: readonly MutationFilePlan[];
  operationId: string;
  tool: MutationTool;
  workspace: WorkspaceHandle | null;
}

export interface MutationFileCommit {
  deleted?: boolean;
  filePath: string;
  sha256: string;
}

export interface MutationRefreshResult {
  dirtyOverlayId: string | null;
  generationId: string | null;
  indexedAt: string;
  parsedFiles: readonly string[];
  skippedFiles: readonly string[];
}

export interface MutationLifecycle {
  begin(plan: MutationBatchPlan): Promise<void>;
  committed(operationId: string, file: MutationFileCommit): Promise<void>;
  complete(
    operationId: string,
    files: readonly MutationFileCommit[],
  ): Promise<MutationRefreshResult | null>;
  failed(operationId: string, error: unknown): Promise<void>;
  rolledBack(operationId: string): Promise<void>;
}

export interface MutationJournalFile extends MutationFilePlan {
  committedDeleted: boolean;
  committedSha256: string | null;
  sourceContentBase64: string | null;
  sourceGid: number | null;
  sourceMode: number | null;
  sourceUid: number | null;
}

export type MutationJournalState =
  | "running"
  | "refreshing"
  | "succeeded"
  | "failed"
  | "rolled-back"
  | "recovery-required"
  | "recovered";

export interface MutationJournalRecord {
  attempt: number;
  createdAt: string;
  errorCode: string | null;
  files: readonly MutationJournalFile[];
  operationId: string;
  revisionId: string;
  schemaVersion: "ast-mcp.mutation-journal.v1";
  state: MutationJournalState;
  storageDomainId: string;
  tool: MutationTool;
  updatedAt: string;
  workspaceId: string;
}

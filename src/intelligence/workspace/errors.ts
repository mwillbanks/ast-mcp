export type WorkspaceErrorCode =
  | "workspace_ambiguous"
  | "workspace_mismatch"
  | "workspace_not_found"
  | "workspace_revision_invalid"
  | "workspace_read_only"
  | "workspace_git_failure";

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";

  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    readonly details?: unknown,
    readonly retryable = false,
    readonly suggestedNextCall?: string,
  ) {
    super(message);
  }
}

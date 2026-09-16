export class StorageError extends Error {
  constructor(
    readonly code:
      | "coordinator_unavailable"
      | "immutable_conflict"
      | "invalid_schema"
      | "mixed_generation"
      | "network_filesystem_unsupported"
      | "publication_abandoned"
      | "publication_conflict"
      | "publication_finalized"
      | "publication_not_found"
      | "publication_stale"
      | "relocation_verification_failed"
      | "retry_exhausted"
      | "storage_unavailable",
    message: string,
    readonly retryable: boolean,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export function isRetryableLanceError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /commit conflict|conflict detected|concurrent write|retry transaction|transaction conflict/i.test(
    error.message,
  );
}

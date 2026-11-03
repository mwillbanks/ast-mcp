import type { SqlAdapterRequest } from "../../src/runtime/sql-assistance";

export function sqlRequest(
  source = "SELECT 1;",
  extra: Partial<SqlAdapterRequest> = {},
): SqlAdapterRequest {
  return {
    source,
    dialect: "postgresql",
    signal: new AbortController().signal,
    ...extra,
  };
}

import { parentPort } from "node:worker_threads";

import { hasSqlDetails, parse } from "libpg-query";

import type { SqlAdapterResult } from "./sql-assistance";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined {
  return typeof value === "object" && value !== null
    ? (value as ObjectValue)
    : undefined;
}

function hasUnsupportedBodies(value: unknown): boolean {
  const result = object(value);
  const statements = Array.isArray(result?.stmts) ? result.stmts : [];
  return statements.some((statement) => {
    const stmt = object(object(statement)?.stmt);
    return (
      !stmt ||
      stmt.DoStmt !== undefined ||
      stmt.CreateFunctionStmt !== undefined
    );
  });
}

function failureDiagnostic(
  source: string,
  error: unknown,
): SqlAdapterResult["diagnostics"] {
  if (!hasSqlDetails(error)) return undefined;
  const position = error.sqlDetails?.cursorPosition;
  if (!Number.isSafeInteger(position) || position! < 0) return undefined;
  // PostgreSQL reports zero-based Unicode character positions, not byte offsets.
  let characters = 0;
  let utf16Offset = 0;
  for (const character of source) {
    if (characters++ >= position!) break;
    utf16Offset += character.length;
  }
  const prefix = source.slice(0, utf16Offset);
  const lines = prefix.split("\n");
  return [
    {
      message: "SQL syntax rejected by the selected validator",
      line: lines.length - 1,
      column: Array.from(lines.at(-1) ?? "").length,
      offset: Buffer.byteLength(prefix),
    },
  ];
}

parentPort?.once("message", async (request: { source: string }) => {
  let result: SqlAdapterResult;
  try {
    const parsed = await parse(request.source);
    result = hasUnsupportedBodies(parsed)
      ? { status: "unsupported", complete: false, scope: "sql" }
      : { status: "valid", complete: true, scope: "sql" };
  } catch (error) {
    result = hasSqlDetails(error)
      ? {
          status: "invalid",
          complete: true,
          scope: "sql",
          diagnostics: failureDiagnostic(request.source, error),
        }
      : { status: "unavailable", complete: false, scope: "sql" };
  }
  parentPort?.postMessage(result);
  parentPort?.close();
});

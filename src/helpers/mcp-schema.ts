import * as z from "zod/v4";

import { InputRequiredSignal } from "../runtime/approval";
import { FILE_READ_MAX_BATCH } from "../runtime/file-read";

export const chattrSchema = z.object({
  chmod: z.number().int().min(0).max(0o777).optional(),
  chown: z
    .object({
      gid: z.number().int().nonnegative(),
      uid: z.number().int().nonnegative(),
    })
    .optional(),
});

export function boundedRecord<T extends z.ZodType>(schema: T, label: string) {
  return z.record(z.string().min(1), schema).refine((value) => {
    const size = Object.keys(value).length;
    return size > 0 && size <= FILE_READ_MAX_BATCH;
  }, label);
}

export function boundedFileBatch<T extends z.ZodType>(
  schema: T,
  label: string,
) {
  return z.object({ files: boundedRecord(schema, label) }).strict();
}

function failureCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const error = value as { code?: unknown; name?: unknown };
  if (error.name === "AbortError") return "aborted";
  if (error.name === "TimeoutError") return "timeout";
  return typeof error.code === "string" &&
    error.code.length <= 64 &&
    /^[A-Za-z][A-Za-z0-9_.-]*$/.test(error.code)
    ? error.code
    : undefined;
}

// Nested errors can contain source or credentials in messages. Expose only
// bounded machine diagnostics and explicitly identified filesystem paths.
function aggregateDiagnostics(error: AggregateError) {
  const causes: Array<{ code: string; name: string }> = [];
  const affectedPaths = new Set<string>();
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  let visited = 0;
  let omitted = false;
  while (pending.length && visited < 32) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    visited++;
    const value = item as {
      name?: unknown;
      details?: unknown;
      cause?: unknown;
      path?: unknown;
    };
    if (item !== error && causes.length >= 16) omitted = true;
    if (item !== error && causes.length < 16)
      causes.push({
        code: failureCode(item) ?? "execution_failed",
        name:
          typeof value.name === "string" &&
          [
            "Error",
            "AggregateError",
            "TypeError",
            "RangeError",
            "SyntaxError",
            "ReferenceError",
            "URIError",
            "EvalError",
            "AbortError",
            "TimeoutError",
          ].includes(value.name)
            ? value.name
            : "Error",
      });
    const details = value.details as { affectedPaths?: unknown } | undefined;
    const paths = Array.isArray(details?.affectedPaths)
      ? details.affectedPaths
      : [];
    if (paths.length > 20) omitted = true;
    for (const path of [...paths.slice(0, 20), value.path]) {
      if (path === undefined) continue;
      if (typeof path !== "string" || path.length > 1024) {
        omitted = true;
      } else if (!affectedPaths.has(path)) {
        if (affectedPaths.size < 20) affectedPaths.add(path);
        else omitted = true;
      }
    }
    if (item instanceof AggregateError) {
      if (item.errors.length > 16) omitted = true;
      pending.push(...item.errors.slice(0, 16));
    }
    if (value.cause) pending.push(value.cause);
  }
  return {
    affectedPaths: [...affectedPaths],
    causes,
    truncated: omitted || pending.length > 0,
  };
}

export function toolFailure(error: unknown) {
  if (error instanceof InputRequiredSignal) return error.result;
  const value = (error ?? {}) as Error & {
    code?: unknown;
    decision?: unknown;
    details?: unknown;
    retryable?: boolean;
    suggestedNextCall?: string;
  };
  const message = error instanceof Error ? error.message : String(error);
  const normalizedCode = failureCode(value);
  const operatingSystemCode =
    normalizedCode === "EACCES" || normalizedCode === "EPERM"
      ? "permission_denied"
      : normalizedCode === "ENOENT"
        ? "file_not_found"
        : undefined;
  const code =
    operatingSystemCode ??
    normalizedCode ??
    (/(?:hash|expectedSha256|stale file context)/i.test(message)
      ? "stale_or_missing_hash"
      : /format/i.test(message)
        ? "format_failed"
        : /match/i.test(message)
          ? "match_count"
          : "execution_failed");
  const suggestedNextCall =
    value.suggestedNextCall ??
    (code === "stale_or_missing_hash"
      ? "file_hash"
      : code === "match_count"
        ? "file_patch with preview=true"
        : undefined);
  const structuredContent = {
    error: {
      code,
      details:
        error instanceof AggregateError
          ? aggregateDiagnostics(error)
          : (value.details ??
            value.decision ??
            (operatingSystemCode ? { osCode: normalizedCode } : undefined)),
      message,
      retryable:
        value.retryable ??
        ["stale_or_missing_hash", "match_count", "approval_required"].includes(
          code,
        ),
      suggestedNextCall,
    },
    ok: false,
  };
  return {
    content: [
      { text: JSON.stringify(structuredContent), type: "text" as const },
    ],
    isError: true,
    structuredContent,
  };
}

export function toolSuccess<T>(data: T) {
  const structuredContent = { data, ok: true as const };
  return {
    content: [{ text: JSON.stringify(data), type: "text" as const }],
    structuredContent,
  };
}

type UpstreamToolResult = {
  content?: Array<{ text?: string; type: string }>;
  isError?: boolean;
  [key: string]: unknown;
};

export function structuredUpstreamToolResult<T extends UpstreamToolResult>(
  result: T,
  suggestedNextCall: string,
) {
  if (!result.isError)
    return { ...result, structuredContent: { data: result, ok: true } };
  const message =
    result.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n") || "Upstream tool failed";
  return {
    ...result,
    structuredContent: {
      error: {
        code: "upstream_tool_error",
        message,
        retryable: true,
        suggestedNextCall,
      },
      ok: false,
    },
  };
}

export const toolOutputSchema = z
  .object({
    data: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        details: z.unknown().optional(),
        message: z.string(),
        retryable: z.boolean(),
        suggestedNextCall: z.string().optional(),
      })
      .strict()
      .optional(),
    ok: z.boolean(),
  })
  .strict();

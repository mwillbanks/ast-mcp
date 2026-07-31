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

export function toolFailure(error: unknown) {
  if (error instanceof InputRequiredSignal) return error.result;
  const value = error as Error & {
    code?: string;
    decision?: unknown;
    details?: unknown;
    retryable?: boolean;
    suggestedNextCall?: string;
  };
  const message = error instanceof Error ? error.message : String(error);
  const code =
    value.code ??
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
      details: value.details ?? value.decision,
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

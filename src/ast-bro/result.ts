export interface AstBroResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: Upstream JSON schemas are intentionally dynamic at this boundary.
type AstBroJson = Record<string, any>;

import { parseTextResultJson } from "../helpers/json";
export function parseAstBroJson(result: AstBroResult): AstBroJson {
  return parseTextResultJson(result);
}

export interface AstBroShowMatch {
  end_line: number;
  kind: string;
  qualified_name: string;
  source: string;
  start_line: number;
}

export interface AstBroShowV2 {
  files: Array<{
    language: string;
    matches: AstBroShowMatch[];
    path: string;
  }>;
  files_matched: number;
  files_scanned: number;
  schema: "ast-bro.show.v2";
  shown: number;
  symbols: string[];
  total: number;
  truncated: boolean;
  unmatched: string[];
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function showMatch(value: unknown): value is AstBroShowMatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const match = value as Record<string, unknown>;
  return (
    typeof match.qualified_name === "string" &&
    typeof match.kind === "string" &&
    nonnegativeInteger(match.start_line) &&
    nonnegativeInteger(match.end_line) &&
    match.end_line >= match.start_line &&
    typeof match.source === "string"
  );
}

export function parseAstBroShowV2(result: AstBroResult): AstBroShowV2 {
  const payload = parseAstBroJson(result);
  const files = payload.files;
  const validFiles =
    Array.isArray(files) &&
    files.every(
      (file) =>
        file &&
        typeof file === "object" &&
        !Array.isArray(file) &&
        typeof file.path === "string" &&
        typeof file.language === "string" &&
        Array.isArray(file.matches) &&
        file.matches.every(showMatch),
    );
  if (
    payload.schema !== "ast-bro.show.v2" ||
    !stringArray(payload.symbols) ||
    !stringArray(payload.unmatched) ||
    !validFiles ||
    !nonnegativeInteger(payload.files_scanned) ||
    !nonnegativeInteger(payload.files_matched) ||
    payload.files_matched > payload.files_scanned ||
    !nonnegativeInteger(payload.total) ||
    !nonnegativeInteger(payload.shown) ||
    payload.shown > payload.total ||
    typeof payload.truncated !== "boolean"
  )
    throw new Error("Invalid ast-bro.show.v2 response");
  return payload as AstBroShowV2;
}

export function astBroMatchFiles(result: AstBroResult): string[] {
  const payload = parseAstBroJson(result);
  return [
    ...new Set<string>(
      (payload.matches ?? [])
        .map((match: { file?: unknown }) => match.file)
        .filter((file: unknown): file is string => typeof file === "string"),
    ),
  ];
}

export function astBroRewrittenFiles(result: AstBroResult): string[] {
  const payload = parseAstBroJson(result);
  return [
    ...new Set<string>(
      (payload.files ?? [])
        .filter((file: { status?: unknown }) => file.status === "rewritten")
        .map((file: { file?: unknown }) => file.file)
        .filter((file: unknown): file is string => typeof file === "string"),
    ),
  ];
}

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

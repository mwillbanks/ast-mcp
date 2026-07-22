import path from "node:path";

import { callAstBro } from "./client";
import { parseAstBroJson } from "./result";

export async function astCapable(
  filePath: string,
  language?: string,
): Promise<boolean> {
  if (!language) return false;
  const result = await callAstBro(
    "map",
    { json: true, paths: [filePath] },
    path.dirname(filePath),
  );
  const payload = parseAstBroJson(result);
  const file = (payload.files ?? []).find(
    (candidate: { path?: unknown }) => candidate.path === filePath,
  );
  return file?.error_count === 0;
}

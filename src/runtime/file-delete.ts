import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { astCapable } from "../ast-bro/capability";
import { callAstBro } from "../ast-bro/client";
import { parseAstBroJson } from "../ast-bro/result";
import { detectAstLanguage } from "../patch/languages";
import { sha256 } from "./hash";
import { withFileLocks } from "./locks";
import { resolveWritablePath, rootForPath } from "./paths";

export interface FileDeleteRequest {
  expectedSha256: string;
  forceReferences?: boolean;
}

export type FileDeleteBatch = Record<string, FileDeleteRequest>;

async function importersFor(filePath: string, root: string): Promise<string[]> {
  const language = detectAstLanguage(filePath);
  if (!(await astCapable(filePath, language))) return [];
  const result = parseAstBroJson(
    await callAstBro(
      "reverse_deps",
      { file: path.relative(root, filePath), json: true },
      root,
    ),
  );
  return (result.importers ?? [])
    .map((item: { file?: unknown }) => item.file)
    .filter((file: unknown): file is string => typeof file === "string");
}

async function emptyParents(filePath: string, root: string) {
  const removedDirectories: string[] = [];
  let directory = path.dirname(filePath);
  while (true) {
    const relative = path.relative(root, directory);
    if (
      directory === root ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    )
      break;
    if ((await readdir(directory)).length !== 0) break;
    await rmdir(directory);
    removedDirectories.push(directory);
    directory = path.dirname(directory);
  }
  return removedDirectories;
}

export async function deleteFilesSafely(requests: FileDeleteBatch) {
  const entries = await Promise.all(
    Object.entries(requests).map(async ([inputPath, request]) => {
      const filePath = await resolveWritablePath(inputPath);
      const metadata = await lstat(filePath);
      if (!metadata.isFile())
        throw new Error(`file_delete accepts files only: ${inputPath}`);
      const root = await rootForPath(filePath);
      const importers = await importersFor(filePath, root);
      if (importers.length > 0 && !request.forceReferences)
        throw new Error(
          `file_delete rejected ${inputPath}: referenced by ${importers.join(", ")}; set forceReferences to override`,
        );
      return { filePath, importers, request, root };
    }),
  );
  const files = await withFileLocks(
    entries.map(({ filePath }) => filePath),
    async () => {
      const deleted: Record<string, unknown> = {};
      for (const { filePath, request } of entries) {
        const content = await Bun.file(filePath).text();
        const actual = sha256(content);
        if (actual !== request.expectedSha256)
          throw new Error(
            `Stale file context: expected ${request.expectedSha256}, found ${actual}`,
          );
      }
      for (const { filePath, importers, request } of entries) {
        await rm(filePath);
        deleted[filePath] = {
          deleted: true,
          forcedReferences:
            importers.length > 0 && request.forceReferences === true,
        };
      }
      return deleted;
    },
  );
  const removedDirectories = new Set<string>();
  for (const { filePath, root } of entries)
    for (const directory of await emptyParents(filePath, root))
      removedDirectories.add(directory);
  return { files, removedDirectories: [...removedDirectories].sort() };
}

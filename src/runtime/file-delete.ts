import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { astCapable } from "../ast-bro/capability";
import { callAstBro } from "../ast-bro/client";
import { parseAstBroJson } from "../ast-bro/result";
import { currentConfig } from "../config";
import { detectAstLanguage } from "../patch/languages";
import { sha256File } from "./hash";
import { withFileLocks } from "./locks";
import { assertReadableTree } from "./path-policy";
import {
  referenceRootForPath,
  resolveWritablePath,
  rootForPath,
} from "./paths";
import { requireExpectedHash, verifyExpectedHash } from "./policy";

export interface FileDeleteRequest {
  expectedSha256?: string;
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

function ancestorPaths(filePath: string, root: string): string[] {
  const ancestors: string[] = [];
  let directory = path.dirname(filePath);
  while (true) {
    const relative = path.relative(root, directory);
    if (
      directory === root ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    )
      break;
    ancestors.push(directory);
    directory = path.dirname(directory);
  }
  return ancestors;
}

async function authorizedAncestors(filePath: string, root: string) {
  return new Set(
    await Promise.all(
      ancestorPaths(filePath, root).map((directory) =>
        resolveWritablePath(directory, "delete"),
      ),
    ),
  );
}

async function emptyParents(
  filePath: string,
  root: string,
  authorized: Set<string>,
) {
  const removedDirectories: string[] = [];
  for (const directory of ancestorPaths(filePath, root)) {
    if (!authorized.has(directory))
      throw new Error(`Directory deletion was not preflighted: ${directory}`);
    const contents = await readdir(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (contents?.length !== 0) break;
    await rmdir(directory);
    removedDirectories.push(directory);
  }
  return removedDirectories;
}

function requireVerifiableReferences(
  referenceRoot: string | undefined,
  capable: boolean,
  inputPath: string,
  forceReferences: boolean | undefined,
): void {
  if (referenceRoot || !capable || forceReferences) return;
  throw new Error(
    `file_delete rejected ${inputPath}: references cannot be verified outside configured file-operation roots; set forceReferences to override`,
  );
}

async function authorizedImporters(
  filePath: string,
  referenceRoot: string | undefined,
  capable: boolean,
) {
  if (!referenceRoot || !capable) return [];
  assertReadableTree(await currentConfig(), referenceRoot);
  return importersFor(filePath, referenceRoot);
}

function requireUnreferenced(
  importers: string[],
  inputPath: string,
  forceReferences: boolean | undefined,
): void {
  if (importers.length === 0 || forceReferences) return;
  throw new Error(
    `file_delete rejected ${inputPath}: referenced by ${importers.join(", ")}; set forceReferences to override`,
  );
}

async function referenceStatus(
  filePath: string,
  inputPath: string,
  request: FileDeleteRequest,
) {
  const referenceRoot = await referenceRootForPath(filePath);
  const language = detectAstLanguage(filePath);
  const capable = await astCapable(filePath, language);
  requireVerifiableReferences(
    referenceRoot,
    capable,
    inputPath,
    request.forceReferences,
  );
  const importers = await authorizedImporters(filePath, referenceRoot, capable);
  requireUnreferenced(importers, inputPath, request.forceReferences);
  return { importers, referencesVerified: referenceRoot !== undefined };
}

async function prepareDeleteEntry(
  inputPath: string,
  request: FileDeleteRequest,
) {
  const filePath = await resolveWritablePath(inputPath, "delete");
  const metadata = await lstat(filePath);
  if (!metadata.isFile())
    throw new Error(`file_delete accepts files only: ${inputPath}`);
  const root = await rootForPath(filePath);
  const removableDirectories = await authorizedAncestors(filePath, root);
  return {
    filePath,
    ...(await referenceStatus(filePath, inputPath, request)),
    removableDirectories,
    request,
    root,
  };
}

export async function deleteFilesSafely(requests: FileDeleteBatch) {
  const entries = await Promise.all(
    Object.entries(requests).map(([inputPath, request]) =>
      prepareDeleteEntry(inputPath, request),
    ),
  );
  const files = await withFileLocks(
    entries.map(({ filePath }) => filePath),
    async () => {
      const deleted: Record<string, unknown> = {};
      for (const { filePath, request } of entries) {
        const actual = await sha256File(filePath);
        await requireExpectedHash(request.expectedSha256, "file_delete");
        verifyExpectedHash(request.expectedSha256, actual);
      }
      for (const {
        filePath,
        importers,
        referencesVerified,
        request,
      } of entries) {
        await rm(filePath);
        deleted[filePath] = {
          deleted: true,
          forcedReferences:
            importers.length > 0 && request.forceReferences === true,
          referenceVerificationBypassed:
            !referencesVerified && request.forceReferences === true,
        };
      }
      return deleted;
    },
  );
  const removedDirectories = new Set<string>();
  for (const { filePath, removableDirectories, root } of entries)
    for (const directory of await emptyParents(
      filePath,
      root,
      removableDirectories,
    ))
      removedDirectories.add(directory);
  return { files, removedDirectories: [...removedDirectories].sort() };
}

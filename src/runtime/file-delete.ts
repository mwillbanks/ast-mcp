import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  readdir,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { currentConfig } from "../config";
import {
  beginMutation,
  completeMutation,
  failMutation,
  mutationOperationId,
  recordMutationCommit,
  recordMutationRollback,
} from "../intelligence/mutation/index.ts";
import { parseSource } from "../intelligence/parser/index.ts";
import { currentWorkspace } from "../intelligence/workspace/context.ts";
import { detectAstLanguage } from "../patch/languages";
import { inspectFileCapabilities } from "./file-capabilities";
import { readFileSnapshot } from "./file-snapshot";
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
  const importers: string[] = [];
  const target = path.resolve(filePath);
  for await (const candidate of new Bun.Glob("**/*").scan({
    absolute: true,
    cwd: root,
    dot: false,
    followSymlinks: false,
    onlyFiles: true,
  })) {
    if (
      candidate === target ||
      candidate.includes(`${path.sep}node_modules${path.sep}`) ||
      candidate.includes(`${path.sep}.git${path.sep}`)
    )
      continue;
    const capabilities = await inspectFileCapabilities(candidate);
    if (!capabilities.language || !capabilities.effective.read.includes("ast"))
      continue;
    const source = await readFile(candidate, "utf8");
    const facts = parseSource({
      languageId: capabilities.language,
      source,
    });
    const referenced = facts.imports.some((entry) => {
      if (!entry.source.startsWith(".")) return false;
      const base = path.resolve(path.dirname(candidate), entry.source);
      return (
        base === target ||
        `${base}${path.extname(target)}` === target ||
        path.join(base, `index${path.extname(target)}`) === target
      );
    });
    if (referenced) importers.push(path.relative(root, candidate));
  }
  return importers.sort();
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

async function ignoreFailure(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {}
}

async function emptyParents(
  filePath: string,
  root: string,
  authorized: Set<string>,
  fence: () => Promise<void>,
) {
  const removedDirectories: string[] = [];
  for (const directory of ancestorPaths(filePath, root)) {
    if (!authorized.has(directory))
      throw new Error(`Directory deletion was not preflighted: ${directory}`);
    let contents: string[] | undefined;
    try {
      contents = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (contents?.length !== 0) break;
    await fence();
    try {
      await rmdir(directory);
      removedDirectories.push(directory);
    } catch (error) {
      if (
        ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        break;
      throw error;
    }
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
  const capabilities = await inspectFileCapabilities(filePath, language);
  const capable = capabilities.effective.read.includes("ast");
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
  const outcome = await withFileLocks(
    entries.map(({ filePath }) => filePath),
    async (leases) => {
      const fence = async () => {
        for (const lease of leases) await lease.fence();
      };
      const snapshots = new Map<
        string,
        Awaited<ReturnType<typeof readFileSnapshot>>
      >();
      for (const { filePath, request } of entries) {
        const snapshot = await readFileSnapshot(filePath);
        await requireExpectedHash(request.expectedSha256, "file_delete");
        verifyExpectedHash(request.expectedSha256, snapshot.sha256);
        snapshots.set(filePath, snapshot);
      }
      const workspace = currentWorkspace() ?? null;
      const sourcePlan = entries.map(({ filePath }) => {
        const snapshot = snapshots.get(filePath);
        return {
          candidateSha256: null,
          filePath,
          sourceContentBase64: snapshot?.content.toString("base64") ?? null,
          sourceGid:
            process.platform === "win32" ? null : (snapshot?.gid ?? null),
          sourceMode: snapshot?.mode ?? null,
          sourceSha256: snapshot?.sha256 ?? null,
          sourceUid:
            process.platform === "win32" ? null : (snapshot?.uid ?? null),
        };
      });
      const operationId = workspace
        ? mutationOperationId({
            files: sourcePlan,
            nonce: randomUUID(),
            storageDomainId: workspace.storageDomain.domainId,
            workspaceId: workspace.workspaceId,
          })
        : randomUUID();
      const commits: Array<{
        deleted: true;
        filePath: string;
        sha256: string;
      }> = [];
      let began = false;
      try {
        await beginMutation({
          files: sourcePlan,
          operationId,
          tool: "file_delete",
          workspace,
        });
        began = true;
        const files: Record<string, unknown> = {};
        for (const {
          filePath,
          importers,
          referencesVerified,
          request,
        } of entries) {
          await fence();
          await rm(filePath);
          const snapshot = snapshots.get(filePath);
          if (!snapshot) throw new Error("mutation_snapshot_missing");
          const commit = {
            deleted: true as const,
            filePath,
            sha256: snapshot.sha256,
          };
          commits.push(commit);
          await recordMutationCommit(operationId, commit);
          files[filePath] = {
            deleted: true,
            forcedReferences:
              importers.length > 0 && request.forceReferences === true,
            referenceVerificationBypassed:
              !referencesVerified && request.forceReferences === true,
          };
        }
        const intelligenceRefresh = await completeMutation(
          operationId,
          commits,
        );
        return {
          files,
          ...(intelligenceRefresh ? { intelligenceRefresh } : {}),
        };
      } catch (error) {
        if (began) await ignoreFailure(failMutation(operationId, error));
        const rollbackErrors: unknown[] = [];
        for (const commit of [...commits].reverse()) {
          const snapshot = snapshots.get(commit.filePath);
          if (!snapshot) continue;
          try {
            await fence();
            await writeFile(commit.filePath, snapshot.content, { flag: "wx" });
            if (process.platform !== "win32") {
              await fence();
              await chown(commit.filePath, snapshot.uid, snapshot.gid);
            }
            await fence();
            await chmod(commit.filePath, snapshot.mode);
            const [restoredSha256, restoredMetadata] = await Promise.all([
              sha256File(commit.filePath),
              lstat(commit.filePath),
            ]);
            if (
              restoredSha256 !== snapshot.sha256 ||
              (restoredMetadata.mode & 0o7777) !== (snapshot.mode & 0o7777) ||
              (process.platform !== "win32" &&
                (restoredMetadata.uid !== snapshot.uid ||
                  restoredMetadata.gid !== snapshot.gid))
            )
              throw new Error("file_delete_rollback_verification_failed");
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (began && rollbackErrors.length === 0)
          await ignoreFailure(recordMutationRollback(operationId));
        if (rollbackErrors.length > 0)
          throw new AggregateError(
            [error, ...rollbackErrors],
            "file_delete failed and rollback requires recovery",
          );
        throw error;
      }
    },
  );
  const roots = [...new Set(entries.map(({ root }) => root))].sort();
  const removedDirectories = await withFileLocks(
    roots.map((root) => path.join(root, ".ast-mcp-directory-cleanup")),
    async (leases) => {
      const fence = async () => {
        for (const lease of leases) await lease.fence();
      };
      const removed = new Set<string>();
      for (const { filePath, removableDirectories, root } of entries)
        for (const directory of await emptyParents(
          filePath,
          root,
          removableDirectories,
          fence,
        ))
          removed.add(directory);
      return [...removed].sort();
    },
  );
  return { ...outcome, removedDirectories };
}

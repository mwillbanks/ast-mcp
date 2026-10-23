import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  opendir,
  readdir,
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
import { ParserWorkerPool } from "../intelligence/parser/index.ts";
import { currentWorkspace } from "../intelligence/workspace/context.ts";
import { detectAstLanguage } from "../patch/languages";
import { readFileSnapshot } from "./file-snapshot";
import { sha256File } from "./hash";
import { withFileLocks } from "./locks";
import { assertReadableTree } from "./path-policy";
import { pathWithin } from "./path-utils";
import {
  fileOperationRootForPath,
  referenceRootForPath,
  resolveWritablePath,
} from "./paths";
import { requireExpectedHash, verifyExpectedHash } from "./policy";

export interface FileDeleteRequest {
  expectedSha256?: string;
  forceReferences?: boolean;
}

export type FileDeleteBatch = Record<string, FileDeleteRequest>;

interface ReferenceVerification {
  pool: ParserWorkerPool;
  signal: AbortSignal;
  targets: Set<string>;
  candidates: number;
  sourceBytes: number;
}

function referenceFailure(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), {
    code: "reference_verification_failed",
    retryable: true,
    suggestedNextCall:
      "Review references before retrying file_delete with forceReferences",
  });
}

async function* referenceCandidates(
  root: string,
  verification: ReferenceVerification,
) {
  const { signal } = verification;
  const pending = [root];
  while (pending.length) {
    signal.throwIfAborted();
    for await (const entry of await opendir(pending.pop()!)) {
      signal.throwIfAborted();
      if (++verification.candidates > 100_000)
        throw referenceFailure(
          "Reference verification exceeds the inventory limit",
        );
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const candidate = path.join(entry.parentPath, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) yield candidate;
    }
  }
}

async function importersFor(
  filePath: string,
  root: string,
  verification: ReferenceVerification,
): Promise<string[]> {
  const importers: string[] = [];
  const target = path.resolve(filePath);
  try {
    for await (const candidate of referenceCandidates(root, verification)) {
      if (candidate === target || verification.targets.has(candidate)) continue;
      const language = detectAstLanguage(candidate);
      if (
        !language ||
        [".json", ".jsonc", ".toml", ".yaml", ".yml"].includes(
          path.extname(candidate).toLowerCase(),
        )
      )
        continue;
      const file = Bun.file(candidate);
      if (file.size > 2 * 1024 * 1024)
        throw referenceFailure(
          "Reference verification source exceeds the byte limit",
        );
      verification.signal.throwIfAborted();
      const stream = createReadStream(candidate, {
        end: 2 * 1024 * 1024,
        signal: verification.signal,
      });
      const chunks: Buffer[] = [];
      let bytes: Buffer;
      try {
        for await (const chunk of stream) {
          verification.signal.throwIfAborted();
          chunks.push(Buffer.from(chunk));
        }
        verification.signal.throwIfAborted();
        bytes = Buffer.concat(chunks);
      } finally {
        stream.destroy();
      }
      verification.sourceBytes += bytes.byteLength;
      if (
        bytes.byteLength > 2 * 1024 * 1024 ||
        verification.sourceBytes > 16 * 1024 * 1024
      )
        throw referenceFailure(
          "Reference verification exceeds the source byte limit",
        );
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const facts = await verification.pool.parse(
        {
          languageId: language,
          source,
        },
        { signal: verification.signal, timeoutMs: 1_000 },
      );
      if (
        facts.diagnostics.some((diagnostic) => diagnostic.severity === "error")
      )
        throw referenceFailure(
          "Reference verification encountered invalid source",
        );
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
  } catch (error) {
    throw referenceFailure(
      "Reference verification could not complete within parser, input, or inventory limits; no files were deleted",
      error,
    );
  }
  return importers.sort();
}

function ancestorPaths(filePath: string, root: string): string[] {
  const ancestors: string[] = [];
  let directory = path.dirname(filePath);
  while (true) {
    if (directory === root || !pathWithin(root, directory)) break;
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
  verification: ReferenceVerification,
) {
  if (!referenceRoot || !capable) return [];
  const config = await currentConfig();
  assertReadableTree(config, referenceRoot);
  if (!config.files.read.modes.includes("ast"))
    throw referenceFailure(
      "Reference verification requires AST read access; no files were deleted",
    );
  return importersFor(filePath, referenceRoot, verification);
}

function requireUnreferenced(
  importers: string[],
  inputPath: string,
  forceReferences: boolean | undefined,
): void {
  if (importers.length === 0 || forceReferences) return;
  throw new Error(
    `file_delete rejected ${inputPath}: referenced by ${importers.slice(0, 20).join(", ").slice(0, 4096)}${importers.length > 20 ? ` (showing 20 of ${importers.length})` : ""}; set forceReferences to override`,
  );
}

async function referenceStatus(
  filePath: string,
  inputPath: string,
  request: FileDeleteRequest,
  verification: ReferenceVerification,
) {
  const referenceRoot = await referenceRootForPath(filePath);
  // An explicit override bypasses advisory parsing, never existing authorization.
  if (request.forceReferences) {
    if (referenceRoot) assertReadableTree(await currentConfig(), referenceRoot);
    return { importers: [], referencesVerified: false };
  }
  const language = detectAstLanguage(filePath);
  // Reference eligibility depends on file identity, not a valid target AST.
  const capable = language !== undefined;
  requireVerifiableReferences(
    referenceRoot,
    capable,
    inputPath,
    request.forceReferences,
  );
  const importers = await authorizedImporters(
    filePath,
    referenceRoot,
    capable,
    verification,
  );
  requireUnreferenced(importers, inputPath, request.forceReferences);
  return { importers, referencesVerified: referenceRoot !== undefined };
}

async function prepareDeleteEntry(
  inputPath: string,
  request: FileDeleteRequest,
  verification: ReferenceVerification,
) {
  const filePath = await resolveWritablePath(inputPath, "delete");
  const metadata = await lstat(filePath);
  if (!metadata.isFile())
    throw new Error(`file_delete accepts files only: ${inputPath}`);
  const root = await fileOperationRootForPath(filePath);
  const removableDirectories = await authorizedAncestors(filePath, root);
  return {
    filePath,
    ...(await referenceStatus(filePath, inputPath, request, verification)),
    removableDirectories,
    request,
    root,
  };
}

export async function deleteFilesSafely(
  requests: FileDeleteBatch,
  signal?: AbortSignal,
) {
  const pool = new ParserWorkerPool({ minWorkers: 0, maxWorkers: 1 });
  const verification = {
    pool,
    targets: new Set<string>(),
    candidates: 0,
    sourceBytes: 0,
    signal: AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]),
  };
  const entries: Awaited<ReturnType<typeof prepareDeleteEntry>>[] = [];
  try {
    for (const inputPath of Object.keys(requests)) {
      verification.signal.throwIfAborted();
      verification.targets.add(await resolveWritablePath(inputPath, "delete"));
    }
    for (const [inputPath, request] of Object.entries(requests)) {
      verification.signal.throwIfAborted();
      entries.push(await prepareDeleteEntry(inputPath, request, verification));
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if ((error as { code?: string }).code === "reference_verification_failed")
      throw error;
    // Only parser errors and the overall verification deadline need translation.
    if (
      verification.signal.aborted ||
      (error as { name?: string }).name === "ParserError"
    )
      throw referenceFailure(
        "Reference verification could not complete within parser limits; no files were deleted",
        error,
      );
    throw error;
  } finally {
    await pool.close({ drain: false });
  }
  signal?.throwIfAborted();
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
        const snapshot = await readFileSnapshot(filePath, signal);
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
        signal?.throwIfAborted();
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
          signal?.throwIfAborted();
          await fence();
          signal?.throwIfAborted();
          verifyExpectedHash(
            snapshots.get(filePath)!.sha256,
            await sha256File(filePath, signal),
          );
          signal?.throwIfAborted();
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
    { signal },
  );
  const roots = [...new Set(entries.map(({ root }) => root))].sort();
  let cleanup: { status: "deferred" | "failed"; code: string } | undefined;
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
    // Deletion is already committed. Caller cancellation must not misreport it.
    { deadline: Date.now() + 1_000 },
  ).catch((error: unknown) => {
    const code = (error as { code?: string } | null)?.code;
    cleanup =
      code === "lock_deadline"
        ? { status: "deferred", code }
        : {
            status: "failed",
            code: ["lock_fenced", "EACCES", "EPERM"].includes(code ?? "")
              ? code!
              : "cleanup_failed",
          };
    return undefined;
  });
  return {
    ...outcome,
    removedDirectories: removedDirectories ?? [],
    ...(cleanup ? { cleanup } : {}),
  };
}

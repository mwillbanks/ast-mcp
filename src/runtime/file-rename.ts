import { randomUUID } from "node:crypto";
import { link, lstat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  beginMutation,
  completeMutation,
  failMutation,
  type MutationFileCommit,
  mutationOperationId,
  recordMutationCommit,
  recordMutationRollback,
} from "../intelligence/mutation/index.ts";
import { currentWorkspace } from "../intelligence/workspace/context.ts";
import { readFileSnapshot } from "./file-snapshot";
import { sha256File } from "./hash";
import { withFileLocks } from "./locks";
import {
  ensureParentDirectories,
  removeCreatedDirectories,
  revalidateWritePath,
} from "./parent-directories";
import { pathsShareRoot, resolveWritablePath } from "./paths";
import { requireExpectedHash, verifyExpectedHash } from "./policy";

export interface FileRenameRequest {
  destination: string;
  expectedSha256?: string;
}

export type FileRenameBatch = Record<string, FileRenameRequest>;

type RenameEntry = {
  destinationPath: string;
  filePath: string;
  request: FileRenameRequest;
};

async function ignoreFailure(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {}
}

function sourceHashFor(hashes: ReadonlyMap<string, string>, filePath: string) {
  const value = hashes.get(filePath);
  if (!value) throw new Error("mutation_source_hash_missing");
  return value;
}

function renameFailure(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  const message =
    code === "ENOENT"
      ? "file_rename source or destination parent is missing"
      : code === "EACCES" || code === "EPERM"
        ? "file_rename filesystem permission denied"
        : code === "EEXIST"
          ? "file_rename destination already exists"
          : code === "EXDEV" ||
              code === "ENOTSUP" ||
              code === "EOPNOTSUPP" ||
              code === "ENOSYS"
            ? "file_rename requires hard-link support between source and destination filesystems"
            : "file_rename filesystem link operation failed";
  return Object.assign(new Error(message, { cause: error }), {
    code: typeof code === "string" ? code : "file_rename_link_failed",
    retryable: code === "ENOENT",
  });
}

async function revalidateEntry(entry: RenameEntry): Promise<void> {
  if ((await resolveWritablePath(entry.filePath, "delete")) !== entry.filePath)
    throw Object.assign(new Error("file_rename source path changed"), {
      code: "mutation_path_changed",
    });
  await revalidateWritePath(entry.destinationPath);
}

async function verifyLinkCapability(
  entries: RenameEntry[],
  fence: () => Promise<void>,
) {
  for (const entry of entries) {
    const probe = join(
      dirname(entry.destinationPath),
      `.ast-mcp-rename-probe-${randomUUID()}`,
    );
    let linkError: unknown;
    let created = false;
    await fence();
    await revalidateEntry(entry);
    await revalidateWritePath(probe);
    try {
      await link(entry.filePath, probe);
      created = true;
    } catch (error) {
      linkError = error;
    }
    if (created) {
      try {
        await fence();
        await unlink(probe);
      } catch (cleanupError) {
        throw new AggregateError(
          [cleanupError],
          `file_rename probe cleanup failed; residual probe: ${probe}`,
        );
      }
    }
    if (linkError) throw renameFailure(linkError);
  }
}

async function rollbackMovedFiles(
  entries: readonly RenameEntry[],
  fence: () => Promise<void>,
  sourceHashes: ReadonlyMap<string, string>,
): Promise<void> {
  const rollbackErrors: unknown[] = [];
  for (const entry of [...entries].reverse()) {
    try {
      await fence();
      verifyExpectedHash(
        sourceHashFor(sourceHashes, entry.filePath),
        await sha256File(entry.destinationPath),
      );
      await link(entry.destinationPath, entry.filePath);
      await fence();
      verifyExpectedHash(
        sourceHashFor(sourceHashes, entry.filePath),
        await sha256File(entry.destinationPath),
      );
      await unlink(entry.destinationPath);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackErrors.length > 0)
    throw new AggregateError(
      rollbackErrors,
      "file_rename rollback was incomplete",
    );
}

async function moveFilesWithRollback(
  entries: RenameEntry[],
  fence: () => Promise<void>,
  linked: (entry: RenameEntry) => Promise<void>,
  sourceHashes: ReadonlyMap<string, string>,
  signal?: AbortSignal,
) {
  const files: Record<string, unknown> = {};
  const moved: RenameEntry[] = [];
  try {
    for (const entry of entries) {
      signal?.throwIfAborted();
      await fence();
      signal?.throwIfAborted();
      await revalidateEntry(entry);
      verifyExpectedHash(
        sourceHashFor(sourceHashes, entry.filePath),
        await sha256File(entry.filePath),
      );
      try {
        await link(entry.filePath, entry.destinationPath);
      } catch (error) {
        throw renameFailure(error);
      }
      try {
        await linked(entry);
        await fence();
        signal?.throwIfAborted();
        await revalidateEntry(entry);
        verifyExpectedHash(
          sourceHashFor(sourceHashes, entry.filePath),
          await sha256File(entry.filePath),
        );
        await unlink(entry.filePath);
      } catch (error) {
        await fence();
        await (async () => {
          verifyExpectedHash(
            sourceHashFor(sourceHashes, entry.filePath),
            await sha256File(entry.destinationPath),
          );
          await unlink(entry.destinationPath);
        })().catch((cleanupError) => {
          throw new AggregateError(
            [error, cleanupError],
            "file_rename failed while cleaning up the current destination",
          );
        });
        throw error;
      }
      moved.push(entry);
      files[entry.filePath] = {
        destinationPath: entry.destinationPath,
        renamed: true,
      };
    }
  } catch (error) {
    try {
      await rollbackMovedFiles(moved, fence, sourceHashes);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "file_rename failed and rollback was incomplete",
      );
    }
    throw error;
  }
  return files;
}

export async function renameFilesSafely(
  requests: FileRenameBatch,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const requestedDestinations = Object.values(requests).map(
    ({ destination }) => destination,
  );
  if (new Set(requestedDestinations).size !== requestedDestinations.length)
    throw new Error("file_rename destinations must be unique");

  const entries = await Promise.all(
    Object.entries(requests).map(async ([inputPath, request]) => {
      const filePath = await resolveWritablePath(inputPath, "delete");
      const destinationPath = await resolveWritablePath(
        request.destination,
        "write",
      );
      const metadata = await lstat(filePath);
      if (!metadata.isFile())
        throw new Error(`file_rename accepts files only: ${inputPath}`);
      if (filePath === destinationPath)
        throw new Error(
          `file_rename source and destination must differ: ${inputPath}`,
        );
      if (!(await pathsShareRoot(filePath, destinationPath)))
        throw new Error(
          `file_rename source and destination must share a root: ${inputPath}`,
        );
      try {
        await lstat(destinationPath);
        throw Object.assign(
          new Error(
            `file_rename destination already exists: ${request.destination}`,
          ),
          { code: "EEXIST" },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return { destinationPath, filePath, request } satisfies RenameEntry;
    }),
  );
  const sources = new Set<string>();
  const destinations = new Set<string>();
  for (const { destinationPath, filePath } of entries) {
    if (sources.has(filePath))
      throw new Error(`file_rename source appears more than once: ${filePath}`);
    sources.add(filePath);
    if (destinations.has(destinationPath))
      throw new Error(
        `file_rename destination appears more than once: ${destinationPath}`,
      );
    destinations.add(destinationPath);
  }

  return withFileLocks(
    entries.flatMap(({ destinationPath, filePath }) => [
      filePath,
      destinationPath,
    ]),
    async (leases) => {
      const fence = async () => {
        for (const lease of leases) await lease.fence();
      };
      const sourceSnapshots = new Map<
        string,
        Awaited<ReturnType<typeof readFileSnapshot>>
      >();
      for (const { filePath, request } of entries) {
        const snapshot = await readFileSnapshot(filePath, signal);
        await requireExpectedHash(request.expectedSha256, "file_rename");
        verifyExpectedHash(request.expectedSha256, snapshot.sha256);
        sourceSnapshots.set(filePath, snapshot);
      }
      const sourceHashes = new Map(
        [...sourceSnapshots].map(([filePath, snapshot]) => [
          filePath,
          snapshot.sha256,
        ]),
      );
      const workspace = currentWorkspace() ?? null;
      const sourcePlan = entries.flatMap(({ destinationPath, filePath }) => {
        const sourceSha256 = sourceHashFor(sourceHashes, filePath);
        const snapshot = sourceSnapshots.get(filePath);
        return [
          {
            candidateSha256: null,
            filePath,
            sourceContentBase64: snapshot?.content.toString("base64") ?? null,
            sourceGid:
              process.platform === "win32" ? null : (snapshot?.gid ?? null),
            sourceMode: snapshot?.mode ?? null,
            sourceSha256,
            sourceUid:
              process.platform === "win32" ? null : (snapshot?.uid ?? null),
          },
          {
            candidateSha256: sourceSha256,
            filePath: destinationPath,
            sourceContentBase64: null,
            sourceGid: null,
            sourceMode: null,
            sourceSha256: null,
            sourceUid: null,
          },
        ];
      });
      const operationId = workspace
        ? mutationOperationId({
            files: sourcePlan,
            nonce: randomUUID(),
            storageDomainId: workspace.storageDomain.domainId,
            workspaceId: workspace.workspaceId,
          })
        : randomUUID();
      let began = false;
      let moved = false;
      let completed = false;
      let primaryFailure: unknown;
      const createdDirectories: string[] = [];
      try {
        signal?.throwIfAborted();
        await beginMutation({
          files: sourcePlan,
          operationId,
          tool: "file_rename",
          workspace,
        });
        began = true;
        for (const entry of entries) {
          await ensureParentDirectories(
            entry.destinationPath,
            createdDirectories,
            async () => {
              signal?.throwIfAborted();
              await fence();
            },
          );
        }
        await verifyLinkCapability(entries, fence);
        const files = await moveFilesWithRollback(
          entries,
          fence,
          async (entry) => {
            const expectedSha256 = sourceHashFor(sourceHashes, entry.filePath);
            await recordMutationCommit(operationId, {
              filePath: entry.destinationPath,
              sha256: expectedSha256,
            });
            const [sourceMetadata, destinationMetadata, destinationSha256] =
              await Promise.all([
                lstat(entry.filePath),
                lstat(entry.destinationPath),
                sha256File(entry.destinationPath),
              ]);
            if (
              sourceMetadata.dev !== destinationMetadata.dev ||
              sourceMetadata.ino !== destinationMetadata.ino ||
              destinationSha256 !== expectedSha256
            )
              throw new Error("file_rename_destination_verification_failed");
          },
          sourceHashes,
          signal,
        );
        moved = true;
        const commits: MutationFileCommit[] = entries.flatMap(
          ({ destinationPath, filePath }) => {
            const sha256 = sourceHashFor(sourceHashes, filePath);
            return [
              { deleted: true, filePath, sha256 },
              { filePath: destinationPath, sha256 },
            ];
          },
        );
        for (const commit of commits)
          if (commit.deleted) await recordMutationCommit(operationId, commit);
        const intelligenceRefresh = await completeMutation(
          operationId,
          commits,
        );
        completed = true;
        return intelligenceRefresh ? { files, intelligenceRefresh } : { files };
      } catch (error) {
        primaryFailure = error;
        if (began) await ignoreFailure(failMutation(operationId, error));
        if (moved) {
          try {
            await rollbackMovedFiles(entries, fence, sourceHashes);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "file_rename failed and rollback requires recovery",
            );
          }
        }
        const restored = await Promise.all(
          entries.flatMap(({ destinationPath, filePath }) => [
            sha256File(filePath)
              .then((hash) => hash === sourceHashFor(sourceHashes, filePath))
              .catch(() => false),
            lstat(destinationPath)
              .then(() => false)
              .catch(
                (missing) =>
                  (missing as NodeJS.ErrnoException).code === "ENOENT",
              ),
          ]),
        );
        if (began && restored.every(Boolean))
          await ignoreFailure(recordMutationRollback(operationId));
        throw error;
      } finally {
        if (!completed) {
          try {
            await removeCreatedDirectories(createdDirectories);
          } catch (cleanupError) {
            throw Object.assign(
              new AggregateError(
                [primaryFailure, cleanupError],
                "file_rename failed and parent cleanup was incomplete",
              ),
              {
                details: { affectedPaths: createdDirectories },
              },
            );
          }
        }
      }
    },
    { signal },
  );
}

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
    try {
      await fence();
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
    if (linkError)
      throw new Error(
        `file_rename requires hard-link support between source and destination filesystems: ${String(linkError)}`,
      );
  }
}

async function rollbackMovedFiles(
  entries: readonly RenameEntry[],
  fence: () => Promise<void>,
): Promise<void> {
  const rollbackErrors: unknown[] = [];
  for (const entry of [...entries].reverse()) {
    try {
      await fence();
      await link(entry.destinationPath, entry.filePath);
      await fence();
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
) {
  const files: Record<string, unknown> = {};
  const moved: RenameEntry[] = [];
  try {
    for (const entry of entries) {
      await fence();
      await link(entry.filePath, entry.destinationPath);
      await linked(entry);
      try {
        await fence();
        await unlink(entry.filePath);
      } catch (error) {
        await fence();
        await unlink(entry.destinationPath).catch((cleanupError) => {
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
      await rollbackMovedFiles(moved, fence);
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

export async function renameFilesSafely(requests: FileRenameBatch) {
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
      if (await lstat(destinationPath).catch(() => undefined))
        throw new Error(
          `file_rename destination already exists: ${request.destination}`,
        );
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
      await verifyLinkCapability(entries, fence);
      const sourceSnapshots = new Map<
        string,
        Awaited<ReturnType<typeof readFileSnapshot>>
      >();
      for (const { filePath, request } of entries) {
        const snapshot = await readFileSnapshot(filePath);
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
      try {
        await beginMutation({
          files: sourcePlan,
          operationId,
          tool: "file_rename",
          workspace,
        });
        began = true;
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
        return intelligenceRefresh ? { files, intelligenceRefresh } : { files };
      } catch (error) {
        if (began) await ignoreFailure(failMutation(operationId, error));
        if (moved) {
          try {
            await rollbackMovedFiles(entries, fence);
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
      }
    },
  );
}

import { randomUUID } from "node:crypto";
import { link, lstat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256File } from "./hash";
import { withFileLocks } from "./locks";
import { resolveWritablePath, rootForPath } from "./paths";

export interface FileRenameRequest {
  destination: string;
  expectedSha256: string;
}

export type FileRenameBatch = Record<string, FileRenameRequest>;

type RenameEntry = {
  destinationPath: string;
  filePath: string;
  request: FileRenameRequest;
};

async function verifyLinkCapability(entries: RenameEntry[]) {
  for (const entry of entries) {
    const probe = join(
      dirname(entry.destinationPath),
      `.ast-mcp-rename-probe-${randomUUID()}`,
    );
    let linkError: unknown;
    let created = false;
    try {
      await link(entry.filePath, probe);
      created = true;
    } catch (error) {
      linkError = error;
    }
    if (created) {
      try {
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

async function moveFilesWithRollback(entries: RenameEntry[]) {
  const files: Record<string, unknown> = {};
  const moved: RenameEntry[] = [];
  try {
    for (const entry of entries) {
      await link(entry.filePath, entry.destinationPath);
      try {
        await unlink(entry.filePath);
      } catch (error) {
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
    const rollbackErrors: unknown[] = [];
    for (const entry of [...moved].reverse()) {
      try {
        await link(entry.destinationPath, entry.filePath);
        await unlink(entry.destinationPath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0)
      throw new AggregateError(
        [error, ...rollbackErrors],
        "file_rename failed and rollback was incomplete",
      );
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
      const filePath = await resolveWritablePath(inputPath);
      const destinationPath = await resolveWritablePath(request.destination);
      const metadata = await lstat(filePath);
      if (!metadata.isFile())
        throw new Error(`file_rename accepts files only: ${inputPath}`);
      if (filePath === destinationPath)
        throw new Error(
          `file_rename source and destination must differ: ${inputPath}`,
        );
      if (
        (await rootForPath(filePath)) !== (await rootForPath(destinationPath))
      )
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
    if (!sources.add(filePath))
      throw new Error(`file_rename source appears more than once: ${filePath}`);
    if (!destinations.add(destinationPath))
      throw new Error(
        `file_rename destination appears more than once: ${destinationPath}`,
      );
  }

  return {
    files: await withFileLocks(
      entries.flatMap(({ destinationPath, filePath }) => [
        filePath,
        destinationPath,
      ]),
      async () => {
        await verifyLinkCapability(entries);
        for (const { filePath, request } of entries) {
          const actual = await sha256File(filePath);
          if (actual !== request.expectedSha256)
            throw new Error(
              `Stale file context: expected ${request.expectedSha256}, found ${actual}`,
            );
        }
        return moveFilesWithRollback(entries);
      },
    ),
  };
}

import { lstat, open, rm } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./hash";

const queues = new Map<string, Promise<void>>();

async function lockPath(filePath: string): Promise<string> {
  const targetDirectory = path.dirname(filePath);
  let directory = targetDirectory;
  while (true) {
    try {
      if (!(await lstat(directory)).isDirectory())
        throw new Error(`Lock parent is not a directory: ${directory}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(directory);
      if (parent === directory) throw error;
      directory = parent;
    }
  }
  const name =
    directory === targetDirectory
      ? `.${path.basename(filePath)}.ast-mcp.lock`
      : `.${sha256(filePath).slice(0, 24)}.ast-mcp.lock`;
  return path.join(directory, name);
}

async function waitForLock(filePath: string): Promise<() => Promise<void>> {
  const lock = await lockPath(filePath);
  while (true) {
    try {
      const handle = await open(lock, "wx");
      await handle.close();
      return () => rm(lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function withQueuedLock<Result>(
  filePath: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = queues.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  queues.set(filePath, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(filePath) === queued) queues.delete(filePath);
  }
}

export async function withFileLock<Result>(
  filePath: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  return withQueuedLock(filePath, async () => {
    const release = await waitForLock(filePath);
    try {
      return await operation();
    } finally {
      await release();
    }
  });
}

export async function withFileLocks<Result>(
  filePaths: string[],
  operation: () => Promise<Result>,
): Promise<Result> {
  const sorted = [...new Set(filePaths)].sort();
  const acquire = async (index: number): Promise<Result> =>
    index === sorted.length
      ? operation()
      : withFileLock(sorted[index] as string, () => acquire(index + 1));
  return acquire(0);
}

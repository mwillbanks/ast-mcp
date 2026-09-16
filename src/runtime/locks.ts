import {
  type FileLockLease,
  type FileLockOptions,
  withFencedFileLock,
  withFencedFileLocks,
} from "../intelligence/mutation/locks.ts";

export type {
  FileLockLease,
  FileLockOptions,
} from "../intelligence/mutation/locks.ts";
export { withFencedFileLock, withFencedFileLocks };

export async function withFileLock<Result>(
  filePath: string,
  operation: (lease: FileLockLease) => Promise<Result>,
  options: FileLockOptions = {},
): Promise<Result> {
  return withFencedFileLock(filePath, operation, options);
}

export async function withFileLocks<Result>(
  filePaths: string[],
  operation: (leases: readonly FileLockLease[]) => Promise<Result>,
  options: FileLockOptions = {},
): Promise<Result> {
  return withFencedFileLocks(filePaths, operation, options);
}

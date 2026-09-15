import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { LanceTableName } from "../contracts/storage.ts";
import { StorageError } from "./errors.ts";
import { ALL_TABLES, assertCompatibleSchema } from "./schemas.ts";

export interface NetworkFileSystemProof {
  evidence: string;
  verified: true;
}

export interface StoragePathPolicy {
  networkFileSystem?: boolean;
  networkProof?: NetworkFileSystemProof;
}

export interface RelocationFile {
  path: string;
  sha256: string;
  size: number;
}

export interface RelocationPreview {
  destinationPath: string;
  files: readonly RelocationFile[];
  sourcePath: string;
  tableCounts: Readonly<Record<LanceTableName, number>>;
  totalBytes: number;
}

export interface RelocationResult extends RelocationPreview {
  destinationFiles: readonly RelocationFile[];
  sourceDeleted: false;
  verified: true;
}

function windowsNetworkPath(storagePath: string): boolean {
  return (
    /^\\\\\?\\UNC\\/i.test(storagePath) ||
    /^\\\\(?![?.]\\)[^\\]+\\[^\\]+/.test(storagePath) ||
    /^\/\/(?![?.]\/)[^/]+\/[^/]+/.test(storagePath)
  );
}

function windowsPathSyntax(storagePath: string): boolean {
  return (
    process.platform === "win32" ||
    /^[a-z]:[\\/]/i.test(storagePath) ||
    /^\\\\\?\\/.test(storagePath) ||
    windowsNetworkPath(storagePath)
  );
}

export function storagePathIdentity(storagePath: string): string {
  if (windowsPathSyntax(storagePath)) {
    const canonical = win32.resolve(storagePath);
    if (/^\\\\\?\\UNC\\/i.test(canonical)) {
      return `\\\\${canonical.slice(8)}`.toLowerCase();
    }
    if (/^\\\\\?\\/.test(canonical)) {
      return canonical.slice(4).toLowerCase();
    }
    return canonical.toLowerCase();
  }
  return resolve(storagePath);
}

function pathContainedBy(root: string, target: string): boolean {
  const windows = windowsPathSyntax(root) || windowsPathSyntax(target);
  const pathRelative = windows ? win32.relative : relative;
  const pathSeparator = windows ? win32.sep : sep;
  const pathIsAbsolute = windows ? win32.isAbsolute : isAbsolute;
  const remainder = pathRelative(
    storagePathIdentity(root),
    storagePathIdentity(target),
  );
  return (
    remainder !== "" &&
    remainder !== ".." &&
    !remainder.startsWith(`..${pathSeparator}`) &&
    !pathIsAbsolute(remainder)
  );
}

const NETWORK_FILE_SYSTEM_TYPES = new Set([
  0x0000_6969, 0xfe53_4d42, 0xff53_4d42,
]);

function rejectUnsupportedNetworkFileSystem(
  storagePath: string,
  fileSystemType?: number,
): never {
  throw new StorageError(
    "network_filesystem_unsupported",
    fileSystemType === undefined
      ? "Network filesystem storage requires an explicit verified proof"
      : "Detected network filesystem storage without a verified concurrency proof",
    false,
    { fileSystemType, storagePath },
  );
}

export async function assertSupportedStoragePath(
  storagePath: string,
  policy: StoragePathPolicy = {},
): Promise<string> {
  if (windowsNetworkPath(storagePath) && !policy.networkProof?.verified) {
    rejectUnsupportedNetworkFileSystem(storagePath);
  }
  if (
    !isAbsolute(storagePath) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(storagePath)
  ) {
    throw new StorageError(
      "storage_unavailable",
      "LanceDB storage path must be a local absolute filesystem path",
      false,
      { storagePath },
    );
  }
  const canonical = resolve(storagePath);
  if (policy.networkFileSystem && !policy.networkProof?.verified) {
    rejectUnsupportedNetworkFileSystem(canonical);
  }
  const existing = await nearestExistingAncestor(canonical);
  const fileSystem = await statfs(existing);
  if (
    NETWORK_FILE_SYSTEM_TYPES.has(Number(fileSystem.type)) &&
    !policy.networkProof?.verified
  ) {
    rejectUnsupportedNetworkFileSystem(canonical, Number(fileSystem.type));
  }
  return canonical;
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let candidate = path;
  for (;;) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = resolve(candidate, "..");
      if (parent === candidate) return candidate;
      candidate = parent;
    }
  }
}

async function walkFiles(
  root: string,
  directory = root,
): Promise<RelocationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: RelocationFile[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, absolute)));
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await readFile(absolute);
    files.push({
      path: relative(root, absolute).split(sep).join("/"),
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.byteLength,
    });
  }
  return files;
}

export async function snapshotStorageDirectory(
  storagePath: string,
): Promise<readonly RelocationFile[]> {
  return walkFiles(resolve(storagePath));
}

export function validateRelocationCoordinates(
  sourcePath: string,
  destinationPath: string,
): void {
  const source = storagePathIdentity(sourcePath);
  const destination = storagePathIdentity(destinationPath);
  if (
    storagePathIdentity(source) === storagePathIdentity(destination) ||
    pathContainedBy(source, destination) ||
    pathContainedBy(destination, source)
  ) {
    throw new StorageError(
      "storage_unavailable",
      "Relocation source and destination must be disjoint directories",
      false,
      { destination, source },
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function copyRelocationSnapshot(
  preview: RelocationPreview,
  beforePublish?: () => Promise<void>,
): Promise<RelocationResult> {
  const finalDestination = resolve(preview.destinationPath);
  validateRelocationCoordinates(preview.sourcePath, finalDestination);
  await mkdir(dirname(finalDestination), { recursive: true });
  if (await pathExists(finalDestination)) {
    throw new StorageError(
      "storage_unavailable",
      "Relocation destination must not already exist",
      false,
      { destinationPath: finalDestination },
    );
  }

  const temporaryDestination = join(
    dirname(finalDestination),
    `.${basename(finalDestination)}.ast-mcp-relocation-${randomUUID()}`,
  );
  await mkdir(temporaryDestination, { mode: 0o700 });
  try {
    const sourceRoot = resolve(preview.sourcePath);
    const realSourceRoot = await realpath(sourceRoot);
    const paths = new Set<string>();
    for (const file of preview.files) {
      const normalizedPath = normalize(file.path).split(sep).join("/");
      if (
        !file.path ||
        isAbsolute(file.path) ||
        file.path.includes("\\") ||
        normalizedPath === "." ||
        normalizedPath !== file.path ||
        normalizedPath.startsWith("../") ||
        paths.has(normalizedPath)
      ) {
        throw new StorageError(
          "relocation_verification_failed",
          "Relocation preview contains an invalid or duplicate file path",
          false,
          { path: file.path },
        );
      }
      paths.add(normalizedPath);
      const source = resolve(sourceRoot, normalizedPath);
      const sourceStat = await lstat(source);
      const realSource = await realpath(source);
      if (
        !sourceStat.isFile() ||
        !pathContainedBy(realSourceRoot, realSource)
      ) {
        throw new StorageError(
          "relocation_verification_failed",
          "Relocation source path is not a contained regular file",
          false,
          { path: file.path },
        );
      }
      const content = await readFile(realSource);
      const sourceHash = createHash("sha256").update(content).digest("hex");
      if (content.byteLength !== file.size || sourceHash !== file.sha256) {
        throw new StorageError(
          "relocation_verification_failed",
          "Relocation source changed after preview",
          false,
          {
            actualSha256: sourceHash,
            actualSize: content.byteLength,
            expectedSha256: file.sha256,
            expectedSize: file.size,
            path: file.path,
          },
        );
      }
      const destination = resolve(temporaryDestination, normalizedPath);
      await mkdir(resolve(destination, ".."), { recursive: true });
      await writeFile(destination, content, { flag: "wx" });
    }
    const destinationFiles =
      await snapshotStorageDirectory(temporaryDestination);
    if (JSON.stringify(destinationFiles) !== JSON.stringify(preview.files)) {
      throw new StorageError(
        "relocation_verification_failed",
        "Relocated LanceDB files failed checksum or count verification",
        false,
        { destinationFiles, expectedFiles: preview.files },
      );
    }

    const connection = await lancedb.connect(temporaryDestination, {
      readConsistencyInterval: 0,
    });
    let destinationCounts: Record<LanceTableName, number>;
    try {
      destinationCounts = Object.fromEntries(
        await Promise.all(
          ALL_TABLES.map(async (tableName) => {
            const table = await connection.openTable(tableName);
            try {
              assertCompatibleSchema(tableName, await table.schema());
              return [tableName, await table.countRows()] as const;
            } finally {
              table.close();
            }
          }),
        ),
      ) as Record<LanceTableName, number>;
    } finally {
      connection.close();
    }
    if (
      JSON.stringify(destinationCounts) !== JSON.stringify(preview.tableCounts)
    ) {
      throw new StorageError(
        "relocation_verification_failed",
        "Relocated LanceDB tables failed row-count verification",
        false,
        { actual: destinationCounts, expected: preview.tableCounts },
      );
    }

    if (beforePublish) await beforePublish();
    if (await pathExists(finalDestination)) {
      throw new StorageError(
        "storage_unavailable",
        "Relocation destination appeared before atomic publication",
        false,
        { destinationPath: finalDestination },
      );
    }
    await rename(temporaryDestination, finalDestination);
    return {
      ...preview,
      destinationFiles,
      destinationPath: finalDestination,
      sourceDeleted: false,
      verified: true,
    };
  } catch (error) {
    await rm(temporaryDestination, { force: true, recursive: true });
    throw error;
  }
}

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import type { SkillFile } from "./index";

export const SKILL_EXPORT_MANIFEST = ".ast-mcp-export.json";
const lockName = ".ast-mcp-export.lock";
const maximumManifestBytes = 256 * 1024;
const ignoreCleanupError = () => {};

interface ExportManifest {
  version: 1;
  files: Record<string, string>;
}

export interface SkillExportResult {
  destination: string;
  written: string[];
  updated: string[];
  unchanged: string[];
  preserved: string[];
  obsolete: string[];
  conflicts: string[];
}

type ExportFile = Pick<SkillFile, "relative" | "bytes">;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

function validRelative(relative: string) {
  return (
    relative.length > 0 &&
    !relative.includes("\\") &&
    !relative.includes("\0") &&
    !relative.includes(":") &&
    relative
      .split("/")
      .every(
        (part) =>
          part !== "" && part !== "." && part !== ".." && !part.startsWith("."),
      )
  );
}

function validateManifest(value: unknown): ExportManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid skill export manifest: expected an object");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    Object.keys(record).some((key) => key !== "version" && key !== "files") ||
    !record.files ||
    typeof record.files !== "object" ||
    Array.isArray(record.files)
  )
    throw new Error(
      "Invalid skill export manifest: expected version 1 and file hashes",
    );
  const files = Object.entries(record.files);
  if (
    files.length > 512 ||
    files.some(
      ([relative, digest]) =>
        !validRelative(relative) ||
        typeof digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(digest),
    )
  )
    throw new Error(
      "Invalid skill export manifest: unsafe path or SHA-256 hash",
    );
  return {
    version: 1,
    files: Object.assign(
      Object.create(null) as Record<string, string>,
      Object.fromEntries(files),
    ),
  };
}

async function metadata(file: string) {
  return lstat(file).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw error;
  });
}

async function requireDirectory(directory: string) {
  const entry = await metadata(directory);
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
    throw new Error(
      "Skill export directories must not be symbolic links or files",
    );
}

async function inspectParents(root: string, relative: string) {
  let current = root;
  await requireDirectory(root);
  for (const part of relative.split("/").slice(0, -1)) {
    current = path.join(current, part);
    await requireDirectory(current);
  }
}

async function inspectTree(root: string, relatives: string[]) {
  for (const relative of relatives) await inspectParents(root, relative);
}

async function closeFile(handle: FileHandle, failed: boolean) {
  try {
    await handle.close();
  } catch (error) {
    if (!failed) throw error;
  }
}

async function readRegular(file: string): Promise<Buffer | undefined> {
  const entry = await metadata(file);
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink()) return undefined;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let failed = false;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino
    )
      throw new Error("Skill export file changed while opening it");
    return await handle.readFile();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await closeFile(handle, failed);
  }
}

async function readManifest(root: string): Promise<ExportManifest> {
  const file = path.join(root, SKILL_EXPORT_MANIFEST);
  const entry = await metadata(file);
  if (!entry)
    return { version: 1, files: Object.create(null) as Record<string, string> };
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.size > maximumManifestBytes
  )
    throw new Error(
      "Invalid skill export manifest: expected a bounded regular file",
    );
  const bytes = await readRegular(file);
  return validateManifest(JSON.parse(bytes!.toString("utf8")));
}

async function createParents(root: string, relative: string) {
  let current = root;
  for (const part of relative.split("/").slice(0, -1)) {
    current = path.join(current, part);
    await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await requireDirectory(current);
  }
}

async function createFile(target: string, bytes: Uint8Array, mode = 0o644) {
  const handle = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST" || error.code === "ELOOP") return undefined;
    throw error;
  });
  if (!handle) return false;
  let failed = false;
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await closeFile(handle, failed);
    }
  } catch (error) {
    await unlink(target).catch(ignoreCleanupError);
    throw error;
  }
  return true;
}

async function replaceFile(
  root: string,
  relative: string,
  bytes: Uint8Array,
  expected: string | undefined,
) {
  const target = path.join(root, relative);
  const temporary = path.join(root, ".ast-mcp-" + randomUUID() + ".tmp");
  let staged = false;
  try {
    await inspectParents(root, relative);
    const original = await metadata(target);
    staged = await createFile(
      temporary,
      bytes,
      original ? original.mode & 0o777 : 0o644,
    );
    if (!staged) throw new Error("Skill export staging file already exists");
    await inspectParents(root, relative);
    const entry = await metadata(target);
    const current = await readRegular(target);
    if (
      (entry && !current) ||
      (current ? hash(current) : undefined) !== expected
    )
      throw new Error(
        "Skill export file changed before replacement: " + relative,
      );
    await rename(temporary, target);
  } finally {
    if (staged) await unlink(temporary).catch(ignoreCleanupError);
  }
}

async function reconcileFile(
  root: string,
  file: ExportFile,
  operation: "export" | "update",
  manifest: ExportManifest,
  result: SkillExportResult,
) {
  const target = path.join(root, file.relative);
  const entry = await metadata(target);
  const bytes = await readRegular(target);
  const nextHash = hash(file.bytes);
  if (!entry) {
    await createParents(root, file.relative);
    await inspectParents(root, file.relative);
    if (!(await createFile(target, file.bytes)))
      throw new Error(
        "Skill export file appeared during creation: " + file.relative,
      );
    manifest.files[file.relative] = nextHash;
    result.written.push(file.relative);
  } else if (bytes && hash(bytes) === nextHash) {
    manifest.files[file.relative] = nextHash;
    result.unchanged.push(file.relative);
    if (operation === "export") result.preserved.push(file.relative);
  } else if (
    operation === "update" &&
    bytes &&
    manifest.files[file.relative] === hash(bytes)
  ) {
    await replaceFile(root, file.relative, file.bytes, hash(bytes));
    manifest.files[file.relative] = nextHash;
    result.updated.push(file.relative);
  } else {
    result.preserved.push(file.relative);
    if (operation === "update") result.conflicts.push(file.relative);
  }
}

async function releaseLock(handle: FileHandle, lock: string, failed: boolean) {
  let cleanupError: unknown;
  try {
    await handle.close();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await unlink(lock);
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError && !failed)
    throw new Error("Skill export lock cleanup failed; inspect " + lock, {
      cause: cleanupError,
    });
}

/** Export or refresh one manually installed skill without replacing custom files. */
export async function reconcileSkillExport(
  destination: string,
  operation: "export" | "update",
  files: readonly ExportFile[],
): Promise<SkillExportResult> {
  const root = path.resolve(destination);
  const relatives = files.map((file) => file.relative);
  if (
    files.length > 512 ||
    relatives.some((relative) => !validRelative(relative)) ||
    new Set(relatives).size !== files.length
  )
    throw new Error("Invalid skill resources: unsafe or duplicate paths");
  await requireDirectory(root);
  const manifest = await readManifest(root);
  await inspectTree(root, [...relatives, ...Object.keys(manifest.files)]);
  // Caller-selected ancestors can resolve through links. The export tree cannot.
  await mkdir(path.dirname(root), { recursive: true });
  await mkdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await requireDirectory(root);
  const canonical = await realpath(root);
  const lock = path.join(canonical, lockName);
  const handle = await open(
    lock,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST" || error.code === "ELOOP")
      throw new Error(
        "Skill export is locked; wait for the active export or inspect " + lock,
      );
    throw error;
  });
  let failed = false;
  try {
    // Read again under the lock; a concurrent invocation may have just completed.
    const current = await readManifest(canonical);
    const planned = {
      ...current.files,
      ...Object.fromEntries(
        files.map((file) => [file.relative, hash(file.bytes)]),
      ),
    };
    if (
      Object.keys(planned).length > 512 ||
      Buffer.byteLength(
        JSON.stringify({ version: 1, files: planned }, null, 2),
      ) > maximumManifestBytes
    )
      throw new Error(
        "Skill export manifest capacity exceeded; use a fresh destination and reconcile obsolete files",
      );
    await inspectTree(canonical, [...relatives, ...Object.keys(current.files)]);
    const original = await readRegular(
      path.join(canonical, SKILL_EXPORT_MANIFEST),
    );
    const result: SkillExportResult = {
      destination: root,
      written: [],
      updated: [],
      unchanged: [],
      preserved: [],
      obsolete: Object.keys(current.files)
        .filter((relative) => !relatives.includes(relative))
        .sort(),
      conflicts: [],
    };
    for (const file of files) {
      await inspectParents(canonical, file.relative);
      await reconcileFile(canonical, file, operation, current, result);
    }
    const serialized = Buffer.from(JSON.stringify(current, null, 2) + "\n");
    if (!original?.equals(serialized))
      await replaceFile(
        canonical,
        SKILL_EXPORT_MANIFEST,
        serialized,
        original ? hash(original) : undefined,
      );
    return result;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await releaseLock(handle, lock, failed);
  }
}

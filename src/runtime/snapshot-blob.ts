import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  currentWorkspace,
  type WorkspaceHandle,
} from "../intelligence/workspace/context.ts";
import { sha256, sha256Handle } from "./hash.ts";
import {
  ensurePrivateLockDirectory,
  systemAccount,
} from "./private-lock-directory.ts";

export interface SnapshotBlob {
  id: string;
  sha256: string;
  size: number;
}

export interface StagedFileSnapshot {
  sourceBlob: SnapshotBlob;
  namespace: string;
  dev: number;
  ino: number;
  gid: number;
  mode: number;
  sha256: string;
  uid: number;
}

const BLOB_ID = /^[1-9][0-9]*-[a-f0-9-]{36}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CHUNK_SIZE = 1024 * 1024;
const activeCaptures = new Set<string>();

function failure(code: string): Error {
  return Object.assign(new Error(code), { code, retryable: false });
}

/** Close every descriptor even when another close fails. */
export async function closeSnapshotHandles(
  handles: Iterable<FileHandle>,
): Promise<void> {
  const results = await Promise.allSettled(
    [...handles].map((handle) => handle.close()),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(errors, "Snapshot descriptor cleanup failed");
}

async function cleanupSnapshot(
  primary: unknown[],
  actions: Array<() => Promise<unknown>>,
): Promise<void> {
  const errors = [...primary];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === primary.length) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, "Snapshot operation and cleanup failed");
}

export function snapshotNamespace(
  workspace: WorkspaceHandle | null = currentWorkspace() ?? null,
): string {
  return sha256(
    workspace
      ? JSON.stringify([
          workspace.storageDomain.domainId,
          workspace.checkoutRoot,
        ])
      : "unbound-file-operations",
  );
}

async function privateDirectory(directory: string): Promise<boolean> {
  const account = await systemAccount();
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (metadata.uid !== account.uid || (metadata.mode & 0o777) !== 0o700))
  )
    throw failure("mutation_snapshot_directory_unsafe");
  if (created) {
    await syncDirectory(directory);
    await syncDirectory(path.dirname(directory));
  }
  return created;
}

async function snapshotRoot(namespace: string): Promise<string> {
  if (!DIGEST.test(namespace))
    throw failure("mutation_snapshot_namespace_invalid");
  const account = await systemAccount();
  const lockDirectory = await ensurePrivateLockDirectory(account);
  const base = path.join(lockDirectory, "snapshots");
  if (await privateDirectory(base))
    await syncDirectory(path.dirname(lockDirectory));
  const directory = path.join(base, namespace);
  await privateDirectory(directory);
  return directory;
}

async function blobDirectory(
  blob: SnapshotBlob,
  namespace: string,
): Promise<string> {
  if (
    !BLOB_ID.test(blob.id) ||
    !DIGEST.test(blob.sha256) ||
    !Number.isSafeInteger(blob.size) ||
    blob.size < 0
  )
    throw failure("mutation_snapshot_reference_invalid");
  const directory = path.join(await snapshotRoot(namespace), blob.id);
  const metadata = await lstat(directory);
  const account = await systemAccount();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (metadata.uid !== account.uid || (metadata.mode & 0o777) !== 0o700))
  )
    throw failure("mutation_snapshot_directory_unsafe");
  return directory;
}

export async function syncDirectory(directory: string): Promise<void> {
  // Windows has no portable directory fsync here; directory-entry power-loss durability is not guaranteed.
  if (process.platform === "win32") return;
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function unchanged(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function writeAll(
  handle: FileHandle,
  bytes: Buffer,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(
      bytes,
      written,
      bytes.length - written,
      position + written,
    );
    if (!result.bytesWritten) throw failure("mutation_snapshot_write_failed");
    written += result.bytesWritten;
  }
}

/** Capture one immutable rollback copy with bounded memory and a fresh digest. */
export async function stageFileSnapshot(
  filePath: string,
  signal?: AbortSignal,
): Promise<StagedFileSnapshot> {
  const readSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  readSignal.throwIfAborted();
  const namespace = snapshotNamespace();
  const root = await snapshotRoot(namespace);
  if (!currentWorkspace()) await sweepSnapshotBlobs(namespace, new Set());
  const id = `${process.pid}-${randomUUID()}`;
  const directory = path.join(root, id);
  await mkdir(directory, { mode: 0o700 });
  activeCaptures.add(`${namespace}:${id}`);
  const pending = path.join(directory, "pending");
  let source: FileHandle | undefined;
  let destination: FileHandle | undefined;
  let succeeded = false;
  const errors: unknown[] = [];
  try {
    source = await open(
      filePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const metadata = await source.stat();
    if (!metadata.isFile()) throw failure("file_not_regular");
    destination = await open(pending, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    let position = 0;
    for (;;) {
      readSignal.throwIfAborted();
      const { bytesRead } = await source.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (!bytesRead) break;
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      await writeAll(destination, bytes, position);
      position += bytesRead;
    }
    readSignal.throwIfAborted();
    const after = await source.stat();
    const current = await lstat(filePath);
    if (
      !unchanged(metadata, after) ||
      !unchanged(metadata, current) ||
      position !== metadata.size ||
      current.isSymbolicLink()
    )
      throw failure("stale_or_missing_hash");
    const digest = hash.digest("hex");
    await destination.sync();
    await destination.close();
    destination = undefined;
    // Publication is a no-replace link, never a replace of existing recovery material.
    await link(pending, path.join(directory, `${digest}.blob`));
    await unlink(pending);
    await syncDirectory(directory);
    await syncDirectory(root);
    await source.close();
    source = undefined;
    succeeded = true;
    return {
      sourceBlob: { id, sha256: digest, size: position },
      namespace,
      dev: metadata.dev,
      ino: metadata.ino,
      gid: metadata.gid,
      mode: metadata.mode,
      sha256: digest,
      uid: metadata.uid,
    };
  } catch (error) {
    errors.push(error);
    throw error;
  } finally {
    await cleanupSnapshot(errors, [
      async () => destination?.close(),
      async () => source?.close(),
      async () => {
        if (succeeded) return;
        activeCaptures.delete(`${namespace}:${id}`);
        const entries = await readdir(directory);
        await cleanupSnapshot(
          [],
          [
            ...entries.map(
              (entry) => () => unlink(path.join(directory, entry)),
            ),
            () => rmdir(directory),
          ],
        );
      },
    ]);
  }
}

async function openSnapshotMaterial(
  blob: SnapshotBlob,
  namespace: string,
  signal?: AbortSignal,
): Promise<FileHandle> {
  signal?.throwIfAborted();
  const directory = await blobDirectory(blob, namespace);
  const target = path.join(directory, `${blob.sha256}.blob`);
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    const current = await lstat(target);
    const account = await systemAccount();
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      !unchanged(metadata, current) ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size !== blob.size ||
      (process.platform !== "win32" &&
        (metadata.uid !== account.uid || (metadata.mode & 0o777) !== 0o600))
    )
      throw failure("mutation_snapshot_material_unsafe");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Validate private identity and bounds for journaling, without reading payload bytes. */
export async function inspectSnapshotBlob(
  blob: SnapshotBlob,
  namespace: string,
  signal?: AbortSignal,
): Promise<void> {
  const handle = await openSnapshotMaterial(blob, namespace, signal);
  await handle.close();
}

/** Full material verification belongs after durable begin and before any target mutation. */
export async function openSnapshotBlob(
  blob: SnapshotBlob,
  namespace: string,
  signal?: AbortSignal,
  hashTimeoutMs?: number,
): Promise<FileHandle> {
  const handle = await openSnapshotMaterial(blob, namespace, signal);
  try {
    if ((await sha256Handle(handle, signal, hashTimeoutMs)) !== blob.sha256)
      throw failure("mutation_recovery_material_mismatch");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Check current pathname identity before unlinking.
 * A concurrent directory writer can still replace it between lstat and unlink.
 */
export async function removeSnapshotTemporary(
  filePath: string,
  identity: { dev: number; ino: number },
): Promise<void> {
  const current = await lstat(filePath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!current) return;
  if (
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  )
    throw failure("mutation_snapshot_temporary_replaced");
  await unlink(filePath);
}

async function copyVerifiedBytes(
  handle: FileHandle,
  output: FileHandle,
  blob: Pick<SnapshotBlob, "sha256" | "size">,
  signal?: AbortSignal,
): Promise<void> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  let position = 0;
  for (;;) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    const bytes = buffer.subarray(0, bytesRead);
    hash.update(bytes);
    await writeAll(output, bytes, position);
    position += bytesRead;
  }
  signal?.throwIfAborted();
  if (position !== blob.size || hash.digest("hex") !== blob.sha256)
    throw failure("mutation_recovery_material_mismatch");
}

/** Copy from the already verified descriptor, preserving its identity. */
export async function copySnapshotBlob(
  handle: FileHandle,
  destination: string,
  blob: SnapshotBlob,
  signal?: AbortSignal,
): Promise<{ dev: number; ino: number }> {
  const output = await open(destination, "wx", 0o600);
  let identity: { dev: number; ino: number } | undefined;
  let succeeded = false;
  let closed = false;
  const errors: unknown[] = [];
  try {
    identity = await output.stat();
    await copyVerifiedBytes(handle, output, blob, signal);
    await output.sync();
    await output.close();
    closed = true;
    succeeded = true;
    return { dev: identity.dev, ino: identity.ino };
  } catch (error) {
    errors.push(error);
    throw error;
  } finally {
    await cleanupSnapshot(errors, [
      async () => {
        // Retry once while the owned descriptor remains open; unknown paths stay intact.
        if (!succeeded && !identity) identity = await output.stat();
      },
      async () => {
        if (!closed) await output.close();
      },
      async () => {
        if (!succeeded && identity)
          await removeSnapshotTemporary(destination, identity);
      },
      async () => {
        if (!succeeded && identity)
          await syncDirectory(path.dirname(destination));
      },
    ]);
  }
}

/**
 * Link atomically when supported; otherwise copy to an exclusively created mode-0600 path.
 * The fallback exposes a partial pathname while copying, but never replaces another entry.
 * Returns the borrowed source on link, or a caller-owned writable descriptor on copy.
 */
export async function publishSnapshotNoReplace(
  temporary: string,
  destination: string,
  source: FileHandle,
  expected: Pick<SnapshotBlob, "sha256" | "size">,
  fence: (target?: FileHandle) => Promise<void>,
  options: { signal?: AbortSignal; hashTimeoutMs?: number } = {},
): Promise<FileHandle> {
  let linkError: unknown;
  try {
    await link(temporary, destination);
    return source;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      !["EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(
        code ?? "",
      )
    )
      throw error;
    linkError = error;
  }
  let output: FileHandle | undefined;
  let identity: { dev: number; ino: number } | undefined;
  let succeeded = false;
  const errors: unknown[] = [linkError];
  try {
    await fence();
    options.signal?.throwIfAborted();
    const metadata = await source.stat();
    const staged = await lstat(temporary);
    if (
      !metadata.isFile() ||
      staged.isSymbolicLink() ||
      !unchanged(metadata, staged)
    )
      throw failure("mutation_recovery_material_mismatch");
    output = await open(destination, "wx+", 0o600);
    identity = await output.stat();
    await copyVerifiedBytes(source, output, expected, options.signal);
    // Persist complete bytes before broadening permissions or making the file readonly.
    await output.sync();
    await fence(output);
    if (process.platform !== "win32")
      await output.chown(metadata.uid, metadata.gid);
    await output.chmod(metadata.mode);
    const verified = await output.stat();
    if (
      (await sha256Handle(output, options.signal, options.hashTimeoutMs)) !==
      expected.sha256
    )
      throw failure("mutation_recovery_material_mismatch");
    await output.sync();
    await fence(output);
    options.signal?.throwIfAborted();
    const held = await output.stat();
    const current = await lstat(destination);
    const sourceNow = await source.stat();
    const stagedNow = await lstat(temporary);
    if (
      current.isSymbolicLink() ||
      held.dev !== identity.dev ||
      held.ino !== identity.ino ||
      !unchanged(verified, held) ||
      !unchanged(held, current) ||
      (held.mode & 0o7777) !== (metadata.mode & 0o7777) ||
      (process.platform !== "win32" &&
        (held.uid !== metadata.uid || held.gid !== metadata.gid)) ||
      !unchanged(metadata, sourceNow) ||
      stagedNow.isSymbolicLink() ||
      !unchanged(sourceNow, stagedNow)
    )
      throw failure("mutation_recovery_material_mismatch");
    succeeded = true;
    return output;
  } catch (error) {
    errors.push(error);
    throw new AggregateError(errors, "Snapshot exclusive publication failed");
  } finally {
    if (!succeeded)
      await cleanupSnapshot(errors, [
        async () => {
          if (output && !identity) identity = await output.stat();
        },
        async () => {
          await output?.close();
        },
        async () => {
          if (identity) await removeSnapshotTemporary(destination, identity);
        },
        async () => {
          if (identity) await syncDirectory(path.dirname(destination));
        },
      ]);
  }
}

/** Publish a restored file only after its complete bytes are durable and verified. */
export async function restoreSnapshotBlob(
  snapshot: StagedFileSnapshot,
  destination: string,
  fence: () => Promise<void>,
): Promise<void> {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.rollback-${randomUUID()}`,
  );
  const source = await openSnapshotBlob(
    snapshot.sourceBlob,
    snapshot.namespace,
  );
  let created = false;
  let identity: { dev: number; ino: number } | undefined;
  const errors: unknown[] = [];
  try {
    await fence();
    identity = await copySnapshotBlob(source, temporary, snapshot.sourceBlob);
    created = true;
    const output = await open(
      temporary,
      (process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY) |
        constants.O_NOFOLLOW,
    );
    const metadataErrors: unknown[] = [];
    let published: FileHandle | undefined;
    try {
      const held = await output.stat();
      const current = await lstat(temporary);
      if (
        current.isSymbolicLink() ||
        !held.isFile() ||
        held.dev !== identity.dev ||
        held.ino !== identity.ino ||
        !unchanged(held, current)
      )
        throw failure("mutation_recovery_material_mismatch");
      await fence();
      if (process.platform !== "win32")
        await output.chown(snapshot.uid, snapshot.gid);
      await output.chmod(snapshot.mode);
      await output.sync();
      await fence();
      published = await publishSnapshotNoReplace(
        temporary,
        destination,
        output,
        snapshot.sourceBlob,
        fence,
      );
      await syncDirectory(path.dirname(destination));
    } catch (error) {
      metadataErrors.push(error);
      throw error;
    } finally {
      await cleanupSnapshot(metadataErrors, [
        () => output.close(),
        async () => {
          if (published && published !== output) await published.close();
        },
      ]);
    }
  } catch (error) {
    errors.push(error);
    throw error;
  } finally {
    await cleanupSnapshot(errors, [
      () => source.close(),
      async () => {
        if (created && identity)
          await removeSnapshotTemporary(temporary, identity);
      },
      async () => {
        if (created && errors.length)
          await syncDirectory(path.dirname(destination));
      },
    ]);
  }
}

export function releaseSnapshotCapture(
  blob: SnapshotBlob,
  namespace: string,
): void {
  activeCaptures.delete(`${namespace}:${blob.id}`);
}

export async function removeSnapshotBlob(
  blob: SnapshotBlob,
  namespace: string,
): Promise<void> {
  activeCaptures.delete(`${namespace}:${blob.id}`);
  const directory = await blobDirectory(blob, namespace).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!directory) return;
  await unlink(path.join(directory, `${blob.sha256}.blob`)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  await rmdir(directory);
}

export class FileSnapshotCollection<
  T extends StagedFileSnapshot = StagedFileSnapshot,
> extends Map<string, T> {
  disposable = true;
  async verify(signal?: AbortSignal): Promise<void> {
    for (const snapshot of this.values()) {
      const handle = await openSnapshotBlob(
        snapshot.sourceBlob,
        snapshot.namespace,
        signal,
      );
      await handle.close();
    }
  }
  async [Symbol.asyncDispose](): Promise<void> {
    for (const snapshot of this.values()) {
      activeCaptures.delete(`${snapshot.namespace}:${snapshot.sourceBlob.id}`);
      if (this.disposable)
        await removeSnapshotBlob(snapshot.sourceBlob, snapshot.namespace).catch(
          () => undefined,
        );
    }
  }
}

/** Only dead-process, old, unreferenced captures are garbage; live captures stay fenced. */
export async function sweepSnapshotBlobs(
  namespace: string,
  retained: ReadonlySet<string>,
  now = Date.now(),
): Promise<number> {
  const root = await snapshotRoot(namespace);
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      !BLOB_ID.test(entry.name) ||
      retained.has(entry.name) ||
      activeCaptures.has(`${namespace}:${entry.name}`)
    )
      continue;
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw failure("mutation_snapshot_directory_unsafe");
    const directory = path.join(root, entry.name);
    const metadata = await lstat(directory);
    const owner = Number(entry.name.slice(0, entry.name.indexOf("-")));
    if (owner !== process.pid) {
      if (now - metadata.mtimeMs < 24 * 60 * 60 * 1000) continue;
      try {
        process.kill(owner, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
    }
    await privateDirectory(directory);
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (
        !child.isFile() ||
        child.isSymbolicLink() ||
        (child.name !== "pending" && !/^[a-f0-9]{64}\.blob$/.test(child.name))
      )
        throw failure("mutation_snapshot_material_unsafe");
      await unlink(path.join(directory, child.name));
    }
    await rmdir(directory);
    removed++;
  }
  return removed;
}

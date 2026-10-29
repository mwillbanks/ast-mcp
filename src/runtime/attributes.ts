import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, open, type FileHandle } from "node:fs/promises";

import {
  stageFileSnapshot,
  removeSnapshotBlob,
  FileSnapshotCollection,
  closeSnapshotHandles,
} from "./snapshot-blob";

export interface FileChattrGuard {
  dev: number;
  ino: number;
  sha256: string;
  signal?: AbortSignal;
  beforeMutation?: () => void;
  handle?: FileHandle;
}

function changedFile(filePath: string) {
  return Object.assign(new Error("File changed before attribute mutation"), {
    code: "stale_or_missing_hash",
    details: { affectedPaths: [filePath] },
  });
}

export async function readFileChattrSnapshot(
  filePath: string,
  signal?: AbortSignal,
) {
  const snapshot = await stageFileSnapshot(filePath, signal);
  try {
    const handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    return {
      ...snapshot,
      handle,
      attributes: {
        chmod: snapshot.mode & 0o777,
        chown: { gid: snapshot.gid, uid: snapshot.uid },
      },
    };
  } catch (error) {
    await removeSnapshotBlob(snapshot.sourceBlob, snapshot.namespace);
    throw error;
  }
}

export class FileChattrSnapshots extends FileSnapshotCollection<
  Awaited<ReturnType<typeof readFileChattrSnapshot>>
> {
  override async [Symbol.asyncDispose](): Promise<void> {
    try {
      await closeSnapshotHandles(
        [...this.values()].map((snapshot) => snapshot.handle),
      );
    } finally {
      await super[Symbol.asyncDispose]();
    }
  }
}

async function verifyChattrHandle(
  handle: FileHandle,
  filePath: string,
  guard: FileChattrGuard,
) {
  guard.signal?.throwIfAborted();
  const metadata = await handle.stat();
  const current = await lstat(filePath);
  if (
    !metadata.isFile() ||
    current.isSymbolicLink() ||
    metadata.dev !== guard.dev ||
    metadata.ino !== guard.ino ||
    current.dev !== guard.dev ||
    current.ino !== guard.ino
  )
    throw changedFile(filePath);
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  for (;;) {
    guard.signal?.throwIfAborted();
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, metadata.size - position + 1),
      position,
    );
    if (position + bytesRead > metadata.size) throw changedFile(filePath);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (hash.digest("hex") !== guard.sha256) throw changedFile(filePath);
  const after = await lstat(filePath);
  if (after.dev !== guard.dev || after.ino !== guard.ino)
    throw changedFile(filePath);
  guard.signal?.throwIfAborted();
}

async function applyGuardedChattr(
  filePath: string,
  chattr: FileChattr | undefined,
  beforeChange: (() => Promise<void>) | undefined,
  guard: FileChattrGuard,
) {
  const validated = validateFileChattr(chattr);
  const handle =
    guard.handle ??
    (await open(
      filePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    ));
  try {
    await verifyChattrHandle(handle, filePath, guard);
    const before = await handle.stat();
    let changed = false;
    const check = async (rollback = false) => {
      await beforeChange?.();
      await verifyChattrHandle(
        handle,
        filePath,
        rollback ? { ...guard, signal: undefined } : guard,
      );
    };
    try {
      if (validated?.chown) {
        await check();
        guard.beforeMutation?.();
        await handle.chown(validated.chown.uid, validated.chown.gid);
        changed = true;
      }
      if (validated?.chmod !== undefined) {
        await check();
        guard.beforeMutation?.();
        await handle.chmod(validated.chmod);
        changed = true;
      }
      await verifyChattrHandle(handle, filePath, guard);
      await handle.sync();
    } catch (error) {
      if (changed) {
        try {
          await check(true);
          if (validated?.chown && process.platform !== "win32")
            await handle.chown(before.uid, before.gid);
          await check(true);
          await handle.chmod(before.mode & 0o777);
          await handle.sync();
        } catch (rollbackError) {
          throw Object.assign(
            new AggregateError(
              [error, rollbackError],
              "File attribute mutation failed and rollback was incomplete",
            ),
            { details: { affectedPaths: [filePath] } },
          );
        }
      }
      throw error;
    }
    const after = await handle.stat();
    return {
      chmod: after.mode & 0o777,
      chown: { gid: after.gid, uid: after.uid },
    };
  } finally {
    if (!guard.handle) await handle.close();
  }
}

export interface FileChattr {
  chmod?: number;
  chown?: {
    gid: number;
    uid: number;
  };
}

export function validateFileChattr(
  chattr: FileChattr | undefined,
): FileChattr | undefined {
  if (!chattr) return undefined;
  if (
    chattr.chmod !== undefined &&
    (!Number.isInteger(chattr.chmod) ||
      chattr.chmod < 0 ||
      chattr.chmod > 0o777)
  )
    throw new Error("chmod must be an integer between 0 and 0o777");
  if (
    chattr.chown &&
    (!Number.isInteger(chattr.chown.uid) ||
      chattr.chown.uid < 0 ||
      !Number.isInteger(chattr.chown.gid) ||
      chattr.chown.gid < 0)
  )
    throw new Error("chown uid and gid must be non-negative integers");
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (
    chattr.chown &&
    (uid === undefined ||
      gid === undefined ||
      chattr.chown.uid !== uid ||
      chattr.chown.gid !== gid)
  )
    throw new Error("chown may only preserve the server process owner");
  return chattr;
}

export async function applyFileChattr(
  filePath: string,
  chattr: FileChattr | undefined,
  beforeChange?: () => Promise<void>,
  guard?: FileChattrGuard,
) {
  if (guard) return applyGuardedChattr(filePath, chattr, beforeChange, guard);
  const validated = validateFileChattr(chattr);
  const before = await resultingFileChattr(filePath);
  if (!validated) return before;
  try {
    if (validated.chown) {
      await beforeChange?.();
      await chown(filePath, validated.chown.uid, validated.chown.gid);
    }
    if (validated.chmod !== undefined) {
      await beforeChange?.();
      await chmod(filePath, validated.chmod);
    }
  } catch (error) {
    const restorationErrors: unknown[] = [];
    if (validated.chown && process.platform !== "win32") {
      try {
        await beforeChange?.();
        await chown(filePath, before.chown.uid, before.chown.gid);
      } catch (restoreError) {
        restorationErrors.push(restoreError);
      }
    }
    if (validated.chmod !== undefined) {
      try {
        await beforeChange?.();
        await chmod(filePath, before.chmod);
      } catch (restoreError) {
        restorationErrors.push(restoreError);
      }
    }
    try {
      const restored = await resultingFileChattr(filePath);
      if (
        (validated.chmod !== undefined && restored.chmod !== before.chmod) ||
        (validated.chown &&
          process.platform !== "win32" &&
          (restored.chown.uid !== before.chown.uid ||
            restored.chown.gid !== before.chown.gid))
      )
        restorationErrors.push(new Error("File attributes were not restored"));
    } catch (restoreError) {
      restorationErrors.push(restoreError);
    }
    if (restorationErrors.length > 0)
      throw new AggregateError(
        [error, ...restorationErrors],
        "File attribute mutation failed and rollback was incomplete",
      );
    throw error;
  }
  return resultingFileChattr(filePath);
}

export async function resultingFileChattr(filePath: string) {
  const metadata = await lstat(filePath);
  return {
    chmod: metadata.mode & 0o777,
    chown: { gid: metadata.gid, uid: metadata.uid },
  };
}

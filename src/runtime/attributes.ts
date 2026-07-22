import { chmod, chown, lstat } from "node:fs/promises";

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
) {
  const validated = validateFileChattr(chattr);
  const before = await resultingFileChattr(filePath);
  if (!validated) return before;
  try {
    if (validated.chown)
      await chown(filePath, validated.chown.uid, validated.chown.gid);
    if (validated.chmod !== undefined) await chmod(filePath, validated.chmod);
  } catch (error) {
    await chown(filePath, before.chown.uid, before.chown.gid).catch(
      () => undefined,
    );
    await chmod(filePath, before.chmod).catch(() => undefined);
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

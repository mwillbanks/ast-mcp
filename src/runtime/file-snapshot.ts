import { lstat } from "node:fs/promises";
import { sha256File } from "./hash";

export interface FileSnapshot {
  content: Buffer;
  gid: number;
  mode: number;
  sha256: string;
  uid: number;
}

export async function readFileSnapshot(
  filePath: string,
): Promise<FileSnapshot> {
  const [sha256, content, metadata] = await Promise.all([
    sha256File(filePath),
    Bun.file(filePath)
      .bytes()
      .then((bytes) => Buffer.from(bytes)),
    lstat(filePath),
  ]);
  return {
    content,
    gid: metadata.gid,
    mode: metadata.mode,
    sha256,
    uid: metadata.uid,
  };
}

import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { sha256 } from "./hash";

export interface FileSnapshot {
  content: Buffer;
  gid: number;
  mode: number;
  sha256: string;
  uid: number;
}

export async function readFileSnapshot(
  filePath: string,
  signal?: AbortSignal,
): Promise<FileSnapshot> {
  const deadline = AbortSignal.timeout(30_000);
  const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  readSignal.throwIfAborted();
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    readSignal.throwIfAborted();
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw Object.assign(
        new Error(`Snapshot requires a regular file: ${filePath}`),
        { code: "file_not_regular", retryable: false },
      );
    const content = await handle.readFile({ signal: readSignal });
    readSignal.throwIfAborted();
    return {
      content,
      gid: metadata.gid,
      mode: metadata.mode,
      sha256: sha256(content),
      uid: metadata.uid,
    };
  } finally {
    await handle.close();
  }
}

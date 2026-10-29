import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export const FILE_HASH_CHUNK_BYTES = 1024 * 1024;
export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Hash an open regular file without closing it or changing its read position.
 * The caller owns descriptor identity and metadata consistency checks.
 */
export async function sha256Handle(
  handle: FileHandle,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = AbortSignal.timeout(30_000);
  const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  readSignal.throwIfAborted();
  const metadata = await handle.stat();
  if (!metadata.isFile())
    throw Object.assign(new Error("Hashing requires a regular file"), {
      code: "file_not_regular",
      retryable: false,
    });
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(FILE_HASH_CHUNK_BYTES);
  let position = 0;
  while (true) {
    readSignal.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    readSignal.throwIfAborted();
    if (bytesRead === 0) return hash.digest("hex");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

export async function sha256File(
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = AbortSignal.timeout(30_000);
  const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  readSignal.throwIfAborted();
  const hash = createHash("sha256");
  const stream = createReadStream(filePath, {
    highWaterMark: FILE_HASH_CHUNK_BYTES,
    signal: readSignal,
  });
  try {
    for await (const chunk of stream) {
      readSignal.throwIfAborted();
      hash.update(chunk);
    }
    readSignal.throwIfAborted();
    return hash.digest("hex");
  } finally {
    stream.destroy();
  }
}

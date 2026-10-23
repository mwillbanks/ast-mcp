import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function sha256File(
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = AbortSignal.timeout(30_000);
  const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  readSignal.throwIfAborted();
  const hash = createHash("sha256");
  const stream = createReadStream(filePath, { signal: readSignal });
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

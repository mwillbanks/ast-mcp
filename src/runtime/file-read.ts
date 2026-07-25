import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { astCapable } from "../ast-bro/capability";
import { detectAstLanguage } from "../patch/languages";
import { sha256File } from "./hash";
import { resolveWritablePath } from "./paths";

const FILE_READ_DEFAULT_LINES = [0, 100] as const;
export const FILE_READ_MAX_BATCH = 50;
export const FILE_READ_MAX_BYTES = 1024 * 1024;
export const FILE_READ_MAX_LINES = 1000;

export interface FileReadRequest {
  filePath: string;
  lines?: [number, number];
  maxBytes?: number;
}

async function mapConcurrently<Input, Output>(
  inputs: Input[],
  operation: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(inputs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, inputs.length) }, async () => {
      while (next < inputs.length) {
        const index = next;
        next += 1;
        output[index] = await operation(inputs[index] as Input);
      }
    }),
  );
  return output;
}

function validateLineRange(start: number, end: number) {
  if (!Number.isInteger(start) || start < 0)
    throw new Error("file_read line start must be a non-negative integer");
  if (!Number.isInteger(end) || end <= start)
    throw new Error("file_read line end must be greater than line start");
  if (end - start > FILE_READ_MAX_LINES)
    throw new Error(
      `file_read line ranges are capped at ${FILE_READ_MAX_LINES} lines`,
    );
}

function validateMaxBytes(maxBytes: number) {
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > FILE_READ_MAX_BYTES
  )
    throw new Error(
      `file_read maxBytes must be between 1 and ${FILE_READ_MAX_BYTES}`,
    );
}

function validateRequest(request: FileReadRequest) {
  const [start, end] = request.lines ?? FILE_READ_DEFAULT_LINES;
  const maxBytes = request.maxBytes ?? FILE_READ_MAX_BYTES;
  validateLineRange(start, end);
  validateMaxBytes(maxBytes);
  return { lines: [start, end] as [number, number], maxBytes };
}

class LineRangeCollector {
  private line = 0;
  private moreInChunk = false;
  private readonly selected: Buffer[] = [];
  private selectedBytes = 0;
  private truncated = false;

  constructor(
    private readonly lines: [number, number],
    private readonly maxBytes: number,
  ) {}

  consume(chunk: Buffer) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const segmentEnd = newline < 0 ? chunk.length : newline + 1;
      if (this.lineSelected() && this.append(chunk, offset, segmentEnd)) {
        this.moreInChunk = true;
        return true;
      }
      offset = segmentEnd;
      if (newline < 0) return false;
      this.line += 1;
      if (this.line >= this.lines[1]) {
        this.moreInChunk = offset < chunk.length;
        return true;
      }
    }
    return false;
  }

  result(fileSize: number, bytesRead: number) {
    const contentBuffer = Buffer.concat(this.selected, this.selectedBytes);
    const returnedLineCount = bufferLineCount(contentBuffer);
    return {
      content: contentBuffer.toString("utf8"),
      hasMore: this.truncated || this.moreInChunk || bytesRead < fileSize,
      lines: {
        requested: this.lines,
        returned: [this.lines[0], this.lines[0] + returnedLineCount],
      },
      truncated: this.truncated,
    };
  }

  private lineSelected() {
    return this.line >= this.lines[0] && this.line < this.lines[1];
  }

  private append(chunk: Buffer, offset: number, segmentEnd: number) {
    const remaining = this.maxBytes - this.selectedBytes;
    const length = segmentEnd - offset;
    if (length > remaining) {
      if (remaining > 0) {
        this.selected.push(chunk.subarray(offset, offset + remaining));
        this.selectedBytes += remaining;
      }
      this.truncated = true;
      return true;
    }
    if (length > 0) {
      this.selected.push(chunk.subarray(offset, segmentEnd));
      this.selectedBytes += length;
    }
    return false;
  }
}

function bufferLineCount(content: Buffer) {
  let count = 0;
  for (const byte of content) if (byte === 10) count += 1;
  if (content.length > 0 && content.at(-1) !== 10) count += 1;
  return count;
}

async function readLineRange(
  filePath: string,
  fileSize: number,
  lines: [number, number],
  maxBytes: number,
) {
  const collector = new LineRangeCollector(lines, maxBytes);
  const stream = createReadStream(filePath);
  try {
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (collector.consume(chunk)) break;
    }
  } finally {
    stream.destroy();
  }
  return collector.result(fileSize, stream.bytesRead);
}

async function hashFileSafely(filePath: string) {
  const resolved = await resolveWritablePath(filePath);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  return {
    filePath: resolved,
    sha256: await sha256File(resolved),
    size: metadata.size,
  };
}

export async function hashFilesSafely(filePaths: string[]) {
  if (filePaths.length < 1 || filePaths.length > FILE_READ_MAX_BATCH)
    throw new Error(
      `file_hash requires between 1 and ${FILE_READ_MAX_BATCH} paths`,
    );
  return mapConcurrently(filePaths, hashFileSafely);
}

export async function readFileSafely(request: FileReadRequest) {
  const resolved = await resolveWritablePath(request.filePath);
  const language = detectAstLanguage(resolved);
  if (await astCapable(resolved, language))
    throw new Error(
      "REJECTED: AST-capable files must use map, show, search, context, or run; use file_hash when only SHA-256 is required",
    );

  const metadata = await stat(resolved);
  if (!metadata.isFile())
    throw new Error(`Not a regular file: ${request.filePath}`);
  const { lines, maxBytes } = validateRequest(request);
  const [slice, sha256] = await Promise.all([
    readLineRange(resolved, metadata.size, lines, maxBytes),
    sha256File(resolved),
  ]);
  return {
    ...slice,
    filePath: resolved,
    sha256,
    size: metadata.size,
  };
}

export async function readFilesSafely(requests: FileReadRequest[]) {
  if (requests.length < 1 || requests.length > FILE_READ_MAX_BATCH)
    throw new Error(
      `file_read requires between 1 and ${FILE_READ_MAX_BATCH} files`,
    );
  return mapConcurrently(requests, readFileSafely);
}

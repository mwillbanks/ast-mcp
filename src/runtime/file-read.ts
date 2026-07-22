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

function validateRequest(request: FileReadRequest) {
  const [start, end] = request.lines ?? FILE_READ_DEFAULT_LINES;
  const maxBytes = request.maxBytes ?? FILE_READ_MAX_BYTES;
  if (!Number.isInteger(start) || start < 0)
    throw new Error("file_read line start must be a non-negative integer");
  if (!Number.isInteger(end) || end <= start)
    throw new Error("file_read line end must be greater than line start");
  if (end - start > FILE_READ_MAX_LINES)
    throw new Error(
      `file_read line ranges are capped at ${FILE_READ_MAX_LINES} lines`,
    );
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > FILE_READ_MAX_BYTES
  )
    throw new Error(
      `file_read maxBytes must be between 1 and ${FILE_READ_MAX_BYTES}`,
    );
  return { lines: [start, end] as [number, number], maxBytes };
}

async function readLineRange(
  filePath: string,
  fileSize: number,
  lines: [number, number],
  maxBytes: number,
) {
  const [start, end] = lines;
  const selected: Buffer[] = [];
  let selectedBytes = 0;
  let line = 0;
  let moreInChunk = false;
  let truncated = false;
  const stream = createReadStream(filePath);

  try {
    outer: for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const segmentEnd = newline < 0 ? chunk.length : newline + 1;
        if (line >= start && line < end) {
          const remaining = maxBytes - selectedBytes;
          const length = segmentEnd - offset;
          if (length > remaining) {
            if (remaining > 0) {
              selected.push(chunk.subarray(offset, offset + remaining));
              selectedBytes += remaining;
            }
            truncated = true;
            moreInChunk = true;
            break outer;
          }
          if (length > 0) {
            selected.push(chunk.subarray(offset, segmentEnd));
            selectedBytes += length;
          }
        }
        offset = segmentEnd;
        if (newline >= 0) {
          line += 1;
          if (line >= end) {
            moreInChunk = offset < chunk.length;
            break outer;
          }
        } else break;
      }
    }
  } finally {
    stream.destroy();
  }

  const contentBuffer = Buffer.concat(selected, selectedBytes);
  let returnedLineCount = 0;
  for (const byte of contentBuffer) if (byte === 10) returnedLineCount += 1;
  if (contentBuffer.length > 0 && contentBuffer.at(-1) !== 10)
    returnedLineCount += 1;

  return {
    content: contentBuffer.toString("utf8"),
    hasMore: truncated || moreInChunk || stream.bytesRead < fileSize,
    lines: {
      requested: lines,
      returned: [start, start + returnedLineCount],
    },
    truncated,
  };
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

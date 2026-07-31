import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";

import { callAstBro } from "../ast-bro/client";
import { currentConfig } from "../config";
import { selectDocumentValues } from "./document-inspection";
import {
  type FileCapabilities,
  type FileReadMode,
  inspectFileCapabilities,
} from "./file-capabilities";
import { sha256File } from "./hash";
import { resolveWritablePath } from "./paths";

const FILE_READ_DEFAULT_LINES = [0, 100] as const;
export const FILE_READ_MAX_BATCH = 50;
export const FILE_READ_MAX_BYTES = 1024 * 1024;
export const FILE_READ_MAX_LINES = 1000;

export interface FileReadRequest {
  filePath: string;
  language?: string;
  lines?: [number, number];
  maxBytes?: number;
  mode?: FileReadMode;
  selectors?: string[];
  symbols?: string[];
}

export interface FileReadResult {
  ast?: unknown;
  capabilities?: FileCapabilities;
  content: string;
  filePath: string;
  hasMore: boolean;
  lines: { requested: [number, number]; returned: number[] };
  requestedMode?: FileReadMode;
  resolvedMode?: Exclude<FileReadMode, "auto">;
  sha256: string;
  size: number;
  truncated: boolean;
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
  const resolved = await resolveWritablePath(filePath, "read");
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

function resolveReadMode(
  requestedMode: FileReadMode,
  capabilities: FileCapabilities,
): Exclude<FileReadMode, "auto"> {
  if (requestedMode !== "auto") return requestedMode;
  return capabilities.effective.read.includes("ast") ? "ast" : "text";
}

function assertReadMode(
  resolved: string,
  requestedMode: FileReadMode,
  resolvedMode: Exclude<FileReadMode, "auto">,
  capabilities: FileCapabilities,
): void {
  if (capabilities.effective.read.includes(resolvedMode)) return;
  throw Object.assign(
    new Error(
      `file_read mode '${resolvedMode}' is unavailable for ${resolved}; available modes: ${capabilities.effective.read.join(", ") || "none"}`,
    ),
    {
      code: "read_mode_unavailable",
      details: { capabilities, requestedMode, resolvedMode },
      retryable: true,
      suggestedNextCall: "file_capabilities",
    },
  );
}

async function readDocumentAst(
  resolved: string,
  size: number,
  selectors: string[] | undefined,
): Promise<unknown> {
  if (size > FILE_READ_MAX_BYTES)
    throw Object.assign(
      new Error(
        `Structured document exceeds the ${FILE_READ_MAX_BYTES}-byte inspection limit; use bounded text mode`,
      ),
      {
        code: "document_source_too_large",
        retryable: true,
        suggestedNextCall: "file_read",
      },
    );
  const source = await readFile(resolved, "utf8");
  return {
    schema: "ast-mcp.document-read.v1",
    values: selectDocumentValues(
      resolved,
      source,
      selectors?.length ? selectors : [""],
    ),
  };
}

async function readSourceAst(
  resolved: string,
  symbols: string[] | undefined,
): Promise<unknown> {
  const config = await currentConfig();
  if (symbols?.length)
    return callAstBro(
      "show",
      { json: true, path: resolved, symbols },
      config.projectRoot,
    );
  return callAstBro(
    "map",
    { json: true, paths: [resolved] },
    config.projectRoot,
  );
}

async function readAst(
  request: FileReadRequest,
  resolved: string,
  size: number,
  capabilities: FileCapabilities,
): Promise<unknown> {
  if (capabilities.kind === "document")
    return readDocumentAst(resolved, size, request.selectors);
  return readSourceAst(resolved, request.symbols);
}

export async function readFileSafely(
  request: FileReadRequest,
): Promise<FileReadResult> {
  const resolved = await resolveWritablePath(request.filePath, "read");
  const metadata = await stat(resolved);
  if (!metadata.isFile())
    throw new Error(`Not a regular file: ${request.filePath}`);
  const capabilities = await inspectFileCapabilities(
    resolved,
    request.language,
  );
  const requestedMode = request.mode ?? "auto";
  const resolvedMode = resolveReadMode(requestedMode, capabilities);
  assertReadMode(resolved, requestedMode, resolvedMode, capabilities);
  const sha256 = await sha256File(resolved);
  if (resolvedMode === "ast") {
    const ast = await readAst(request, resolved, metadata.size, capabilities);
    return {
      ast,
      capabilities,
      content: JSON.stringify(ast),
      filePath: resolved,
      hasMore: false,
      lines: { requested: [0, 0], returned: [0, 0] },
      requestedMode,
      resolvedMode,
      sha256,
      size: metadata.size,
      truncated: false,
    };
  }
  const { lines, maxBytes } = validateRequest(request);
  const slice = await readLineRange(resolved, metadata.size, lines, maxBytes);
  return {
    ...slice,
    capabilities,
    filePath: resolved,
    requestedMode,
    resolvedMode,
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

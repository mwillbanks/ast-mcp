import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { currentConfig } from "../config";
import {
  type ParserLanguageId,
  parseSource,
} from "../intelligence/parser/index.ts";
import {
  currentWorkspace,
  readGitRevisionFile,
} from "../intelligence/workspace/index.ts";
import {
  parseStructuredDocument,
  selectDocumentValues,
} from "./document-inspection";
import {
  type FileCapabilities,
  type FileReadMode,
  inspectFileCapabilities,
} from "./file-capabilities";
import { sha256, sha256File } from "./hash";
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

export async function readWorkspaceRevisionBytes(
  resolved: string,
): Promise<Uint8Array | undefined> {
  const workspace = currentWorkspace();
  if (!workspace || workspace.selectedRevision.selector.kind === "working")
    return undefined;
  return readGitRevisionFile(
    workspace.git,
    workspace.selectedRevision,
    resolved,
  );
}

async function hashFileSafely(filePath: string) {
  const resolved = await resolveWritablePath(filePath, "read");
  const bytes = await readWorkspaceRevisionBytes(resolved);
  if (bytes)
    return {
      filePath: resolved,
      sha256: sha256(bytes),
      size: bytes.byteLength,
    };
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  return {
    filePath: resolved,
    sha256: await sha256File(resolved),
    size: metadata.size,
  };
}

export async function inspectWorkspaceFileCapabilitiesSafely(
  filePaths: string[],
) {
  return mapConcurrently(filePaths, async (filePath) => {
    const resolved = await resolveWritablePath(filePath, "read");
    const historical = await readWorkspaceRevisionBytes(resolved);
    return historical
      ? historicalCapabilities(resolved, historical)
      : inspectFileCapabilities(resolved);
  });
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
  historicalSource?: string,
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
  const source = historicalSource ?? (await Bun.file(resolved).text());
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
  language: string,
  historicalSource?: string,
): Promise<unknown> {
  const source = historicalSource ?? (await Bun.file(resolved).text());
  const facts = parseSource({
    languageId: language as ParserLanguageId,
    source,
  });
  const requested = new Set(symbols ?? []);
  const selected = symbols?.length
    ? facts.symbols.filter(
        (symbol) =>
          requested.has(symbol.name) || requested.has(symbol.qualifiedName),
      )
    : facts.symbols;
  return {
    diagnostics: facts.diagnostics,
    imports: facts.imports,
    language: facts.languageId,
    partial: facts.partial,
    schema: "ast-mcp.source-read.v1",
    symbols: selected.map((symbol) => ({
      ...symbol,
      source: source.slice(
        symbol.range.startCoordinate.utf16Offset,
        symbol.range.endCoordinate.utf16Offset,
      ),
    })),
    unmatched: [...requested].filter(
      (name) =>
        !selected.some(
          (symbol) => symbol.name === name || symbol.qualifiedName === name,
        ),
    ),
  };
}

async function readAst(
  request: FileReadRequest,
  resolved: string,
  size: number,
  capabilities: FileCapabilities,
  historicalSource?: string,
): Promise<unknown> {
  if (capabilities.kind === "document")
    return readDocumentAst(resolved, size, request.selectors, historicalSource);
  if (!capabilities.language)
    throw Object.assign(new Error("Source AST language is unavailable"), {
      code: "ast_capability_unavailable",
      retryable: true,
      suggestedNextCall: "file_capabilities",
    });
  return readSourceAst(
    resolved,
    request.symbols,
    capabilities.language,
    historicalSource,
  );
}

export async function historicalCapabilities(
  resolved: string,
  bytes: Uint8Array,
  languageOverride?: string,
): Promise<FileCapabilities> {
  const config = await currentConfig();
  const source = Buffer.from(bytes);
  const binary = source.subarray(0, 8192).includes(0);
  const extension = path.extname(resolved).toLowerCase();
  const document = [".json", ".jsonc", ".toml", ".yaml", ".yml"].includes(
    extension,
  );
  let parseStatus: FileCapabilities["parseStatus"] = "unsupported";
  if (document && !binary) {
    try {
      parseStructuredDocument(resolved, source.toString("utf8"));
      parseStatus = "parseable";
    } catch {
      parseStatus = "invalid";
    }
  }
  const intrinsicRead: Array<"ast" | "text"> = [];
  if (document && parseStatus === "parseable") intrinsicRead.push("ast");
  if (!binary) intrinsicRead.push("text");
  return {
    effective: {
      aiderMatchers: config.files.patch.aiderMatchers,
      patch: [],
      read: intrinsicRead.filter((mode) =>
        config.files.read.modes.includes(mode),
      ),
    },
    filePath: resolved,
    generation: config.generation,
    intrinsic: { patch: [], read: intrinsicRead, search: [] },
    kind: binary
      ? "binary"
      : document
        ? "document"
        : languageOverride
          ? "source"
          : "text",
    language: languageOverride,
    parseErrorCount: document
      ? parseStatus === "parseable"
        ? 0
        : 1
      : undefined,
    parseStatus,
    size: bytes.byteLength,
  };
}

export async function readFileSafely(
  request: FileReadRequest,
): Promise<FileReadResult> {
  const resolved = await resolveWritablePath(request.filePath, "read");
  const historical = await readWorkspaceRevisionBytes(resolved);
  const historicalBytes = historical ? Buffer.from(historical) : undefined;
  const metadata = historicalBytes ? undefined : await stat(resolved);
  if (metadata && !metadata.isFile())
    throw new Error(`Not a regular file: ${request.filePath}`);
  const size = historicalBytes?.byteLength ?? Number(metadata?.size ?? 0);
  const capabilities = historicalBytes
    ? await historicalCapabilities(resolved, historicalBytes, request.language)
    : await inspectFileCapabilities(resolved, request.language);
  const requestedMode = request.mode ?? "auto";
  const resolvedMode = resolveReadMode(requestedMode, capabilities);
  assertReadMode(resolved, requestedMode, resolvedMode, capabilities);
  const digest = historicalBytes
    ? sha256(historicalBytes)
    : await sha256File(resolved);
  if (resolvedMode === "ast") {
    const ast = await readAst(
      request,
      resolved,
      size,
      capabilities,
      historicalBytes?.toString("utf8"),
    );
    return {
      ast,
      capabilities,
      content: JSON.stringify(ast),
      filePath: resolved,
      hasMore: false,
      lines: { requested: [0, 0], returned: [0, 0] },
      requestedMode,
      resolvedMode,
      sha256: digest,
      size,
      truncated: false,
    };
  }
  const { lines, maxBytes } = validateRequest(request);
  const slice = historicalBytes
    ? (() => {
        const collector = new LineRangeCollector(lines, maxBytes);
        collector.consume(historicalBytes);
        return collector.result(size, size);
      })()
    : await readLineRange(resolved, size, lines, maxBytes);
  return {
    ...slice,
    capabilities,
    filePath: resolved,
    requestedMode,
    resolvedMode,
    sha256: digest,
    size,
  };
}

export async function readFilesSafely(requests: FileReadRequest[]) {
  if (requests.length < 1 || requests.length > FILE_READ_MAX_BATCH)
    throw new Error(
      `file_read requires between 1 and ${FILE_READ_MAX_BATCH} files`,
    );
  return mapConcurrently(requests, readFileSafely);
}

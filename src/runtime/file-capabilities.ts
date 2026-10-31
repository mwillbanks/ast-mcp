import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { currentConfig, type ResolvedConfig } from "../config";
import {
  ParserError,
  type ParserLanguageId,
  type ParserWorkerPool,
  parseSource,
} from "../intelligence/parser/index.ts";
import { detectAstLanguage } from "../patch/languages";
import { parseStructuredDocument } from "./document-inspection";
import { resolveWritablePath } from "./paths";

export type FileReadMode = "auto" | "ast" | "text";
export type PatchStrategyName = "ast" | "aider_block";
export type AiderMatcher =
  | "exact"
  | "whitespace"
  | "relative-indentation"
  | "diff-match-patch";
export type FileKind = "source" | "document" | "text" | "binary";
export type ParseStatus = "parseable" | "invalid" | "unsupported";

export interface FileCapabilities {
  effective: {
    aiderMatchers: AiderMatcher[];
    patch: PatchStrategyName[];
    read: Array<Exclude<FileReadMode, "auto">>;
  };
  filePath: string;
  generation: number;
  intrinsic: {
    patch: PatchStrategyName[];
    read: Array<Exclude<FileReadMode, "auto">>;
    search: Array<"ast">;
  };
  kind: FileKind;
  language?: string;
  parseErrorCount?: number;
  parseStatus: ParseStatus;
  size: number;
}

const documentExtensions = new Set([
  ".json",
  ".jsonc",
  ".toml",
  ".yaml",
  ".yml",
]);
const astPatchDocumentExtensions = new Set([".json", ".yaml", ".yml"]);

function configuredMethods(config: ResolvedConfig) {
  return {
    aiderMatchers: config.files.patch.aiderMatchers,
    patch: config.files.patch.strategies,
    read: config.files.read.modes,
  };
}

function intersection<T extends string>(left: T[], right: T[]): T[] {
  const permitted = new Set(right);
  return left.filter((value) => permitted.has(value));
}

async function binaryFile(
  filePath: string,
  size: number,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (size === 0) return false;
  const stream = createReadStream(filePath, {
    end: Math.min(size, 8192) - 1,
    signal,
  });
  try {
    for await (const chunk of stream)
      if (Buffer.from(chunk).includes(0)) return true;
    return false;
  } finally {
    stream.destroy();
  }
}

async function parseState(
  filePath: string,
  language: string | undefined,
  signal?: AbortSignal,
  parse?: ParserWorkerPool["parse"],
) {
  signal?.throwIfAborted();
  const extension = path.extname(filePath).toLowerCase();
  if (documentExtensions.has(extension)) {
    try {
      parseStructuredDocument(
        filePath,
        await readFile(filePath, { encoding: "utf8", signal }),
      );
      return { errorCount: 0, status: "parseable" as const };
    } catch {
      signal?.throwIfAborted();
      return { errorCount: 1, status: "invalid" as const };
    }
  }
  if (!language)
    return { errorCount: undefined, status: "unsupported" as const };
  try {
    const request = {
      languageId: language as ParserLanguageId,
      source: await readFile(filePath, { encoding: "utf8", signal }),
    };
    const facts = parse
      ? await parse(request, { signal })
      : parseSource(request);
    const errorCount = facts.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    ).length;
    return {
      errorCount,
      status: errorCount === 0 ? ("parseable" as const) : ("invalid" as const),
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (
      parse &&
      error instanceof ParserError &&
      error.code !== "invalid-language" &&
      error.code !== "source-too-large"
    )
      throw error;
    return { errorCount: undefined, status: "unsupported" as const };
  }
}

async function capabilityParseState(
  isBinary: boolean,
  filePath: string,
  language: string | undefined,
  signal?: AbortSignal,
  parse?: ParserWorkerPool["parse"],
) {
  signal?.throwIfAborted();
  if (isBinary)
    return { errorCount: undefined, status: "unsupported" as const };
  return parseState(filePath, language, signal, parse);
}

function supportsAstRead(
  isBinary: boolean,
  isDocument: boolean,
  language: string | undefined,
  parseStatus: ParseStatus,
): boolean {
  if (isBinary || parseStatus !== "parseable") return false;
  return isDocument || Boolean(language);
}

function supportsAstPatch(
  astRead: boolean,
  isDocument: boolean,
  extension: string,
  language: string | undefined,
): boolean {
  if (!astRead || language === "markdown") return false;
  return !isDocument || astPatchDocumentExtensions.has(extension);
}

function intrinsicMethods(
  isBinary: boolean,
  isDocument: boolean,
  extension: string,
  language: string | undefined,
  parseStatus: ParseStatus,
) {
  const read: Array<"ast" | "text"> = [];
  const patch: PatchStrategyName[] = [];
  const astRead = supportsAstRead(isBinary, isDocument, language, parseStatus);
  const astPatch = supportsAstPatch(astRead, isDocument, extension, language);
  if (astRead) read.push("ast");
  if (!isBinary) read.push("text");
  if (astPatch) patch.push("ast");
  if (!isBinary) patch.push("aider_block");
  return { astRead, patch, read };
}

function classifyFile(
  isBinary: boolean,
  isDocument: boolean,
  language: string | undefined,
): FileKind {
  if (isBinary) return "binary";
  if (isDocument) return "document";
  if (language) return "source";
  return "text";
}

export async function inspectFileCapabilities(
  filePath: string,
  languageOverride?: string,
  signal?: AbortSignal,
  parse?: ParserWorkerPool["parse"],
): Promise<FileCapabilities> {
  signal?.throwIfAborted();
  const metadata = await lstat(filePath);
  signal?.throwIfAborted();
  if (!metadata.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  const config = await currentConfig();
  const configured = configuredMethods(config);
  const language = languageOverride ?? detectAstLanguage(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const isBinary = await binaryFile(filePath, metadata.size, signal);
  const state = await capabilityParseState(
    isBinary ||
      Boolean(
        parse &&
        metadata.size >
          (documentExtensions.has(extension) ? 1024 * 1024 : 2 * 1024 * 1024),
      ),
    filePath,
    language,
    signal,
    parse,
  );
  signal?.throwIfAborted();
  const isDocument = documentExtensions.has(extension);
  const intrinsic = intrinsicMethods(
    isBinary,
    isDocument,
    extension,
    language,
    state.status,
  );
  return {
    effective: {
      aiderMatchers: configured.aiderMatchers,
      patch: intersection(intrinsic.patch, configured.patch),
      read: intersection(intrinsic.read, configured.read),
    },
    filePath,
    generation: config.generation,
    intrinsic: {
      patch: intrinsic.patch,
      read: intrinsic.read,
      search: intrinsic.astRead ? ["ast"] : [],
    },
    kind: classifyFile(isBinary, isDocument, language),
    language,
    parseErrorCount: state.errorCount,
    parseStatus: state.status,
    size: metadata.size,
  };
}

export async function inspectFileCapabilitiesSafely(filePaths: string[]) {
  return Promise.all(
    filePaths.map(async (filePath) =>
      inspectFileCapabilities(await resolveWritablePath(filePath, "read")),
    ),
  );
}

export async function validateStructuredCandidate(
  capabilities: FileCapabilities,
  candidate: string,
): Promise<void> {
  if (capabilities.kind === "document") {
    try {
      parseStructuredDocument(capabilities.filePath, candidate);
      return;
    } catch (error) {
      throw Object.assign(
        new Error(
          `Patch candidate is not valid ${capabilities.language ?? "structured data"}: ${error instanceof Error ? error.message : String(error)}`,
        ),
        { code: "candidate_parse_error", retryable: true },
      );
    }
  }
  if (!capabilities.language || capabilities.kind !== "source") return;
  // Generic SQL recovery nodes do not establish dialect syntax validity.
  if (capabilities.language === "sql") return;
  if (capabilities.parseErrorCount === undefined) return;
  let candidateErrors: number;
  try {
    candidateErrors = parseSource({
      languageId: capabilities.language as ParserLanguageId,
      source: candidate,
    }).diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    ).length;
  } catch {
    candidateErrors = Number.POSITIVE_INFINITY;
  }
  if (
    capabilities.parseErrorCount !== undefined &&
    candidateErrors > capabilities.parseErrorCount
  )
    throw Object.assign(
      new Error("Patch candidate increases structural parse errors"),
      {
        code: "candidate_parse_error",
        details: {
          before: capabilities.parseErrorCount,
          candidate: candidateErrors,
        },
        retryable: true,
      },
    );
}

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { currentConfig, type ResolvedConfig } from "../config";
import { configRegistry } from "../config-registry";
import {
  toolFailure,
  toolOutputSchema,
  toolSuccess,
} from "../helpers/mcp-schema";
import {
  parseStructuredDocument,
  selectDocumentValue,
} from "../runtime/document-inspection";
import { sha256 } from "../runtime/hash";
import { evaluatePolicyForCheck } from "../runtime/path-policy";
import { resolveWorkspacePath } from "../runtime/paths";
import { type ConfiguredExecution, localExecution } from "./configured";

interface JsonLocationToken {
  end: number;
  start: number;
  text: string;
  value?: string;
}

function skipJsonTrivia(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor] ?? "")) {
      cursor += 1;
      continue;
    }
    if (source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const close = source.indexOf("*/", cursor + 2);
      cursor = close < 0 ? source.length : close + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function scanJsonString(source: string, start: number): JsonLocationToken {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '"') {
      cursor += 1;
      break;
    }
    cursor += 1;
  }
  const text = source.slice(start, cursor);
  return { end: cursor, start, text, value: JSON.parse(text) as string };
}

function nextJsonLocationToken(
  source: string,
  cursor: number,
): JsonLocationToken | undefined {
  const start = skipJsonTrivia(source, cursor);
  if (start >= source.length) return undefined;
  if (source[start] === '"') return scanJsonString(source, start);
  const punctuation = source[start] ?? "";
  if ("{}[],:".includes(punctuation))
    return { end: start + 1, start, text: punctuation };
  let end = start + 1;
  while (end < source.length && !/[\s{}[\],:]/.test(source[end] ?? ""))
    end += 1;
  return { end, start, text: source.slice(start, end) };
}

function pointerChild(pointer: string, token: string): string {
  const encoded = token.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${pointer}/${encoded}`;
}

function walkJsonObject(
  source: string,
  cursor: number,
  pointer: string,
  locations: Map<string, number>,
): number {
  while (true) {
    const key = nextJsonLocationToken(source, cursor);
    if (!key) return cursor;
    if (key.text === "}") return key.end;
    if (key.value === undefined) return key.end;
    const colon = nextJsonLocationToken(source, key.end);
    if (!colon) return key.end;
    cursor = walkJsonValue(
      source,
      colon.end,
      pointerChild(pointer, key.value),
      locations,
      key.start,
    );
    const delimiter = nextJsonLocationToken(source, cursor);
    if (!delimiter) return cursor;
    if (delimiter.text === "}") return delimiter.end;
    cursor = delimiter.end;
  }
}

function walkJsonArray(
  source: string,
  cursor: number,
  pointer: string,
  locations: Map<string, number>,
): number {
  let index = 0;
  while (true) {
    const item = nextJsonLocationToken(source, cursor);
    if (!item) return cursor;
    if (item.text === "]") return item.end;
    cursor = walkJsonValue(
      source,
      item.start,
      pointerChild(pointer, String(index)),
      locations,
    );
    const delimiter = nextJsonLocationToken(source, cursor);
    if (!delimiter) return cursor;
    if (delimiter.text === "]") return delimiter.end;
    cursor = delimiter.end;
    index += 1;
  }
}

function walkJsonValue(
  source: string,
  cursor: number,
  pointer: string,
  locations: Map<string, number>,
  location?: number,
): number {
  const token = nextJsonLocationToken(source, cursor);
  if (!token) return cursor;
  locations.set(pointer, location ?? token.start);
  if (token.text === "{")
    return walkJsonObject(source, token.end, pointer, locations);
  if (token.text === "[")
    return walkJsonArray(source, token.end, pointer, locations);
  return token.end;
}

function jsonPointerLocations(source: string): Map<string, number> {
  const locations = new Map<string, number>();
  walkJsonValue(source, 0, "", locations);
  return locations;
}

function allOccurrences(source: string, candidate: string): number[] {
  const positions: number[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const position = source.indexOf(candidate, cursor);
    if (position < 0) break;
    positions.push(position);
    cursor = position + Math.max(candidate.length, 1);
  }
  return positions;
}

function fallbackLocationPosition(source: string, selector: string) {
  const token = selector
    .split("/")
    .at(-1)
    ?.replaceAll("~1", "/")
    .replaceAll("~0", "~");
  if (!token) return undefined;
  const candidates = [`"${token}"`, `'${token}'`, `${token}:`, `${token} =`];
  const positions = [
    ...new Set(
      candidates.flatMap((candidate) => allOccurrences(source, candidate)),
    ),
  ];
  return positions.length === 1 ? positions[0] : undefined;
}

function sourceLocation(source: string, selector: string, extension: string) {
  const position =
    extension === ".json" || extension === ".jsonc"
      ? jsonPointerLocations(source).get(selector)
      : selector === ""
        ? 0
        : fallbackLocationPosition(source, selector);
  if (position === undefined) return { selector };
  const preceding = source.slice(0, position);
  const lines = preceding.split("\n");
  return {
    column: (lines.at(-1)?.length ?? 0) + 1,
    line: lines.length,
    selector,
  };
}

const DOCUMENT_SOURCE_LIMIT = 1024 * 1024;

function documentTooLarge(): Error {
  return Object.assign(
    new Error("document_query source exceeds the 1 MiB limit"),
    { code: "document_too_large", retryable: false },
  );
}

async function readBoundedDocument(filePath: string): Promise<Buffer> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw Object.assign(new Error("document_query requires a regular file"), {
        code: "document_not_regular",
        retryable: false,
      });
    if (metadata.size > DOCUMENT_SOURCE_LIMIT) throw documentTooLarge();
    const bytes = Buffer.alloc(DOCUMENT_SOURCE_LIMIT + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > DOCUMENT_SOURCE_LIMIT) throw documentTooLarge();
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function formattingStatus(config: Readonly<ResolvedConfig> | undefined) {
  if (!config) return undefined;
  return {
    enabled: config.formatting.enabled,
    fallback: config.formatting.fallback,
    formatters: config.formatting.formatters.map((formatter) => ({
      enabled: formatter.enabled ?? config.formatting.enabled,
      extensions: formatter.extensions,
      globs: formatter.globs,
      id: formatter.id,
      mode: formatter.mode,
      timeoutMs: formatter.timeoutMs,
    })),
  };
}

async function statusClientRoots(server: McpServer): Promise<string[]> {
  if (!server.server.getClientCapabilities()?.roots) return [];
  return (await server.server.listRoots()).roots.map((root) => root.uri);
}

function statusPayload(
  snapshot: Awaited<ReturnType<typeof configRegistry.snapshot>>,
) {
  const base = {
    error: snapshot.error,
    generation: snapshot.generation,
    healthy: snapshot.healthy,
    loadedAt: snapshot.loadedAt,
  };
  const config = snapshot.config;
  if (!config) return base;
  const diagnostics: Array<{
    code: string;
    message: string;
    source: string;
  }> = [];
  for (const name of config.sources.environment)
    if (name === "AST_MCP_PROJECT_ROOT" || name === "AST_MCP_ROOTS")
      diagnostics.push({
        code: "deprecated_root_environment",
        message: `${name} is deprecated; configure workspace.roots in ast-mcp.toml.`,
        source: name,
      });
  return {
    ...base,
    diagnostics,
    formatting: formattingStatus(config),
    projectRoot: config.projectRoot,
    provenance: config.provenance,
    safety: config.safety,
    sources: config.sources,
    version: config.version,
    workspace: config.workspace,
  };
}

async function configStatus(server: McpServer) {
  try {
    const clientRoots = await statusClientRoots(server);
    return toolSuccess(
      statusPayload(await configRegistry.snapshot({ clientRoots })),
    );
  } catch (error) {
    return toolFailure(error);
  }
}

export default function registerConfigurationTools(
  server: McpServer,
  execute: ConfiguredExecution = localExecution,
): void {
  server.registerTool(
    "config_status",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Returns the redacted effective configuration, source provenance, generation, formatter selection order, and health-relevant metadata.",
      inputSchema: z.object({}).strict(),
      outputSchema: toolOutputSchema,
      title: "Inspect Effective AST MCP Configuration",
    },
    async () => configStatus(server),
  );

  server.registerTool(
    "policy_check",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Explains the effective read, write, or delete decision for a batch of paths without performing the operation.",
      inputSchema: z
        .object({
          checks: z
            .array(
              z
                .object({
                  operation: z.enum(["read", "write", "delete"]),
                  path: z.string().min(1),
                })
                .strict(),
            )
            .min(1)
            .max(50),
        })
        .strict(),
      outputSchema: toolOutputSchema,
      title: "Check Path Authorization Policy",
    },
    async ({ checks }) => {
      try {
        return toolSuccess(
          await execute({ checks }, async () => {
            const config = await currentConfig();
            return {
              decisions: await Promise.all(
                checks.map(async (check) =>
                  evaluatePolicyForCheck(config, check.path, check.operation),
                ),
              ),
            };
          }),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "document_query",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Reads bounded values from JSON, JSONC, TOML, or YAML by RFC 6901 selectors and returns the whole-file hash.",
      inputSchema: z
        .object({
          filePath: z.string().min(1),
          selectors: z.array(z.string()).min(1).max(100),
        })
        .strict(),
      outputSchema: toolOutputSchema,
      title: "Query Structured Documents",
    },
    async ({ filePath, selectors }, context) => {
      try {
        return toolSuccess(
          await execute(
            { filePath },
            async () => {
              const resolved = await resolveWorkspacePath(filePath);
              const bytes = await readBoundedDocument(resolved);
              const source = bytes.toString("utf8");
              const document = parseStructuredDocument(resolved, source);
              const values = selectors.map((selector) => ({
                location: sourceLocation(
                  source,
                  selector,
                  path.extname(resolved).toLowerCase(),
                ),
                selector,
                value: selectDocumentValue(document, selector),
              }));
              if (Buffer.byteLength(JSON.stringify(values)) > 256 * 1024)
                throw Object.assign(
                  new Error(
                    "document_query result exceeds the 256 KiB limit; use narrower selectors",
                  ),
                  { code: "document_result_too_large", retryable: true },
                );
              return {
                filePath: resolved,
                sha256: sha256(bytes),
                values,
              };
            },
            context,
            "document_query",
          ),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

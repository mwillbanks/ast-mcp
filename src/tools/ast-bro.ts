import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  McpServer,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { AST_BRO_TOOLS, callAstBro } from "../ast-bro/client";
import {
  astBroMatchFiles,
  astBroRewrittenFiles,
  parseAstBroJson,
} from "../ast-bro/result";
import metadata from "../ast-bro/tools.json";
import { currentConfig } from "../config";
import {
  structuredUpstreamToolResult,
  toolFailure,
  toolOutputSchema,
} from "../helpers/mcp-schema";
import { replaceFileAtomically } from "../runtime/atomic";
import { inspectFileCapabilities } from "../runtime/file-capabilities";
import { assertFormattable, formatFileAtomically } from "../runtime/format";
import { withFileLocks } from "../runtime/locks";
import { assertReadableTree } from "../runtime/path-policy";
import {
  assertSingleProjectRoot,
  primaryRoot,
  resolveWorkspacePath,
  resolveWritablePath,
} from "../runtime/paths";
import { type ConfiguredExecution, localExecution } from "./configured";

function upstreamSchema(
  jsonSchema: Record<string, unknown>,
): StandardSchemaWithJSON<Record<string, unknown>> {
  return {
    "~standard": {
      jsonSchema: {
        input: () => jsonSchema,
        output: () => ({ type: "object" }),
      },
      validate(value) {
        return value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
          ? { value: value as Record<string, unknown> }
          : { issues: [{ message: "Expected an object" }] };
      },
      vendor: "ast-mcp",
      version: 1,
    },
  };
}
async function boundedPath(
  root: string,
  value: string,
  operation: "read" | "write" = "read",
): Promise<string> {
  const target = path.isAbsolute(value) ? value : path.resolve(root, value);
  return operation === "write"
    ? resolveWritablePath(target, "write")
    : resolveWorkspacePath(target);
}

const pathArguments = ["file", "path", "root"] as const;

async function validateReadableScanPath(
  root: string,
  value: string,
): Promise<string> {
  const resolved = await boundedPath(root, value);
  const metadata = await lstat(resolved).catch(() => undefined);
  if (metadata?.isDirectory())
    assertReadableTree(await currentConfig(), resolved);
  return resolved;
}

async function resolveAstBroPaths(
  args: Record<string, unknown>,
  root: string,
): Promise<string[]> {
  const candidates: string[] = [];
  for (const name of pathArguments) {
    const value = args[name];
    if (typeof value === "string") candidates.push(value);
  }
  if (Array.isArray(args.paths))
    candidates.push(
      ...args.paths.filter(
        (value): value is string => typeof value === "string",
      ),
    );
  if (candidates.length === 0) candidates.push(root);
  return Promise.all(
    candidates.map((value) => validateReadableScanPath(root, value)),
  );
}

async function validateRunPath(
  filePath: string,
  args: Record<string, unknown>,
): Promise<void> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile()) return;
  const language = typeof args.lang === "string" ? args.lang : undefined;
  const capabilities = await inspectFileCapabilities(filePath, language);
  const rewrite = typeof args.rewrite === "string";
  const available = rewrite
    ? capabilities.effective.patch.includes("ast")
    : capabilities.effective.read.includes("ast");
  if (available) return;
  throw Object.assign(
    new Error(
      `run ${rewrite ? "rewrite" : "search"} is unavailable for ${filePath}; inspect file_capabilities and select a supported workflow`,
    ),
    {
      code: "ast_capability_unavailable",
      details: { capabilities, rewrite },
      retryable: true,
      suggestedNextCall: "file_capabilities",
    },
  );
}

async function validateAstBroPaths(
  args: Record<string, unknown>,
  root: string,
  toolName: (typeof AST_BRO_TOOLS)[number],
): Promise<void> {
  const resolvedPaths = await resolveAstBroPaths(args, root);
  await assertSingleProjectRoot(resolvedPaths);
  if (toolName !== "run") return;
  await Promise.all(
    resolvedPaths.map((filePath) => validateRunPath(filePath, args)),
  );
}

function sameFiles(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((filePath, index) => filePath === right[index])
  );
}

async function snapshotAstBroFiles(
  files: string[],
): Promise<Map<string, { content: string; mode: number }>> {
  const snapshots = new Map<string, { content: string; mode: number }>();
  for (const filePath of files) {
    await assertFormattable(filePath);
    snapshots.set(filePath, {
      content: await readFile(filePath, "utf8"),
      mode: (await lstat(filePath)).mode,
    });
  }
  return snapshots;
}

async function formatAstBroFiles(
  result: Awaited<ReturnType<typeof callAstBro>>,
  root: string,
  snapshots: Map<string, { content: string; mode: number }>,
): Promise<void> {
  const rewritten = await Promise.all(
    astBroRewrittenFiles(result).map((file) =>
      boundedPath(root, file, "write"),
    ),
  );
  try {
    for (const filePath of rewritten) await formatFileAtomically(filePath);
  } catch (error) {
    for (const filePath of rewritten) {
      const snapshot = snapshots.get(filePath);
      if (snapshot)
        await replaceFileAtomically(filePath, snapshot.content, snapshot.mode);
    }
    throw error;
  }
}

async function executeLockedAstBroWrite(
  args: Record<string, unknown>,
  root: string,
  previewArgs: Record<string, unknown>,
  initialFiles: string[],
): Promise<Awaited<ReturnType<typeof callAstBro>>> {
  const previewResult = await callAstBro("run", previewArgs, root);
  const lockedPreview = parseAstBroJson(previewResult);
  if (lockedPreview.capped)
    throw new Error(
      "ast-bro run preview was capped; narrow paths or pattern before writing",
    );
  const lockedFiles = await Promise.all(
    astBroMatchFiles(previewResult).map((file) =>
      boundedPath(root, file, "write"),
    ),
  );
  if (!sameFiles(initialFiles, lockedFiles))
    throw new Error(
      "ast-bro run targets changed while waiting for the write lock; preview again",
    );
  if (lockedFiles.length === 0) return previewResult;

  const snapshots = await snapshotAstBroFiles(lockedFiles);
  const result = await callAstBro(
    "run",
    { ...args, json: true, paths: lockedFiles },
    root,
  );
  await formatAstBroFiles(result, root, snapshots);
  return result;
}

async function callAstBroWithFormatting(
  args: Record<string, unknown>,
  root: string,
) {
  const paths = Array.isArray(args.paths)
    ? args.paths.filter((value): value is string => typeof value === "string")
    : [];
  for (const value of paths.length ? paths : [root])
    await boundedPath(root, value);
  if (args.write !== true || typeof args.rewrite !== "string")
    return callAstBro("run", args, root);

  const previewArgs: Record<string, unknown> = {
    json: true,
    paths: args.paths,
    pattern: args.pattern,
  };
  for (const key of ["glob", "lang"])
    if (args[key] !== undefined) previewArgs[key] = args[key];
  const initialPreview = await callAstBro("run", previewArgs, root);
  const preview = parseAstBroJson(initialPreview);
  if (preview.capped)
    throw new Error(
      "ast-bro run preview was capped; narrow paths or pattern before writing",
    );
  const initialFiles = await Promise.all(
    astBroMatchFiles(initialPreview).map((file) =>
      boundedPath(root, file, "write"),
    ),
  );

  return withFileLocks(initialFiles, () =>
    executeLockedAstBroWrite(args, root, previewArgs, initialFiles),
  );
}

export default function registerAstBroTools(
  server: McpServer,
  execute: ConfiguredExecution = localExecution,
) {
  for (const toolName of AST_BRO_TOOLS) {
    const definition = metadata[toolName];
    const writesState = ["find_related", "index", "run", "search"].includes(
      toolName,
    );
    const destructive = toolName === "run";
    server.registerTool(
      toolName,
      {
        annotations: {
          destructiveHint: destructive,
          idempotentHint: !destructive,
          openWorldHint: false,
          readOnlyHint: !writesState,
        },
        description:
          toolName === "run"
            ? "AST structural search and rewrite. Use for bounded inspection and previews; direct write is a lower-level escape hatch for exceptional cases. Normal agent edits belong in file_patch's declared files batch, which supports ordered AST rules and Aider blocks."
            : definition.description,
        inputSchema: upstreamSchema(definition.inputSchema),
        outputSchema: toolOutputSchema,
        title: `ast-bro ${toolName}`,
      },
      async (args, context) => {
        try {
          const result = await execute(
            args,
            async () => {
              const root = await primaryRoot();
              await validateAstBroPaths(args, root, toolName);
              return toolName === "run"
                ? await callAstBroWithFormatting(args, root)
                : await callAstBro(toolName, args, root);
            },
            context,
            toolName,
          );

          return structuredUpstreamToolResult(result, toolName);
        } catch (error) {
          return toolFailure(error);
        }
      },
    );
  }
}

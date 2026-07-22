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
import { replaceFileAtomically } from "../runtime/atomic";
import { assertFormattable, formatFileAtomically } from "../runtime/format";
import { withFileLocks } from "../runtime/locks";
import { primaryRoot, resolveWritablePath } from "../runtime/paths";

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
async function boundedPath(root: string, value: string): Promise<string> {
  return resolveWritablePath(
    path.isAbsolute(value) ? value : path.resolve(root, value),
  );
}

const pathArguments = ["file", "path", "root"] as const;

async function validateAstBroPaths(
  args: Record<string, unknown>,
  root: string,
): Promise<void> {
  for (const name of pathArguments) {
    const value = args[name];
    if (typeof value === "string") await boundedPath(root, value);
  }
  if (!Array.isArray(args.paths)) return;
  for (const value of args.paths)
    if (typeof value === "string") await boundedPath(root, value);
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
    astBroMatchFiles(initialPreview).map((file) => boundedPath(root, file)),
  );

  return withFileLocks(initialFiles, async () => {
    const previewResult = await callAstBro("run", previewArgs, root);
    const lockedPreview = parseAstBroJson(previewResult);
    if (lockedPreview.capped)
      throw new Error(
        "ast-bro run preview was capped; narrow paths or pattern before writing",
      );
    const lockedFiles = await Promise.all(
      astBroMatchFiles(previewResult).map((file) => boundedPath(root, file)),
    );
    if (
      initialFiles.length !== lockedFiles.length ||
      initialFiles.some((filePath, index) => filePath !== lockedFiles[index])
    )
      throw new Error(
        "ast-bro run targets changed while waiting for the write lock; preview again",
      );

    const snapshots = new Map<string, { content: string; mode: number }>();
    for (const filePath of lockedFiles) {
      await assertFormattable(filePath);
      snapshots.set(filePath, {
        content: await readFile(filePath, "utf8"),
        mode: (await lstat(filePath)).mode,
      });
    }
    const result = await callAstBro("run", { ...args, json: true }, root);
    const rewritten = await Promise.all(
      astBroRewrittenFiles(result).map((file) => boundedPath(root, file)),
    );
    try {
      for (const filePath of rewritten) await formatFileAtomically(filePath);
    } catch (error) {
      for (const filePath of rewritten) {
        const snapshot = snapshots.get(filePath);
        if (snapshot)
          await replaceFileAtomically(
            filePath,
            snapshot.content,
            snapshot.mode,
          );
      }
      throw error;
    }
    return result;
  });
}

export default function registerAstBroTools(server: McpServer) {
  for (const toolName of AST_BRO_TOOLS) {
    const definition = metadata[toolName];
    server.registerTool(
      toolName,
      {
        description:
          toolName === "run"
            ? "AST structural search and rewrite. Use for bounded inspection and previews; direct write is a lower-level escape hatch for exceptional cases. Normal agent edits belong in keyed file_patch, which supports ordered AST rules and Aider blocks."
            : definition.description,
        inputSchema: upstreamSchema(definition.inputSchema),
        title: `ast-bro ${toolName}`,
      },
      async (args) => {
        try {
          const root = await primaryRoot();
          await validateAstBroPaths(args, root);
          return toolName === "run"
            ? await callAstBroWithFormatting(args, root)
            : await callAstBro(toolName, args, root);
        } catch (error) {
          return {
            content: [
              {
                text: error instanceof Error ? error.message : String(error),
                type: "text",
              },
            ],
            isError: true,
          };
        }
      },
    );
  }
}

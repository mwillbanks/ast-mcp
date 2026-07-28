import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  boundedFileBatch,
  chattrSchema,
  toolFailure,
} from "../helpers/mcp-schema";
import { patchFiles, writeFilesSafely } from "../patch/engine";
import {
  FILE_READ_MAX_BATCH,
  FILE_READ_MAX_BYTES,
  FILE_READ_MAX_LINES,
  hashFilesSafely,
  readFilesSafely,
} from "../runtime/file-read";
import { type ConfiguredExecution, localExecution } from "./configured";

const failure = toolFailure;
export default function registerFileTools(
  server: McpServer,
  execute: ConfiguredExecution = localExecution,
) {
  const lineRange = z
    .tuple([z.number().int().nonnegative(), z.number().int().positive()])
    .describe("Zero-based, end-exclusive [start, end] line range");
  const readTarget = z.object({
    filePath: z.string(),
    lines: lineRange.optional(),
    maxBytes: z.number().int().positive().max(FILE_READ_MAX_BYTES).optional(),
  });
  const aiderBlock = z.object({
    replace: z.string(),
    search: z.string(),
  });
  const astRule = z.object({
    expectedMatches: z.number().int().positive().optional(),
    fix: z.string(),
    pattern: z.string().min(1),
  });
  const chattr = chattrSchema;
  const writeTarget = z.object({
    chattr: chattr.optional(),
    content: z.string(),
    expectedSha256: z.string().length(64).optional(),
  });

  server.registerTool(
    "file_read",
    {
      description: `Batches bounded line slices from non-AST files only. AST-capable files are rejected and must use map/show/search/context/run. Each slice defaults to lines [0, 100], is capped at ${FILE_READ_MAX_LINES} lines and ${FILE_READ_MAX_BYTES} bytes, and includes a streaming whole-file SHA-256.`,
      inputSchema: z.object({
        files: z.array(readTarget).min(1).max(FILE_READ_MAX_BATCH),
      }),
      title: "Read Bounded Non-AST File Slices",
    },
    async ({ files }) => {
      try {
        return {
          content: [
            {
              text: JSON.stringify({
                files: await execute({ files }, () => readFilesSafely(files)),
              }),
              type: "text",
            },
          ],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "file_hash",
    {
      description: `Batches streaming whole-file SHA-256 calculations without loading file contents into memory. Use this for fresh patch hashes, including AST-capable files. Accepts up to ${FILE_READ_MAX_BATCH} paths.`,
      inputSchema: z.object({
        filePaths: z.array(z.string()).min(1).max(FILE_READ_MAX_BATCH),
      }),
      title: "Hash Files Without Reading Content",
    },
    async ({ filePaths }) => {
      try {
        return {
          content: [
            {
              text: JSON.stringify({
                files: await execute({ filePaths }, () =>
                  hashFilesSafely(filePaths),
                ),
              }),
              type: "text",
            },
          ],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "file_write",
    {
      description:
        "Creates or replaces multiple files in one declared files batch. Existing files require a fresh expectedSha256 by default; safety.require_hash=false makes it optional, but any supplied hash is still verified.",
      inputSchema: boundedFileBatch(
        writeTarget,
        "file_write requires between 1 and 50 files",
      ),
      title: "Write Files Safely",
    },
    async ({ files }) => {
      try {
        return {
          content: [
            {
              text: JSON.stringify(
                await execute({ files }, () => writeFilesSafely(files)),
              ),
              type: "text",
            },
          ],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "file_patch",
    {
      description:
        "Patches multiple files in one declared files batch. Each value contains a patchStrategy, ordered aiderBlocks or astRules, and optional preview mode. A fresh expectedSha256 is required by default; safety.require_hash=false makes it optional, but supplied hashes remain enforced. Preview runs the complete formatted operation without committing.",
      inputSchema: boundedFileBatch(
        z.object({
          aiderBlocks: z.array(aiderBlock).max(FILE_READ_MAX_BATCH).optional(),
          astRules: z.array(astRule).max(FILE_READ_MAX_BATCH).optional(),
          chattr: chattr.optional(),
          expectedSha256: z.string().length(64).optional(),
          patchStrategy: z.enum(["ast", "aider_block"]),
          preview: z.boolean().optional(),
        }),
        "file_patch requires between 1 and 50 files",
      ),
      title: "Patch Files Through the Enforced State Machine",
    },
    async ({ files }) => {
      try {
        return {
          content: [
            {
              text: JSON.stringify(
                await execute({ files }, () => patchFiles(files)),
              ),
              type: "text",
            },
          ],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );
}

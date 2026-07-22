import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { patchFiles, writeFilesSafely } from "../patch/engine";

import {
  FILE_READ_MAX_BATCH,
  FILE_READ_MAX_BYTES,
  FILE_READ_MAX_LINES,
  hashFilesSafely,
  readFilesSafely,
} from "../runtime/file-read";

const failure = (error: unknown) => ({
  content: [
    {
      text: error instanceof Error ? error.message : String(error),
      type: "text" as const,
    },
  ],
  isError: true,
});
export default function registerFileTools(server: McpServer) {
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
  const chattr = z.object({
    chmod: z.number().int().min(0).max(0o777).optional(),
    chown: z
      .object({
        gid: z.number().int().nonnegative(),
        uid: z.number().int().nonnegative(),
      })
      .optional(),
  });
  const writeTarget = z.object({
    chattr: chattr.optional(),
    content: z.string(),
    expectedSha256: z.string().length(64).optional(),
  });
  const boundedBatch = <T extends z.ZodType>(schema: T, label: string) =>
    z
      .record(z.string().min(1), schema)
      .refine(
        (value) =>
          Object.keys(value).length > 0 &&
          Object.keys(value).length <= FILE_READ_MAX_BATCH,
        label,
      );

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
              text: JSON.stringify({ files: await readFilesSafely(files) }),
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
                files: await hashFilesSafely(filePaths),
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
        "Creates or replaces multiple files in one keyed batch. Each key is a file path and each value contains content plus an optional fresh expectedSha256 for existing non-structurally-rewritable files.",
      inputSchema: boundedBatch(
        writeTarget,
        "file_write requires between 1 and 50 files",
      ),
      title: "Write Files Safely",
    },
    async (args) => {
      try {
        return {
          content: [
            {
              text: JSON.stringify(await writeFilesSafely(args)),
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
        "Patches multiple files in one keyed batch. Each key is a file path and each value contains one expectedSha256, a patchStrategy, ordered aiderBlocks or astRules, and optional preview mode. Preview runs the complete guarded operation and returns a bounded diff without committing.",
      inputSchema: boundedBatch(
        z.object({
          aiderBlocks: z.array(aiderBlock).max(FILE_READ_MAX_BATCH).optional(),
          astRules: z.array(astRule).max(FILE_READ_MAX_BATCH).optional(),
          chattr: chattr.optional(),
          expectedSha256: z.string().length(64),
          patchStrategy: z.enum(["ast", "aider_block"]),
          preview: z.boolean().optional(),
        }),
        "file_patch requires between 1 and 50 files",
      ),
      title: "Patch Files Through the Enforced State Machine",
    },
    async (args) => {
      try {
        return {
          content: [
            { text: JSON.stringify(await patchFiles(args)), type: "text" },
          ],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );
}

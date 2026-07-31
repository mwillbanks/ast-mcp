import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  boundedFileBatch,
  chattrSchema,
  toolFailure,
  toolOutputSchema,
  toolSuccess,
} from "../helpers/mcp-schema";
import { patchFiles, writeFilesSafely } from "../patch/engine";
import { inspectFileCapabilitiesSafely } from "../runtime/file-capabilities";
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
  const readTarget = z
    .object({
      filePath: z.string(),
      language: z.string().min(1).optional(),
      lines: lineRange.optional(),
      maxBytes: z.number().int().positive().max(FILE_READ_MAX_BYTES).optional(),
      mode: z.enum(["auto", "ast", "text"]).optional(),
      range: z
        .object({
          end: z.number().int().positive(),
          start: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
      selectors: z.array(z.string()).min(1).max(100).optional(),
      symbols: z.array(z.string().min(1)).max(100).optional(),
    })
    .strict()
    .refine(
      (value) => !(value.lines && value.range),
      "Use either range or lines, not both",
    )
    .refine(
      (value) => !(value.selectors && value.symbols),
      "Use selectors for structured documents or symbols for source files, not both",
    )
    .transform(({ range, ...value }) => ({
      ...value,
      lines:
        value.lines ??
        (range ? ([range.start, range.end] as [number, number]) : undefined),
    }));
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
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: `Reads files using an agent-selected auto, ast, or text mode. AST mode returns a source map/requested symbols or RFC 6901-selected structured-document values; text mode returns a bounded slice. Each result includes capabilities and a streaming whole-file SHA-256. Text slices default to lines [0, 100] and are capped at ${FILE_READ_MAX_LINES} lines and ${FILE_READ_MAX_BYTES} bytes.`,
      inputSchema: z.object({
        files: z.array(readTarget).min(1).max(FILE_READ_MAX_BATCH),
      }),
      outputSchema: toolOutputSchema,
      title: "Read Files as AST or Text",
    },
    async ({ files }, context) => {
      try {
        return toolSuccess({
          files: await execute(
            { files },
            () => readFilesSafely(files),
            context,
            "file_read",
          ),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "file_capabilities",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Reports the intrinsic and effective AST/text read, AST/Aider patch, and AST search capabilities for each file.",
      inputSchema: z.object({
        filePaths: z.array(z.string()).min(1).max(FILE_READ_MAX_BATCH),
      }),
      outputSchema: toolOutputSchema,
      title: "Inspect File Capabilities",
    },
    async ({ filePaths }, context) => {
      try {
        return toolSuccess({
          files: await execute(
            { filePaths },
            () => inspectFileCapabilitiesSafely(filePaths),
            context,
            "file_capabilities",
          ),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "file_hash",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: `Batches streaming whole-file SHA-256 calculations without loading file contents into memory. Use this for fresh patch hashes, including AST-capable files. Accepts up to ${FILE_READ_MAX_BATCH} paths.`,
      inputSchema: z.object({
        filePaths: z.array(z.string()).min(1).max(FILE_READ_MAX_BATCH),
      }),
      outputSchema: toolOutputSchema,
      title: "Hash Files Without Reading Content",
    },
    async ({ filePaths }, context) => {
      try {
        return toolSuccess({
          files: await execute(
            { filePaths },
            () => hashFilesSafely(filePaths),
            context,
            "file_hash",
          ),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "file_write",
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Creates or replaces multiple files in one declared files batch. Existing files require a fresh expectedSha256 by default; safety.require_hash=false makes it optional, but any supplied hash is still verified.",
      inputSchema: boundedFileBatch(
        writeTarget,
        "file_write requires between 1 and 50 files",
      ),
      outputSchema: toolOutputSchema,
      title: "Write Files Safely",
    },
    async ({ files }, context) => {
      try {
        return toolSuccess(
          await execute(
            { files },
            () => writeFilesSafely(files),
            context,
            "file_write",
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "file_patch",
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Patches multiple files in one declared files batch. Each value contains a patchStrategy, ordered aiderBlocks or astRules, and optional preview mode. A fresh expectedSha256 is required by default; safety.require_hash=false makes it optional, but supplied hashes remain enforced. Preview runs the complete formatted operation without committing.",
      inputSchema: boundedFileBatch(
        z
          .object({
            aiderBlocks: z
              .array(aiderBlock)
              .max(FILE_READ_MAX_BATCH)
              .optional(),
            astRules: z.array(astRule).max(FILE_READ_MAX_BATCH).optional(),
            chattr: chattr.optional(),
            expectedSha256: z.string().length(64).optional(),
            patchStrategy: z.enum(["ast", "aider_block"]).optional(),
            preview: z.boolean().optional(),
            previewReceipt: z.string().uuid().optional(),
          })
          .strict()
          .superRefine((value, context) => {
            if (
              value.previewReceipt &&
              (value.patchStrategy ||
                value.aiderBlocks ||
                value.astRules ||
                value.preview)
            )
              context.addIssue({
                code: "custom",
                message:
                  "previewReceipt commit cannot include patch operations",
              });
            if (!value.previewReceipt && !value.patchStrategy)
              context.addIssue({
                code: "custom",
                message:
                  "patchStrategy is required unless previewReceipt is supplied",
              });
          }),
        "file_patch requires between 1 and 50 files",
      ),
      outputSchema: toolOutputSchema,
      title: "Patch Files Through the Enforced State Machine",
    },
    async ({ files }, context) => {
      try {
        return toolSuccess(
          await execute(
            { files },
            () => patchFiles(files),
            context,
            "file_patch",
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}

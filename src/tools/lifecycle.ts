import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  boundedFileBatch,
  chattrSchema,
  toolFailure,
  toolOutputSchema,
  toolSuccess,
} from "../helpers/mcp-schema";
import {
  applyFileChattr,
  type FileChattr,
  resultingFileChattr,
} from "../runtime/attributes";
import { deleteFilesSafely } from "../runtime/file-delete";
import { renameFilesSafely } from "../runtime/file-rename";
import { sha256 } from "../runtime/hash";
import { withFileLocks } from "../runtime/locks";
import { resolveWritablePath } from "../runtime/paths";
import { type ConfiguredExecution, localExecution } from "./configured";

const chattr = chattrSchema;

const failure = toolFailure;

export default function registerLifecycleTools(
  server: McpServer,
  execute: ConfiguredExecution = localExecution,
) {
  server.registerTool(
    "file_chattr",
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Applies the shared chattr contract to multiple files in one declared files batch under deterministic locks.",
      inputSchema: boundedFileBatch(
        z.object({
          chattr,
          expectedSha256: z.string().length(64).optional(),
        }),
        "file_chattr requires between 1 and 50 files",
      ),
      outputSchema: toolOutputSchema,
      title: "Change File Attributes Safely",
    },
    async ({ files: requests }, context) => {
      try {
        const entries = await execute(
          { files: requests },
          () =>
            Promise.all(
              Object.entries(requests).map(async ([inputPath, request]) => ({
                filePath: await resolveWritablePath(inputPath),
                request,
              })),
            ),
          context,
          "file_chattr",
        );
        const files: Record<string, unknown> = {};
        await withFileLocks(
          entries.map(({ filePath }) => filePath),
          async () => {
            const previous = new Map<
              string,
              Awaited<ReturnType<typeof resultingFileChattr>>
            >();
            for (const { filePath, request } of entries) {
              if (request.expectedSha256) {
                const actual = sha256(await Bun.file(filePath).text());
                if (actual !== request.expectedSha256)
                  throw new Error(
                    `Stale file context: expected ${request.expectedSha256}, found ${actual}`,
                  );
              }
              previous.set(filePath, await resultingFileChattr(filePath));
            }
            const applied: string[] = [];
            try {
              for (const { filePath, request } of entries) {
                files[filePath] = {
                  chattr: await applyFileChattr(
                    filePath,
                    request.chattr as FileChattr,
                  ),
                };
                applied.push(filePath);
              }
            } catch (error) {
              for (const filePath of applied.reverse())
                try {
                  await applyFileChattr(filePath, previous.get(filePath));
                } catch {}
              throw error;
            }
          },
        );
        return toolSuccess({ files });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "file_delete",
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Deletes files in one declared files batch after reference preflight and removes empty ancestor directories. A fresh expectedSha256 is required by default; safety.require_hash=false makes it optional, but supplied hashes remain enforced.",
      inputSchema: boundedFileBatch(
        z.object({
          expectedSha256: z.string().length(64).optional(),
          forceReferences: z.boolean().optional(),
        }),
        "file_delete requires between 1 and 50 files",
      ),
      outputSchema: toolOutputSchema,
      title: "Delete Files Safely",
    },
    async ({ files }, context) => {
      try {
        return toolSuccess(
          await execute(
            { files },
            () => deleteFilesSafely(files),
            context,
            "file_delete",
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "file_rename",
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Renames files in one declared files batch without overwriting destinations. A fresh expectedSha256 is required by default; safety.require_hash=false makes it optional, but supplied hashes remain enforced.",
      inputSchema: boundedFileBatch(
        z.object({
          destination: z.string().min(1),
          expectedSha256: z.string().length(64).optional(),
        }),
        "file_rename requires between 1 and 50 files",
      ),
      outputSchema: toolOutputSchema,
      title: "Rename Files Safely",
    },
    async ({ files }, context) => {
      try {
        return toolSuccess(
          await execute(
            { files },
            () => renameFilesSafely(files),
            context,
            "file_rename",
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}

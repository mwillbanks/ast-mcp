import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  boundedRecord,
  chattrSchema,
  toolFailure,
} from "../helpers/mcp-schema";
import { applyFileChattr, type FileChattr } from "../runtime/attributes";
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
      description:
        "Applies the shared chattr contract to multiple root-bounded files under deterministic locks.",
      inputSchema: boundedRecord(
        z.object({
          chattr,
          expectedSha256: z.string().length(64).optional(),
        }),
        "file_chattr requires between 1 and 50 files",
      ),
      title: "Change File Attributes Safely",
    },
    async (requests) => {
      try {
        const entries = await execute(requests, () =>
          Promise.all(
            Object.entries(requests).map(async ([inputPath, request]) => ({
              filePath: await resolveWritablePath(inputPath),
              request,
            })),
          ),
        );
        const files: Record<string, unknown> = {};
        await withFileLocks(
          entries.map(({ filePath }) => filePath),
          async () => {
            for (const { filePath, request } of entries) {
              if (request.expectedSha256) {
                const actual = sha256(await Bun.file(filePath).text());
                if (actual !== request.expectedSha256)
                  throw new Error(
                    `Stale file context: expected ${request.expectedSha256}, found ${actual}`,
                  );
              }
              files[filePath] = {
                chattr: await applyFileChattr(
                  filePath,
                  request.chattr as FileChattr,
                ),
              };
            }
          },
        );
        return { content: [{ text: JSON.stringify({ files }), type: "text" }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "file_delete",
    {
      description:
        "Deletes files in one reference-preflighted batch and removes empty ancestor directories. A fresh expectedSha256 is required by default; safety.require_hash=false makes it optional, but supplied hashes remain enforced.",
      inputSchema: boundedRecord(
        z.object({
          expectedSha256: z.string().length(64).optional(),
          forceReferences: z.boolean().optional(),
        }),
        "file_delete requires between 1 and 50 files",
      ),
      title: "Delete Files Safely",
    },
    async (requests) => {
      try {
        return {
          content: [
            {
              text: JSON.stringify(
                await execute(requests, () => deleteFilesSafely(requests)),
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
    "file_rename",
    {
      description:
        "Renames files in one root-bounded batch without overwriting destinations. A fresh expectedSha256 is required by default; safety.require_hash=false makes it optional, but supplied hashes remain enforced.",
      inputSchema: boundedRecord(
        z.object({
          destination: z.string().min(1),
          expectedSha256: z.string().length(64).optional(),
        }),
        "file_rename requires between 1 and 50 files",
      ),
      title: "Rename Files Safely",
    },
    async (requests) => {
      try {
        return {
          content: [
            {
              text: JSON.stringify(
                await execute(requests, () => renameFilesSafely(requests)),
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

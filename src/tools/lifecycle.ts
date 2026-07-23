import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { applyFileChattr, type FileChattr } from "../runtime/attributes";
import { deleteFilesSafely } from "../runtime/file-delete";
import { FILE_READ_MAX_BATCH } from "../runtime/file-read";
import { renameFilesSafely } from "../runtime/file-rename";
import { sha256 } from "../runtime/hash";
import { withFileLocks } from "../runtime/locks";
import { resolveWritablePath } from "../runtime/paths";

const chattr = z.object({
  chmod: z.number().int().min(0).max(0o777).optional(),
  chown: z
    .object({
      gid: z.number().int().nonnegative(),
      uid: z.number().int().nonnegative(),
    })
    .optional(),
});

const failure = (error: unknown) => ({
  content: [
    {
      text: error instanceof Error ? error.message : String(error),
      type: "text" as const,
    },
  ],
  isError: true,
});

export default function registerLifecycleTools(server: McpServer) {
  server.registerTool(
    "file_chattr",
    {
      description:
        "Applies the shared chattr contract to multiple root-bounded files under deterministic locks.",
      inputSchema: z
        .record(
          z.string().min(1),
          z.object({
            chattr,
            expectedSha256: z.string().length(64).optional(),
          }),
        )
        .refine(
          (value) =>
            Object.keys(value).length > 0 &&
            Object.keys(value).length <= FILE_READ_MAX_BATCH,
          "file_chattr requires between 1 and 50 files",
        ),
      title: "Change File Attributes Safely",
    },
    async (requests) => {
      try {
        const entries = await Promise.all(
          Object.entries(requests).map(async ([inputPath, request]) => ({
            filePath: await resolveWritablePath(inputPath),
            request,
          })),
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
        "Deletes hash-guarded files in one reference-preflighted batch and removes empty ancestor directories within configured roots.",
      inputSchema: z
        .record(
          z.string().min(1),
          z.object({
            expectedSha256: z.string().length(64),
            forceReferences: z.boolean().optional(),
          }),
        )
        .refine(
          (value) =>
            Object.keys(value).length > 0 &&
            Object.keys(value).length <= FILE_READ_MAX_BATCH,
          "file_delete requires between 1 and 50 files",
        ),
      title: "Delete Files Safely",
    },
    async (requests) => {
      try {
        return {
          content: [
            {
              text: JSON.stringify(await deleteFilesSafely(requests)),
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
        "Renames hash-guarded files in one root-bounded batch without overwriting existing destinations.",
      inputSchema: z
        .record(
          z.string().min(1),
          z.object({
            destination: z.string().min(1),
            expectedSha256: z.string().length(64),
          }),
        )
        .refine(
          (value) =>
            Object.keys(value).length > 0 &&
            Object.keys(value).length <= FILE_READ_MAX_BATCH,
          "file_rename requires between 1 and 50 files",
        ),
      title: "Rename Files Safely",
    },
    async (requests) => {
      try {
        return {
          content: [
            {
              text: JSON.stringify(await renameFilesSafely(requests)),
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

import { randomUUID } from "node:crypto";

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
  RevisionSelectorSchema,
  WorkspaceIdSchema,
} from "../intelligence/contracts/index.ts";
import {
  beginMutation,
  completeMutation,
  failMutation,
  mutationOperationId,
  recordMutationCommit,
  recordMutationRollback,
  withLanceMutationLifecycle,
} from "../intelligence/mutation/index.ts";
import { currentWorkspace } from "../intelligence/workspace/context.ts";
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
import { requireExpectedHash, verifyExpectedHash } from "../runtime/policy";
import { type ConfiguredExecution, localExecution } from "./configured";

const chattr = chattrSchema;

const failure = toolFailure;
const workspaceRequestFields = {
  revision: RevisionSelectorSchema.optional(),
  workspaceId: WorkspaceIdSchema.optional(),
};

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
      ).extend(workspaceRequestFields),
      outputSchema: toolOutputSchema,
      title: "Change File Attributes Safely",
    },
    async ({ files: requests, revision, workspaceId }, context) => {
      try {
        return toolSuccess(
          await execute(
            { files: requests, revision, workspaceId },
            () =>
              withLanceMutationLifecycle(async () => {
                const entries = await Promise.all(
                  Object.entries(requests).map(
                    async ([inputPath, request]) => ({
                      filePath: await resolveWritablePath(inputPath),
                      request,
                    }),
                  ),
                );
                const files: Record<string, unknown> = {};
                await withFileLocks(
                  entries.map(({ filePath }) => filePath),
                  async (leases) => {
                    const fence = async (): Promise<void> => {
                      await Promise.all(leases.map((lease) => lease.fence()));
                    };
                    const snapshots = new Map<
                      string,
                      {
                        attributes: Awaited<
                          ReturnType<typeof resultingFileChattr>
                        >;
                        content: Buffer;
                        sha256: string;
                      }
                    >();
                    for (const { filePath, request } of entries) {
                      await requireExpectedHash(
                        request.expectedSha256,
                        "file_chattr",
                      );
                      const content = Buffer.from(
                        await Bun.file(filePath).bytes(),
                      );
                      const actual = sha256(content);
                      if (request.expectedSha256)
                        verifyExpectedHash(request.expectedSha256, actual);
                      snapshots.set(filePath, {
                        attributes: await resultingFileChattr(filePath),
                        content,
                        sha256: actual,
                      });
                    }
                    const workspace = currentWorkspace() ?? null;
                    const plan = entries.map(({ filePath }) => {
                      const snapshot = snapshots.get(filePath);
                      if (!snapshot)
                        throw new Error("mutation_source_snapshot_missing");
                      return {
                        candidateSha256: snapshot.sha256,
                        filePath,
                        sourceContentBase64:
                          snapshot.content.toString("base64"),
                        sourceGid:
                          process.platform === "win32"
                            ? null
                            : snapshot.attributes.chown.gid,
                        sourceMode:
                          process.platform === "win32"
                            ? null
                            : snapshot.attributes.chmod,
                        sourceSha256: snapshot.sha256,
                        sourceUid:
                          process.platform === "win32"
                            ? null
                            : snapshot.attributes.chown.uid,
                      };
                    });
                    const operationId = workspace
                      ? mutationOperationId({
                          files: plan,
                          nonce: randomUUID(),
                          storageDomainId: workspace.storageDomain.domainId,
                          workspaceId: workspace.workspaceId,
                        })
                      : randomUUID();
                    await beginMutation({
                      files: plan,
                      operationId,
                      tool: "file_chattr",
                      workspace,
                    });
                    const applied: string[] = [];
                    try {
                      for (const { filePath, request } of entries) {
                        const snapshot = snapshots.get(filePath);
                        if (!snapshot)
                          throw new Error("mutation_source_snapshot_missing");
                        await recordMutationCommit(operationId, {
                          filePath,
                          sha256: snapshot.sha256,
                        });
                        applied.push(filePath);
                        files[filePath] = {
                          chattr: await applyFileChattr(
                            filePath,
                            request.chattr as FileChattr,
                            fence,
                          ),
                        };
                      }
                      await completeMutation(
                        operationId,
                        entries.map(({ filePath }) => {
                          const snapshot = snapshots.get(filePath);
                          if (!snapshot)
                            throw new Error("mutation_source_snapshot_missing");
                          return { filePath, sha256: snapshot.sha256 };
                        }),
                      );
                    } catch (error) {
                      await failMutation(operationId, error).catch(
                        () => undefined,
                      );
                      const rollbackErrors: unknown[] = [];
                      for (const filePath of applied.reverse())
                        try {
                          await applyFileChattr(
                            filePath,
                            snapshots.get(filePath)?.attributes,
                            fence,
                          );
                        } catch (rollbackError) {
                          rollbackErrors.push(rollbackError);
                        }
                      if (rollbackErrors.length > 0)
                        throw new AggregateError(
                          [error, ...rollbackErrors],
                          "file_chattr failed and rollback was incomplete",
                        );
                      await recordMutationRollback(operationId);
                      throw error;
                    }
                  },
                );
                return { files };
              }),
            context,
            "file_chattr",
          ),
        );
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
      ).extend(workspaceRequestFields),
      outputSchema: toolOutputSchema,
      title: "Delete Files Safely",
    },
    async ({ files, revision, workspaceId }, context) => {
      try {
        return toolSuccess(
          await execute(
            { files, revision, workspaceId },
            () => withLanceMutationLifecycle(() => deleteFilesSafely(files)),
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
      ).extend(workspaceRequestFields),
      outputSchema: toolOutputSchema,
      title: "Rename Files Safely",
    },
    async ({ files, revision, workspaceId }, context) => {
      try {
        return toolSuccess(
          await execute(
            { files, revision, workspaceId },
            () => withLanceMutationLifecycle(() => renameFilesSafely(files)),
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

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  toolFailure,
  toolOutputSchema,
  toolSuccess,
} from "../../helpers/mcp-schema.ts";
import type { ConfiguredExecution } from "../../tools/configured.ts";
import {
  RevisionSelectorSchema,
  StoragePlacementSchema,
  WorkspaceIdSchema,
} from "../contracts/index.ts";

export default function registerWorkspaceTools(
  server: McpServer,
  execute: ConfiguredExecution,
): void {
  server.registerTool(
    "workspace_open",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Opens an absolute checkout or repository directory for this server session and returns its validated workspace, Git revision, configuration, and storage identities.",
      inputSchema: z
        .object({
          directory: z.string().min(1),
          revision: RevisionSelectorSchema.optional(),
          storage: StoragePlacementSchema.optional(),
        })
        .strict(),
      outputSchema: toolOutputSchema,
      title: "Open Workspace",
    },
    async (input, context) => {
      try {
        if (!execute.openWorkspace)
          throw new Error("Workspace registry is unavailable");
        return toolSuccess({
          workspace: await execute.openWorkspace(input, context),
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "workspace_status",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Returns workspace, repository, Git, revision, storage, and working-state identities for this server session.",
      inputSchema: z
        .object({ workspaceId: WorkspaceIdSchema.optional() })
        .strict(),
      outputSchema: toolOutputSchema,
      title: "Inspect Workspace Status",
    },
    async ({ workspaceId }, context) => {
      try {
        if (!execute.workspaceStatus)
          throw new Error("Workspace registry is unavailable");
        return toolSuccess(await execute.workspaceStatus(workspaceId, context));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

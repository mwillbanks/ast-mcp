import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import packageJson from "../../package.json" with { type: "json" };
import {
  toolFailure,
  toolOutputSchema,
  toolSuccess,
} from "../helpers/mcp-schema";
import { runApprovalProbe, withApprovalContext } from "../runtime/approval";
import {
  checkLatestVersion,
  collectDiagnostics,
  type DiagnosticsOptions,
} from "../runtime/diagnostics";

export default function registerDiagnosticTools(
  server: McpServer,
  options: Pick<DiagnosticsOptions, "fetch" | "transport"> & {
    requestScoped?: boolean;
  } = {},
) {
  server.registerTool(
    "diagnostics",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Reports sanitized runtime, approval, capability and configuration state before filesystem approval. Always checks the public npm latest release with a five-second deadline.",
      inputSchema: z.object({}).strict(),
      outputSchema: toolOutputSchema,
      title: "Diagnose AST MCP",
    },
    async (_, context) => {
      try {
        return toolSuccess(
          await collectDiagnostics({ ...options, server, context }),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
  server.registerTool(
    "approval_probe",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Explicitly tests a bounded approval form and checks the latest release. Acceptance grants no filesystem permission and persists no configuration.",
      inputSchema: z.object({}).strict(),
      outputSchema: toolOutputSchema,
      title: "Probe Approval Transport",
    },
    async (_, context) => {
      try {
        const versionCheck = checkLatestVersion(packageJson.version, {
          fetch: options.fetch,
        });
        return await withApprovalContext(
          {
            context,
            server,
            tool: "approval_probe",
            requestScoped: options.requestScoped,
          },
          async () => {
            const probe = runApprovalProbe();
            return toolSuccess({ ...probe, versionCheck: await versionCheck });
          },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

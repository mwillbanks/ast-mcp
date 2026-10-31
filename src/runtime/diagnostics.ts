import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import packageJson from "../../package.json" with { type: "json" };
import type { ResolvedConfig } from "../config";
import { configRegistry } from "../config/registry";
import {
  approvalClient,
  approvalDiagnostics,
  supportsApprovalForm,
} from "./approval";
import { codexApprovalMetadata } from "./hosts/codex";

export { checkLatestVersion } from "./release";
import { checkLatestVersion } from "./release";

export interface DiagnosticsOptions {
  config?: Readonly<ResolvedConfig>;
  context?: ServerContext;
  cwd?: string;
  fetch?: typeof fetch;
  server?: McpServer;
  transport?: "stdio" | "http" | "unknown";
}

function safeIdentity(value: unknown): string {
  return typeof value === "string" && /^[\w .+-]{1,128}$/.test(value)
    ? value
    : "unknown";
}

export async function collectDiagnostics(options: DiagnosticsOptions = {}) {
  const versionCheck = checkLatestVersion(packageJson.version, {
    fetch: options.fetch,
  });
  let config = options.config;
  if (!config) {
    try {
      config = await configRegistry.get({ cwd: options.cwd });
    } catch {
      // Configuration error text can contain private paths or source content.
    }
  }
  const { capabilities, client, protocol } = approvalClient(
    options.server,
    options.context,
  );
  return {
    schemaVersion: 1,
    server: {
      name: "ast-mcp",
      version: packageJson.version,
      runtime: `Bun ${Bun.version}`,
      transport:
        options.transport ?? (options.context?.http ? "http" : "unknown"),
      protocol,
    },
    client: {
      name: safeIdentity(client?.name),
      version: safeIdentity(client?.version),
      activeApprovalPolicy: "unknown",
      backendVersion: "unknown",
      formElicitation: supportsApprovalForm(capabilities),
      capabilities: {
        formElicitation: supportsApprovalForm(capabilities),
        urlElicitation: Boolean(
          capabilities?.elicitation &&
          typeof capabilities.elicitation === "object" &&
          !Array.isArray(capabilities.elicitation) &&
          Object.hasOwn(capabilities.elicitation, "url") &&
          typeof (capabilities.elicitation as { url?: unknown }).url ===
            "object" &&
          (capabilities.elicitation as { url?: unknown }).url !== null &&
          !Array.isArray((capabilities.elicitation as { url?: unknown }).url),
        ),
        roots: Boolean(
          capabilities?.roots &&
          typeof capabilities.roots === "object" &&
          !Array.isArray(capabilities.roots),
        ),
        sampling: Boolean(
          capabilities?.sampling &&
          typeof capabilities.sampling === "object" &&
          !Array.isArray(capabilities.sampling),
        ),
      },
    },
    versionCheck: await versionCheck,
    configuration: {
      healthy: Boolean(config),
      generation: config?.generation ?? null,
      filesystem: config?.safety.filesystem ?? "unknown",
      filesystemSource: config?.provenance["safety.filesystem"] ?? "unknown",
      requireHash: config?.safety.requireHash ?? null,
      hookEnabled: config?.safety.hook.enabled ?? null,
      formattingEnabled: config?.formatting.enabled ?? null,
      sources: {
        global: Boolean(config?.sources.global),
        project: Boolean(config?.sources.project),
        environment: config?.sources.environment?.length ?? 0,
      },
      reason: config ? undefined : "configuration_unavailable",
    },
    approval: approvalDiagnostics(options.server, options.context),
    recovery: [
      "Tool-call approval and server filesystem approval are separate.",
      "A host permission profile or CLI override can supersede disk approval settings.",
      ...(codexApprovalMetadata(client)
        ? [
            "For Codex, use an effective session policy permitting MCP elicitations and answer the real approval form.",
          ]
        : []),
      "Refresh the intended package installation and reconnect; a shell version does not establish the connected server version.",
    ],
  };
}

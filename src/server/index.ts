import {
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/server";

import packageJson from "../../package.json" with { type: "json" };
import type { IntelligenceRuntimeOptions } from "../intelligence/lifecycle/service.ts";
import {
  clearSessionApprovals,
  recordApprovalTransportFailure,
} from "../runtime/approval";
import { Telemetry, type TelemetryOptions } from "../runtime/telemetry";
import { registerSkills } from "../skills";
import tools from "../tools";
import type { ExecutionOptions } from "../tools/configured";
import { createIntelligenceToolService } from "../tools/intelligence.ts";

export interface ServerOptions {
  approvalTimeoutMs?: number;
  diagnosticsFetch?: typeof fetch;
  transport?: "stdio" | "http" | "unknown";
}

export function createServer(
  intelligenceOptions: IntelligenceRuntimeOptions = {},
  telemetryOptions: TelemetryOptions = {},
  execution: ExecutionOptions = {},
  options: ServerOptions = {},
) {
  const approvalTimeoutMs = options.approvalTimeoutMs ?? 60_000;
  const server = new McpServer(
    {
      name: "ast-mcp",
      version: packageJson.version,
    },
    {
      supportedProtocolVersions: ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS],
      inputRequired: { maxRounds: 128, roundTimeoutMs: approvalTimeoutMs },
    },
  );

  // The legacy input-required shim bypasses elicitInput and sends requests directly.
  const request = server.server.request.bind(server.server);
  server.server.request = ((...args: unknown[]) => {
    if ((args[0] as { method?: string }).method === "elicitation/create") {
      const optionsIndex = args.length >= 3 ? 2 : 1;
      const requestOptions = args[optionsIndex] as
        | Parameters<typeof server.server.elicitInput>[1]
        | undefined;
      const probe =
        (args[0] as { params?: { _meta?: Record<string, unknown> } }).params
          ?._meta?.["io.ast-mcp/probe"] === true;
      const deadlineMs = probe
        ? Math.min(approvalTimeoutMs, 5000)
        : approvalTimeoutMs;
      const timeout = AbortSignal.timeout(deadlineMs);
      args[optionsIndex] = {
        ...requestOptions,
        maxTotalTimeout: Math.min(
          requestOptions?.maxTotalTimeout ?? deadlineMs,
          deadlineMs,
        ),
        signal: requestOptions?.signal
          ? AbortSignal.any([requestOptions.signal, timeout])
          : timeout,
      };
    }
    return Reflect.apply(request, undefined, args).catch((error: unknown) => {
      if ((args[0] as { method?: string }).method === "elicitation/create")
        recordApprovalTransportFailure(
          server,
          (args[0] as { params?: { _meta?: Record<string, unknown> } }).params
            ?._meta?.["io.ast-mcp/approvalChallenge"],
          error,
        );
      throw error;
    });
  }) as typeof server.server.request;

  const telemetry = new Telemetry(telemetryOptions);
  const intelligence = createIntelligenceToolService(intelligenceOptions);
  tools(server, {
    intelligence,
    telemetry,
    execution,
    diagnostics: {
      fetch: options.diagnosticsFetch,
      transport: options.transport,
    },
  });
  registerSkills(server);
  const closeServer = server.close.bind(server);
  let closePromise: Promise<void> | undefined;
  server.close = () => {
    closePromise ??= Promise.resolve().then(async () => {
      try {
        await closeServer();
      } finally {
        clearSessionApprovals(undefined, server);
        try {
          await intelligence.close?.();
        } finally {
          await telemetry.close();
        }
      }
    });
    return closePromise;
  };

  server.server.onclose = () => {
    void server.close().catch((error) => {
      process.stderr.write(
        `ast-mcp connection cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  };

  return Object.assign(server, { telemetry });
}

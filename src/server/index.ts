import {
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/server";

import packageJson from "../../package.json" with { type: "json" };
import type { IntelligenceRuntimeOptions } from "../intelligence/lifecycle/service.ts";
import { Telemetry, type TelemetryOptions } from "../runtime/telemetry";
import { registerSkills } from "../skills";
import tools from "../tools";
import type { ExecutionOptions } from "../tools/configured";
import { createIntelligenceToolService } from "../tools/intelligence.ts";

export function createServer(
  intelligenceOptions: IntelligenceRuntimeOptions = {},
  telemetryOptions: TelemetryOptions = {},
  execution: ExecutionOptions = {},
) {
  const server = new McpServer(
    {
      name: "ast-mcp",
      version: packageJson.version,
    },
    {
      supportedProtocolVersions: ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS],
    },
  );

  const telemetry = new Telemetry(telemetryOptions);
  const intelligence = createIntelligenceToolService(intelligenceOptions);
  tools(server, { intelligence, telemetry, execution });
  registerSkills(server);
  const closeServer = server.close.bind(server);
  let closePromise: Promise<void> | undefined;
  server.close = () => {
    closePromise ??= Promise.resolve().then(async () => {
      try {
        await closeServer();
      } finally {
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

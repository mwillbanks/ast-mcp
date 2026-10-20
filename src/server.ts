import { McpServer } from "@modelcontextprotocol/server";

import packageJson from "../package.json" with { type: "json" };
import type { IntelligenceRuntimeOptions } from "./intelligence/lifecycle/service.ts";
import tools from "./tools";
import { createIntelligenceToolService } from "./tools/intelligence.ts";

export function createServer(
  intelligenceOptions: IntelligenceRuntimeOptions = {},
) {
  const server = new McpServer({
    name: "ast-mcp",
    version: packageJson.version,
  });

  const intelligence = createIntelligenceToolService(intelligenceOptions);
  tools(server, { intelligence });
  const closeServer = server.close.bind(server);
  let closePromise: Promise<void> | undefined;
  server.close = () => {
    closePromise ??= Promise.resolve().then(async () => {
      try {
        await closeServer();
      } finally {
        await intelligence.close?.();
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

  return server;
}

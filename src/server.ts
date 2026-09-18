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
    closePromise ??= (async () => {
      try {
        await closeServer();
      } finally {
        await intelligence.close?.();
      }
    })();
    return closePromise;
  };

  return server;
}

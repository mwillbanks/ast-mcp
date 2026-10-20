import type { McpServer } from "@modelcontextprotocol/server";

import registerWorkspaceTools from "../intelligence/workspace/tools.ts";
import type { Telemetry } from "../runtime/telemetry";
import registerNativeCodeIntelligenceTools from "./code-intelligence";
import registerConfigurationTools from "./configuration";
import { configuredExecution } from "./configured";
import registerFileTools from "./files";
import registerIntelligenceTools, {
  type IntelligenceToolService,
} from "./intelligence";
import registerLifecycleTools from "./lifecycle";

export default function (
  server: McpServer,
  services: {
    intelligence?: IntelligenceToolService;
    telemetry?: Telemetry;
  } = {},
) {
  const execute = configuredExecution(server, services.telemetry);
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((...args: Parameters<McpServer["registerTool"]>) => {
    services.telemetry?.register(args[0]);
    return registerTool(...args);
  }) as McpServer["registerTool"];
  registerWorkspaceTools(server, execute);
  registerNativeCodeIntelligenceTools(server, execute);
  registerConfigurationTools(server, execute);
  registerFileTools(server, execute);
  registerLifecycleTools(server, execute);
  registerIntelligenceTools(server, execute, services.intelligence);
}

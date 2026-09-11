import type { McpServer } from "@modelcontextprotocol/server";

import registerWorkspaceTools from "../intelligence/workspace/tools.ts";
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
  services: { intelligence?: IntelligenceToolService } = {},
) {
  const execute = configuredExecution(server);
  registerWorkspaceTools(server, execute);
  registerNativeCodeIntelligenceTools(server, execute);
  registerConfigurationTools(server, execute);
  registerFileTools(server, execute);
  registerLifecycleTools(server, execute);
  registerIntelligenceTools(server, execute, services.intelligence);
}

import type { McpServer } from "@modelcontextprotocol/server";

import registerWorkspaceTools from "../intelligence/workspace/tools.ts";
import type { Telemetry } from "../runtime/telemetry";
import registerNativeCodeIntelligenceTools from "./code-intelligence";
import registerConfigurationTools from "./configuration";
import { configuredExecution, type ExecutionOptions } from "./configured";
import registerDiagnosticTools from "./diagnostics";
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
    execution?: ExecutionOptions;
    diagnostics?: {
      fetch?: typeof fetch;
      transport?: "stdio" | "http" | "unknown";
    };
  } = {},
) {
  const execute = configuredExecution(
    server,
    services.telemetry,
    services.execution,
  );
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((...args: Parameters<McpServer["registerTool"]>) => {
    services.telemetry?.register(args[0]);
    return registerTool(...args);
  }) as McpServer["registerTool"];
  registerWorkspaceTools(server, execute);
  registerNativeCodeIntelligenceTools(server, execute);
  registerConfigurationTools(server, execute);
  registerDiagnosticTools(server, {
    ...services.diagnostics,
    requestScoped: services.execution?.requestScoped,
  });
  registerFileTools(server, execute);
  registerLifecycleTools(server, execute);
  registerIntelligenceTools(server, execute, services.intelligence);
}

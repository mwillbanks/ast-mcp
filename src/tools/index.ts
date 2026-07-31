import type { McpServer } from "@modelcontextprotocol/server";

import registerAstBroTools from "./ast-bro";
import registerConfigurationTools from "./configuration";
import { configuredExecution } from "./configured";
import registerFileTools from "./files";
import registerLifecycleTools from "./lifecycle";

export default function (server: McpServer) {
  const execute = configuredExecution(server);
  registerConfigurationTools(server, execute);
  registerFileTools(server, execute);
  registerLifecycleTools(server, execute);
  registerAstBroTools(server, execute);
}

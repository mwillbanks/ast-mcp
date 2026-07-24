import type { McpServer } from "@modelcontextprotocol/server";

import registerAstBroTools from "./ast-bro";
import { configuredExecution } from "./configured";
import registerFileTools from "./files";
import registerLifecycleTools from "./lifecycle";

export default function (server: McpServer) {
  const execute = configuredExecution(server);
  registerFileTools(server, execute);
  registerLifecycleTools(server, execute);
  registerAstBroTools(server, execute);
}

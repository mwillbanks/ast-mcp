import type { McpServer } from "@modelcontextprotocol/server";

import registerAstBroTools from "./ast-bro";
import registerFileTools from "./files";
import registerLifecycleTools from "./lifecycle";

export default function (server: McpServer) {
  registerFileTools(server);
  registerLifecycleTools(server);
  registerAstBroTools(server);
}

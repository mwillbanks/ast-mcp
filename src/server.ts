import { McpServer } from "@modelcontextprotocol/server";
import packageJson from "../package.json" with { type: "json" };
import tools from "./tools";

export function createServer() {
  const server = new McpServer({
    name: "ast-mcp",
    version: packageJson.version,
  });

  tools(server);

  return server;
}

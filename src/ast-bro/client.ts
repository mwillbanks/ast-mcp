import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const wrapper = path.resolve(
  import.meta.dir,
  "../../node_modules/.bin/ast-bro",
);
const installerPath = path.join(
  path.dirname(realpathSync(wrapper)),
  "install.js",
);
const installer = createRequire(import.meta.url)(installerPath) as {
  getBinaryPath: () => string;
};
export const AST_BRO_BINARY = installer.getBinaryPath();
export const AST_BRO_TOOLS = [
  "map",
  "digest",
  "show",
  "implements",
  "surface",
  "deps",
  "reverse_deps",
  "cycles",
  "graph",
  "search",
  "find_related",
  "index",
  "callers",
  "callees",
  "trace",
  "impact",
  "context",
  "run",
  "squeeze",
] as const;
export async function callAstBro(
  toolName: (typeof AST_BRO_TOOLS)[number],
  args: Record<string, unknown>,
  root: string,
) {
  const client = new Client({ name: "ast-mcp", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: ["mcp"],
    command: AST_BRO_BINARY,
    cwd: root,
  });
  try {
    await client.connect(transport);
    return await client.callTool({ arguments: args, name: toolName });
  } finally {
    try {
      await client.close();
    } catch {}
  }
}

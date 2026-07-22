import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AST_BRO_BINARY } from "../runtime/native-binaries";

export { AST_BRO_BINARY } from "../runtime/native-binaries";
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

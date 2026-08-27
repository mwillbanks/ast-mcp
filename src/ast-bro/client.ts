import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { indexedAstBroCommand } from "../helpers/ast-bro";
import { captureProcess, successfulProcessOutput } from "../helpers/process";
import {
  assertAstBroAvailable,
  configuredAstBroBinary,
} from "../runtime/dependencies";

export { AST_BRO_BINARY } from "../runtime/dependencies";
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
  const binary = await configuredAstBroBinary();
  assertAstBroAvailable(binary);
  if (
    toolName === "search" ||
    toolName === "find_related" ||
    toolName === "index"
  ) {
    const commandArgs = indexedAstBroCommand(toolName, args, root);
    const processHandle = Bun.spawn([binary, ...commandArgs], {
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });
    const result = await captureProcess(processHandle);
    const stdout = successfulProcessOutput(`ast-bro ${commandArgs[0]}`, result);
    return { content: [{ text: stdout, type: "text" as const }] };
  }
  const client = new Client({ name: "ast-mcp", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: ["mcp"],
    command: binary,
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

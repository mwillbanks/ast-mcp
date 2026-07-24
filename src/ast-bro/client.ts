import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { configuredAstBroBinary } from "../runtime/dependencies";

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
  if (
    toolName === "search" ||
    toolName === "find_related" ||
    toolName === "index"
  ) {
    const commandArgs: string[] = [toolName.replace("_", "-")];
    const requestedRoot =
      toolName === "find_related"
        ? typeof args.root === "string"
          ? args.root
          : root
        : typeof args.path === "string"
          ? args.path
          : root;
    if (toolName === "search") {
      if (typeof args.query !== "string")
        throw new Error("ast-bro search requires a query");
      commandArgs.push(args.query, requestedRoot);
      if (typeof args.alpha === "number")
        commandArgs.push("--alpha", String(args.alpha));
      if (Array.isArray(args.languages))
        for (const language of args.languages)
          if (typeof language === "string")
            commandArgs.push("--lang", language);
    } else if (toolName === "find_related") {
      if (typeof args.path !== "string" || typeof args.line !== "number")
        throw new Error("ast-bro find_related requires path and line");
      commandArgs.push(
        "--file",
        args.path,
        "--line",
        String(args.line),
        requestedRoot,
      );
    } else commandArgs.push(requestedRoot);
    if (typeof args.top_k === "number")
      commandArgs.push("--top-k", String(args.top_k));
    if (args.rebuild === true) commandArgs.push("--rebuild");
    if (args.stats === true) commandArgs.push("--stats");
    if (args.json === true) commandArgs.push("--json", "--compact");

    const processHandle = Bun.spawn(
      [await configuredAstBroBinary(), ...commandArgs],
      { cwd: root, stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);
    if (exitCode !== 0)
      throw new Error(
        stderr.trim() ||
          `ast-bro ${commandArgs[0]} exited with code ${exitCode}`,
      );
    return {
      content: [{ text: stdout.trimEnd(), type: "text" as const }],
    };
  }

  const client = new Client({ name: "ast-mcp", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: ["mcp"],
    command: await configuredAstBroBinary(),
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

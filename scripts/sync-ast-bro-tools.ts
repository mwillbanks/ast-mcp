import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AST_BRO_TOOLS } from "../src/ast-bro/client";
import { configuredAstBroBinary } from "../src/runtime/dependencies";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortKeys(entry)]),
  );
}

const metadataPath = path.resolve(import.meta.dir, "../src/ast-bro/tools.json");
const client = new Client({
  name: "ast-mcp-schema-sync",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  args: ["mcp"],
  command: await configuredAstBroBinary(),
  cwd: path.resolve(import.meta.dir, ".."),
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  const snapshot = Object.fromEntries(
    [...AST_BRO_TOOLS].sort().map((name) => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`ast-bro MCP did not advertise ${name}`);
      return [
        name,
        {
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        },
      ];
    }),
  );
  const expected = `${JSON.stringify(sortKeys(snapshot), null, 2)}\n`;

  if (process.argv.includes("--write")) {
    await writeFile(metadataPath, expected);
    const biome = Bun.which("biome");
    if (!biome) throw new Error("Biome is required to format tool metadata");
    const formatted = Bun.spawnSync([
      biome,
      "check",
      metadataPath,
      "--write",
      "--unsafe",
      "--reporter",
      "concise",
    ]);
    if (formatted.exitCode !== 0)
      throw new Error(
        formatted.stderr.toString().trim() || "Biome formatting failed",
      );
    console.log(`Updated ${metadataPath}`);
  } else {
    const current = JSON.parse(await readFile(metadataPath, "utf8"));
    if (
      JSON.stringify(sortKeys(current)) !== JSON.stringify(sortKeys(snapshot))
    )
      throw new Error(
        "ast-bro tool metadata is stale; run bun run ast-bro:schemas",
      );
    console.log("ast-bro tool metadata is current");
  }
} finally {
  await client.close();
}

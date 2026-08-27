import { expect, test } from "bun:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  AST_BRO_BINARY,
  AST_BRO_TOOLS,
  callAstBro,
} from "../src/ast-bro/client";
import metadata from "../src/ast-bro/tools.json";

function expectedToolNames() {
  return [
    ...AST_BRO_TOOLS,
    "config_core",
    "config_paths",
    "config_status",
    "document_query",
    "file_capabilities",
    "file_chattr",
    "file_delete",
    "file_hash",
    "file_patch",
    "file_read",
    "file_rename",
    "file_write",
    "policy_check",
  ].sort();
}

function toolProperties(
  tools: Array<{ inputSchema?: unknown; name: string }>,
  name: string,
) {
  const schema = tools.find((tool) => tool.name === name)?.inputSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  return schema?.properties;
}

async function withStdioTools(
  run: (
    tools: Array<{ description?: string; inputSchema?: unknown; name: string }>,
  ) => void,
) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../src/index.ts")],
    command: "bun",
    cwd: path.resolve(import.meta.dir, ".."),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    run((await client.listTools()).tools);
  } finally {
    await client.close();
  }
}

test("stdio server exposes only ast-mcp tools", async () => {
  await withStdioTools((tools) => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(expectedToolNames());
  });
});

test("stdio tool schemas expose batched file and map contracts", async () => {
  await withStdioTools((tools) => {
    const run = tools.find((tool) => tool.name === "run");
    expect(run?.description).toContain(
      "Normal agent edits belong in file_patch's declared files batch",
    );
    expect(toolProperties(tools, "run")?.pattern).toBeTruthy();
    expect(
      (toolProperties(tools, "map") as { detail?: { enum?: string[] } })?.detail
        ?.enum,
    ).toEqual(["names", "signatures", "full"]);
    expect(toolProperties(tools, "file_read")?.files).toBeTruthy();
    expect(toolProperties(tools, "file_read")?.filePath).toBeUndefined();
    expect(toolProperties(tools, "file_hash")?.filePaths).toBeTruthy();
  });
});

test("CLI mcp subcommand remains alive for a stdio handshake", async () => {
  const client = new Client({ name: "cli-test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../bin/ast-mcp.ts"), "mcp"],
    command: "bun",
    cwd: path.resolve(import.meta.dir, ".."),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  } finally {
    await client.close();
  }
});

test("upstream ast-bro MCP run exposes write mode", async () => {
  const client = new Client({ name: "upstream-schema-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: ["mcp"],
    command: AST_BRO_BINARY,
    cwd: path.resolve(import.meta.dir, ".."),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const run = (await client.listTools()).tools.find(
      (tool) => tool.name === "run",
    );
    expect(
      (
        run?.inputSchema as
          | { properties?: Record<string, { type?: string }> }
          | undefined
      )?.properties?.write?.type,
    ).toBe("boolean");
    expect(run?.description).toContain("write: true");
  } finally {
    await client.close();
  }
});

test("calls ast-bro intelligence natively", async () => {
  const result = await callAstBro(
    "map",
    { paths: ["src/server.ts"] },
    path.resolve(import.meta.dir, ".."),
  );
  expect(result.isError).not.toBeTrue();
  expect(
    result.content.some(
      (item) => item.type === "text" && item.text.includes("createServer"),
    ),
  ).toBeTrue();
  expect(
    (
      await callAstBro(
        "run",
        { pattern: "__AST_MCP_NO_MATCH__", write: true },
        path.resolve(import.meta.dir, ".."),
      )
    ).isError,
  ).not.toBeTrue();
});

test("stdio rejects outside paths for every path-bearing ast-bro tool", async () => {
  const client = new Client({ name: "root-boundary-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../src/index.ts")],
    command: "bun",
    cwd: path.resolve(import.meta.dir, ".."),
    stderr: "pipe",
  });
  const tools = metadata as Record<
    string,
    { inputSchema: { properties: Record<string, unknown> } }
  >;
  try {
    await client.connect(transport);
    for (const [name, definition] of Object.entries(tools)) {
      const args: Record<string, unknown> = {};
      for (const key of ["file", "path", "root", "paths"])
        if (key in definition.inputSchema.properties)
          args[key] = key === "paths" ? ["/etc/hosts"] : "/etc/hosts";
      if (Object.keys(args).length === 0) continue;
      const result = await client.callTool({ arguments: args, name });
      expect(result.isError).toBeTrue();
      expect(result.content[0]?.type).toBe("text");
      expect((result.content[0] as { text: string }).text).toContain(
        "outside configured workspace and paths roots",
      );
    }
  } finally {
    await client.close();
  }
});

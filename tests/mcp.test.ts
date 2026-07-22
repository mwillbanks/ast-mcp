import { expect, test } from "bun:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AST_BRO_TOOLS, callAstBro } from "../src/ast-bro/client";
import metadata from "../src/ast-bro/tools.json";

test("stdio server exposes only ast-mcp tools", async () => {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../src/index.ts")],
    command: "bun",
    cwd: path.resolve(import.meta.dir, ".."),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        ...AST_BRO_TOOLS,
        "file_chattr",
        "file_delete",
        "file_hash",
        "file_patch",
        "file_read",
        "file_write",
      ].sort(),
    );
    const runSchema = tools.find((tool) => tool.name === "run")?.inputSchema;
    const runDescription = tools.find(
      (tool) => tool.name === "run",
    )?.description;
    expect(runDescription).toContain(
      "Normal agent edits belong in keyed file_patch",
    );
    expect(
      (runSchema as { properties?: Record<string, unknown> }).properties
        ?.pattern,
    ).toBeTruthy();

    const fileReadSchema = tools.find((tool) => tool.name === "file_read")
      ?.inputSchema as { properties?: Record<string, unknown> };
    expect(fileReadSchema.properties?.files).toBeTruthy();
    expect(fileReadSchema.properties?.filePath).toBeUndefined();

    const fileHashSchema = tools.find((tool) => tool.name === "file_hash")
      ?.inputSchema as { properties?: Record<string, unknown> };
    expect(fileHashSchema.properties?.filePaths).toBeTruthy();
  } finally {
    await client.close();
  }
});
test("upstream ast-bro MCP run exposes write mode", async () => {
  const client = new Client({ name: "upstream-schema-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: ["mcp"],
    command: path.resolve(import.meta.dir, "../node_modules/.bin/ast-bro"),
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
        "outside AST_MCP_ROOTS",
      );
    }
  } finally {
    await client.close();
  }
});

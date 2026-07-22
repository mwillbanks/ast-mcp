import { expect, test } from "bun:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("file tools advertise keyed batch schemas", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const client = new Client({ name: "batch-schema-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.resolve(root, "src/index.ts")],
    command: "bun",
    cwd: root,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const patch = tools.find((tool) => tool.name === "file_patch");
    const write = tools.find((tool) => tool.name === "file_write");
    const patchSchema = patch?.inputSchema as {
      additionalProperties?: {
        properties?: Record<string, unknown>;
      };
      properties?: Record<string, unknown>;
    };
    const writeSchema = write?.inputSchema as {
      additionalProperties?: {
        properties?: Record<string, unknown>;
      };
      properties?: Record<string, unknown>;
    };

    expect(patchSchema.properties?.filePath).toBeUndefined();
    expect(patchSchema.additionalProperties?.properties?.astRules).toBeTruthy();
    expect(patchSchema.additionalProperties?.properties?.preview).toBeTruthy();
    expect(
      patchSchema.additionalProperties?.properties?.aiderBlocks,
    ).toBeTruthy();
    expect(writeSchema.properties?.filePath).toBeUndefined();
    expect(writeSchema.additionalProperties?.properties?.content).toBeTruthy();
  } finally {
    await client.close();
  }
});

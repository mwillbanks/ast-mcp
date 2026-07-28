import { expect, test } from "bun:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("mutation tools advertise a declared files batch schema", async () => {
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
    const batchSchema = (name: string) =>
      tools.find((tool) => tool.name === name)?.inputSchema as {
        additionalProperties?: unknown;
        properties?: {
          files?: {
            additionalProperties?: {
              properties?: Record<string, unknown>;
            };
            type?: string;
          };
        };
      };

    for (const name of [
      "file_write",
      "file_patch",
      "file_chattr",
      "file_delete",
      "file_rename",
    ]) {
      const schema = batchSchema(name);
      expect(schema.properties?.files?.type).toBe("object");
      expect(schema.additionalProperties).toBeFalse();
    }
    expect(
      batchSchema("file_patch").properties?.files?.additionalProperties
        ?.properties?.astRules,
    ).toBeTruthy();
    expect(
      batchSchema("file_patch").properties?.files?.additionalProperties
        ?.properties?.aiderBlocks,
    ).toBeTruthy();
    expect(
      batchSchema("file_write").properties?.files?.additionalProperties
        ?.properties?.content,
    ).toBeTruthy();
  } finally {
    await client.close();
  }
});

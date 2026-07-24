import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("stdio resolves project TOML from client-advertised roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-client-root-"));
  await mkdir(path.join(root, ".git"));
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    '[workspace]\nroots = ["."]\n',
  );
  const readable = path.join(root, "project-note.txt");
  await writeFile(readable, "project configuration\n");

  const client = new Client(
    { name: "config-roots-test", version: "1.0.0" },
    { capabilities: { roots: {} } },
  );
  client.setRequestHandler("roots/list", async () => ({
    roots: [{ name: "configured project", uri: pathToFileURL(root).href }],
  }));
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../src/index.ts")],
    command: "bun",
    cwd: path.resolve(import.meta.dir, ".."),
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      arguments: { files: [{ filePath: readable }] },
      name: "file_read",
    });
    expect(result.isError).not.toBeTrue();
    expect(result.content[0]).toMatchObject({
      type: "text",
    });
    expect((result.content[0] as { text: string }).text).toContain(
      "project configuration",
    );
  } finally {
    await client.close();
    await rm(root, { force: true, recursive: true });
  }
});

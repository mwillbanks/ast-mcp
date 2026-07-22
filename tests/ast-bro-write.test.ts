import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { patchFile } from "../src/patch/engine";
import { sha256 } from "../src/runtime/hash";

let folder = "";
afterEach(async () => {
  delete process.env.AST_MCP_ROOTS;
  delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  if (folder) await rm(folder, { force: true, recursive: true });
  folder = "";
});

async function astMcpClient(root: string) {
  process.env.AST_MCP_ROOTS = root;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  const client = new Client({ name: "ast-bro-write-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../src/index.ts")],
    command: "bun",
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      AST_MCP_ALLOW_EXTERNAL_ROOTS: "1",
      AST_MCP_ROOTS: root,
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

test("direct run.write rewrites the first match per file and dprint formats it", async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-run-write-"));
  const filePath = path.join(folder, "value.ts");
  await writeFile(filePath, "oldName(a);oldName(b);const compact={x:1};\n");
  const client = await astMcpClient(folder);
  try {
    const result = await client.callTool({
      arguments: {
        json: true,
        lang: "typescript",
        paths: [filePath],
        pattern: "oldName($A)",
        rewrite: "newName($A)",
        write: true,
      },
      name: "run",
    });
    expect(result.isError).not.toBeTrue();
    expect(await readFile(filePath, "utf8")).toBe(
      "newName(a);\noldName(b);\nconst compact = { x: 1 };\n",
    );
  } finally {
    await client.close();
  }
});

test("file_patch uses ast-bro run and requires one structural match", async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-run-patch-"));
  process.env.AST_MCP_ROOTS = folder;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  const filePath = path.join(folder, "value.ts");
  await writeFile(filePath, "oldName(a);\noldName(b);\n");
  const expectedSha256 = sha256(await readFile(filePath, "utf8"));
  await expect(
    patchFile({
      astRule: {
        expectedMatches: 2,
        fix: "newName($A)",
        pattern: "oldName($A)",
      },
      expectedSha256,
      filePath,
      patchStrategy: "ast",
    }),
  ).rejects.toThrow("first match per file");
  expect(await readFile(filePath, "utf8")).toContain("oldName(a)");
});

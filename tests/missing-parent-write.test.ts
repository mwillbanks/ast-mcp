import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFileSafely } from "../src/patch/engine";

test("file_write creates nested missing parents after guarded ENOENT", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-parent-write-"));
  const previousRoots = process.env.AST_MCP_ROOTS;
  const previousExternalRoots = process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  process.env.AST_MCP_ROOTS = root;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  const filePath = path.join(root, "nested", "deeper", "note.txt");
  try {
    const result = await writeFileSafely({
      content: "created\n",
      filePath,
    });
    expect(result.created).toBeTrue();
    expect(await readFile(filePath, "utf8")).toBe("created\n");
  } finally {
    if (previousRoots === undefined) delete process.env.AST_MCP_ROOTS;
    else process.env.AST_MCP_ROOTS = previousRoots;
    if (previousExternalRoots === undefined)
      delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
    else process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = previousExternalRoots;
    await rm(root, { force: true, recursive: true });
  }
});

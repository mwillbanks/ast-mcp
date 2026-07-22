import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFileSafely } from "../src/patch/engine";
import { readFileSafely } from "../src/runtime/file-read";
import { sha256 } from "../src/runtime/hash";

let folder = "";
afterEach(async () => {
  delete process.env.AST_MCP_ROOTS;
  delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  if (folder) await rm(folder, { force: true, recursive: true });
  folder = "";
});

test("file_read returns a bounded non-AST slice and whole-file hash", async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-read-"));
  process.env.AST_MCP_ROOTS = folder;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  const filePath = path.join(folder, "note.xml");
  const content = "zero\none\ntwo\nthree\n";
  await writeFile(filePath, content);
  expect(await readFileSafely({ filePath, lines: [1, 3] })).toEqual({
    content: "one\ntwo\n",
    filePath: await realpath(filePath),
    hasMore: true,
    lines: { requested: [1, 3], returned: [1, 3] },
    sha256: sha256(content),
    size: Buffer.byteLength(content),
    truncated: false,
  });
});

test("file_write cannot replace an AST-capable existing file", async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-write-route-"));
  process.env.AST_MCP_ROOTS = folder;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  const filePath = path.join(folder, "value.ts");
  await writeFile(filePath, "const value = 1;\n");
  await expect(
    writeFileSafely({
      content: "const value = 2;\n",
      expectedSha256: sha256(await readFile(filePath, "utf8")),
      filePath,
    }),
  ).rejects.toThrow("file_patch");
});

test("external roots require an explicit opt-in and anchor relative paths", async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-external-root-"));
  process.env.AST_MCP_ROOTS = folder;
  delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  await expect(readFileSafely({ filePath: "missing.md" })).rejects.toThrow(
    "AST_MCP_ALLOW_EXTERNAL_ROOTS=1",
  );
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  await writeFileSafely({ content: "created\n", filePath: "created.md" });
  expect(await readFile(path.join(folder, "created.md"), "utf8")).toContain(
    "created",
  );
});

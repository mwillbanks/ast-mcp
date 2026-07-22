import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { patchFile } from "../src/patch/engine";
import { sha256 } from "../src/runtime/hash";

let folder = "";
afterEach(async () => {
  delete process.env.AST_MCP_ROOTS;
  delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  if (folder) await rm(folder, { force: true, recursive: true });
  folder = "";
});
test("parseable source accepts only an AST rule", async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-ast-"));
  process.env.AST_MCP_ROOTS = folder;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  const file = path.join(folder, "value.ts");
  await writeFile(file, "const value = 1\n");
  const hash = sha256(await readFile(file, "utf8"));
  await expect(
    patchFile({
      aiderBlock: { replace: "2", search: "1" },
      expectedSha256: hash,
      filePath: file,
      patchStrategy: "aider_block",
    }),
  ).rejects.toThrow("structurally rewritable");
  const result = await patchFile({
    astRule: { fix: "const $A = 2", pattern: "const $A = $B" },
    expectedSha256: hash,
    filePath: file,
    patchStrategy: "ast",
  });
  expect(result.strategy).toBe("ast");
  expect(await readFile(file, "utf8")).toContain("value = 2");
});

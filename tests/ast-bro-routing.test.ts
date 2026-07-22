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

test("ast-bro map parse errors route source through the Aider fallback", async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-map-routing-"));
  process.env.AST_MCP_ROOTS = folder;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  const filePath = path.join(folder, "broken.ts");
  await writeFile(filePath, "const broken = ;\n");
  const result = await patchFile({
    aiderBlock: {
      replace: "const fixed = 1;",
      search: "const broken = ;",
    },
    expectedSha256: sha256(await readFile(filePath, "utf8")),
    filePath,
    patchStrategy: "aider_block",
  });
  expect(result.strategy).toBe("aider_block");
  expect(await readFile(filePath, "utf8")).toBe("const fixed = 1;\n");
});

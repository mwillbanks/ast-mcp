import { afterEach, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callAstBro } from "../src/ast-bro/client";
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

test("semantic indexes stay at the workspace root for nested analysis", async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-index-root-"));
  const nested = path.join(folder, "change", "specs");
  const source = path.join(nested, "identity.ts");
  await mkdir(nested, { recursive: true });
  await writeFile(source, "export const identity = 'stable';\n");

  await callAstBro(
    "search",
    {
      alpha: 0.5,
      json: true,
      languages: ["typescript"],
      path: nested,
      query: "stable identity",
      top_k: 3,
    },
    folder,
  );
  await access(path.join(folder, ".ast-bro", "index", "meta.json"));
  await expect(access(path.join(nested, ".ast-bro"))).rejects.toThrow();

  await callAstBro(
    "find_related",
    { json: true, line: 1, path: source, root: nested, top_k: 3 },
    folder,
  );
  await expect(access(path.join(nested, ".ast-bro"))).rejects.toThrow();
});

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withConfig } from "../src/config";
import { patchFiles } from "../src/patch/engine";
import { sha256 } from "../src/runtime/hash";

test("AST batch preflight preserves bounded match locations before commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-ast-batch-"));
  const source = path.join(root, "value.ts");
  const original =
    "export const add = (left: number, right: number) => left + right;\n";
  await mkdir(path.join(root, ".git"));
  await writeFile(source, original);
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    [
      "version = 2",
      "[formatting]",
      "enabled = false",
      'fallback = "preserve"',
      "[[paths]]",
      'id = "workspace"',
      'path = "."',
      'policies = { read = "allow", write = "allow", delete = "allow" }',
      "",
    ].join("\n"),
  );
  try {
    const result = await withConfig(
      {
        cwd: root,
        env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
      },
      () =>
        patchFiles({
          [source]: {
            astRules: [
              { expectedMatches: 1, fix: "$A - $B", pattern: "$A + $B" },
            ],
            expectedSha256: sha256(original),
            patchStrategy: "ast",
          },
        }),
    );
    expect(result).toMatchObject({
      files: { [source]: { matches: 1, strategy: "ast" } },
    });
    expect(await readFile(source, "utf8")).toContain("left - right");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

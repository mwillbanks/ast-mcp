import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withConfig } from "../src/config";
import { patchFile, patchFiles } from "../src/patch/engine";
import {
  inspectFileCapabilities,
  validateStructuredCandidate,
} from "../src/runtime/file-capabilities";
import { sha256 } from "../src/runtime/hash";

const folders: string[] = [];
const environment = (root: string) => ({
  AST_MCP_ALLOW_EXTERNAL_ROOTS: "1",
  AST_MCP_ROOTS: root,
});

afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

async function root(prefix: string) {
  const value = await mkdtemp(path.join(os.tmpdir(), prefix));
  folders.push(value);
  return value;
}

test("structured capability parsers cover JSONC and YAML", async () => {
  const folder = await root("ast-mcp-structured-capability-");
  const jsonc = path.join(folder, "value.jsonc");
  const yaml = path.join(folder, "value.yaml");
  await writeFile(jsonc, '{ // comment\n  "value": 1\n}\n');
  await writeFile(yaml, "value: 1\n");

  await withConfig({ cwd: folder, env: environment(folder) }, async () => {
    const jsoncCapability = await inspectFileCapabilities(jsonc);
    const yamlCapability = await inspectFileCapabilities(yaml);
    expect(jsoncCapability.parseStatus).toBe("parseable");
    expect(yamlCapability).toMatchObject({
      intrinsic: { patch: ["ast", "aider_block"] },
      parseStatus: "parseable",
    });
    await validateStructuredCandidate(jsoncCapability, '{"value":2}\n');
    await validateStructuredCandidate(yamlCapability, "value: 2\n");
  });
});

test("strategy adapters reject missing operations and disabled strategies", async () => {
  const folder = await root("ast-mcp-strategy-policy-");
  const source = path.join(folder, "value.ts");
  await writeFile(source, "export const value = 1;\n");

  await withConfig({ cwd: folder, env: environment(folder) }, async () => {
    await expect(
      patchFiles({
        [source]: {
          expectedSha256: sha256(await readFile(source, "utf8")),
          patchStrategy: "ast",
        },
      }),
    ).rejects.toMatchObject({ code: "patch_strategy_arguments" });
  });

  await writeFile(
    path.join(folder, "ast-mcp.toml"),
    [
      "version = 2",
      "[formatting]",
      "enabled = false",
      "[files.patch]",
      'strategies = ["ast"]',
      "[[paths]]",
      'id = "workspace"',
      'path = "."',
      'policies = { read = "allow", write = "allow" }',
      "",
    ].join("\n"),
  );

  await withConfig({ cwd: folder, env: environment(folder) }, async () => {
    await expect(
      patchFile({
        aiderBlock: { replace: "2", search: "1" },
        expectedSha256: sha256(await readFile(source, "utf8")),
        filePath: source,
        patchStrategy: "aider_block",
      }),
    ).rejects.toMatchObject({ code: "patch_strategy_unavailable" });
  });
});

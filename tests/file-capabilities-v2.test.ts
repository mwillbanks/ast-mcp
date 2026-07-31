import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withConfig } from "../src/config";
import { patchFile, patchFiles } from "../src/patch/engine";
import { patchStrategyAdapter } from "../src/patch/strategy";
import {
  inspectFileCapabilities,
  inspectFileCapabilitiesSafely,
  validateStructuredCandidate,
} from "../src/runtime/file-capabilities";
import { readFileSafely } from "../src/runtime/file-read";
import { sha256 } from "../src/runtime/hash";

const folders: string[] = [];
const environment = (root: string) => ({
  AST_MCP_ALLOW_EXTERNAL_ROOTS: "1",
  AST_MCP_ROOTS: root,
});

async function temporaryRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  folders.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

test("file capabilities classify source, document, text, and binary files", async () => {
  const root = await temporaryRoot("ast-mcp-capabilities-");
  const source = path.join(root, "value.ts");
  const json = path.join(root, "value.json");
  const toml = path.join(root, "value.toml");
  const text = path.join(root, "value.txt");
  const binary = path.join(root, "value.bin");
  await Promise.all([
    writeFile(source, "export const value = 1;\n"),
    writeFile(json, '{"value":1}\n'),
    writeFile(toml, "value = 1\n"),
    writeFile(text, "value\n"),
    writeFile(binary, Buffer.from([0, 1, 2, 3])),
  ]);

  await withConfig({ cwd: root, env: environment(root) }, async () => {
    const [
      sourceCapability,
      jsonCapability,
      tomlCapability,
      textCapability,
      binaryCapability,
    ] = await inspectFileCapabilitiesSafely([source, json, toml, text, binary]);
    expect(sourceCapability).toMatchObject({
      intrinsic: { patch: ["ast", "aider_block"], read: ["ast", "text"] },
      kind: "source",
      parseStatus: "parseable",
    });
    expect(sourceCapability.effective.aiderMatchers).toEqual([
      "exact",
      "whitespace",
      "relative-indentation",
      "diff-match-patch",
    ]);
    expect(jsonCapability).toMatchObject({
      intrinsic: { patch: ["ast", "aider_block"], read: ["ast", "text"] },
      kind: "document",
      parseStatus: "parseable",
    });
    expect(tomlCapability).toMatchObject({
      intrinsic: { patch: ["aider_block"], read: ["ast", "text"] },
      kind: "document",
      parseStatus: "parseable",
    });
    expect(textCapability).toMatchObject({
      intrinsic: { patch: ["aider_block"], read: ["text"] },
      kind: "text",
      parseStatus: "unsupported",
    });
    expect(binaryCapability).toMatchObject({
      intrinsic: { patch: [], read: [] },
      kind: "binary",
    });
  });
});

test("version 2 enables every supported method and matcher by default", async () => {
  const root = await temporaryRoot("ast-mcp-v2-default-methods-");
  const source = path.join(root, "value.ts");
  const document = path.join(root, "value.json");
  await Promise.all([
    writeFile(source, "export const value = 1;\n"),
    writeFile(document, '{"value":1}\n'),
    writeFile(path.join(root, "ast-mcp.toml"), "version = 2\n"),
  ]);

  await withConfig({ cwd: root, env: environment(root) }, async () => {
    const capabilities = await inspectFileCapabilities(source);
    expect(capabilities.effective).toEqual({
      aiderMatchers: [
        "exact",
        "whitespace",
        "relative-indentation",
        "diff-match-patch",
      ],
      patch: ["ast", "aider_block"],
      read: ["ast", "text"],
    });
    const result = await readFileSafely({
      filePath: document,
      mode: "ast",
      selectors: ["/value"],
    });
    expect(result).toMatchObject({
      ast: {
        schema: "ast-mcp.document-read.v1",
        values: [{ selector: "/value", value: 1 }],
      },
      requestedMode: "ast",
      resolvedMode: "ast",
    });
  });
});

test("capabilities validate structured candidates without touching the live file", async () => {
  const root = await temporaryRoot("ast-mcp-candidate-");
  const source = path.join(root, "value.ts");
  const json = path.join(root, "value.json");
  const invalidJson = path.join(root, "invalid.json");
  await Promise.all([
    writeFile(source, "export const value = 1;\n"),
    writeFile(json, '{"value":1}\n'),
    writeFile(invalidJson, "{invalid\n"),
  ]);

  await withConfig({ cwd: root, env: environment(root) }, async () => {
    const sourceCapability = await inspectFileCapabilities(source);
    const jsonCapability = await inspectFileCapabilities(json);
    const invalidCapability = await inspectFileCapabilities(invalidJson);
    expect(invalidCapability.parseStatus).toBe("invalid");
    expect(invalidCapability.effective.read).toEqual(["text"]);
    await validateStructuredCandidate(jsonCapability, '{"value":2}\n');
    await expect(
      validateStructuredCandidate(jsonCapability, "{invalid"),
    ).rejects.toMatchObject({ code: "candidate_parse_error" });
    await validateStructuredCandidate(
      sourceCapability,
      "export const value = 2;\n",
    );
    await expect(
      validateStructuredCandidate(sourceCapability, "export const = ;\n"),
    ).rejects.toMatchObject({ code: "candidate_parse_error" });
    expect(await readFile(source, "utf8")).toBe("export const value = 1;\n");
  });
});

test("version 2 filters effective methods and safe Aider matchers", async () => {
  const root = await temporaryRoot("ast-mcp-method-policy-");
  const source = path.join(root, "value.ts");
  const text = path.join(root, "value.txt");
  await writeFile(source, "export const value = 1;\n");
  await writeFile(text, "alpha   beta\n");
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    [
      "version = 2",
      "[formatting]",
      "enabled = false",
      "[files.read]",
      'modes = ["text"]',
      "[files.patch]",
      'strategies = ["aider_block"]',
      'aider_matchers = ["exact"]',
      "[[paths]]",
      'id = "workspace"',
      'path = "."',
      'policies = { read = "allow", write = "allow" }',
      "",
    ].join("\n"),
  );

  await withConfig({ cwd: root, env: environment(root) }, async () => {
    const capabilities = await inspectFileCapabilities(source);
    expect(capabilities.effective).toEqual({
      aiderMatchers: ["exact"],
      patch: ["aider_block"],
      read: ["text"],
    });
    expect(() => patchStrategyAdapter(undefined)).toThrow(
      "patchStrategy is required",
    );
    await expect(
      patchFile({
        astRule: {
          fix: "export const value = 2",
          pattern: "export const value = 1",
        },
        expectedSha256: sha256(await readFile(source, "utf8")),
        filePath: source,
        patchStrategy: "ast",
      }),
    ).rejects.toMatchObject({ code: "patch_strategy_unavailable" });
    await expect(
      patchFile({
        aiderBlock: { replace: "changed", search: "alpha beta" },
        expectedSha256: sha256(await readFile(text, "utf8")),
        filePath: text,
        patchStrategy: "aider_block",
      }),
    ).rejects.toMatchObject({ code: "aider_matcher_disabled" });
    await expect(
      patchFiles({
        [text]: {
          expectedSha256: sha256(await readFile(text, "utf8")),
          patchStrategy: "aider_block",
        },
      }),
    ).rejects.toMatchObject({ code: "patch_strategy_arguments" });
  });
});

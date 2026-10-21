import { afterAll, expect, test } from "bun:test";

import { Language, Parser } from "web-tree-sitter";

import {
  analyzeInfraLanguage,
  closeInfraLanguageWorker,
} from "../../../../src/intelligence/languages/infra/index.ts";
import {
  resolveWasmGrammarAsset,
  wasmGrammarAssets,
  wasmGrammarFingerprint,
  wasmParserFingerprint,
  wasmProviderVersions,
} from "../../../../src/intelligence/languages/shared/wasm-assets.ts";

afterAll(closeInfraLanguageWorker);
test("build metadata records the installed grammar and runtime providers", () => {
  expect(wasmProviderVersions()).toEqual({
    "tree-sitter-wasm": "2.0.4",
    "tree-sitter-systemverilog": "0.4.1",
    "web-tree-sitter": "0.27.1",
  });
});
test("all shipped WASM grammars remain loadable", async () => {
  await Parser.init();
  for (const id of wasmGrammarAssets) {
    const grammar = await Language.load(resolveWasmGrammarAsset(id));
    const parser = new Parser();
    try {
      parser.setLanguage(grammar);
      expect(parser.language).toBe(grammar);
    } finally {
      parser.delete();
    }
  }
});
test("replacement SystemVerilog preserves surrogate pairs and worker byte ranges", async () => {
  await Parser.init();
  const grammar = await Language.load(resolveWasmGrammarAsset("systemverilog"));
  const parser = new Parser();
  parser.setLanguage(grammar);
  const source = 'module top; string label = "😀"; logic signal; endmodule';
  const tree = parser.parse(source);
  try {
    if (!tree) throw new Error("Expected a syntax tree");
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.endIndex).toBe(source.length);
    const signal = tree.rootNode
      .descendantsOfType("simple_identifier")
      .find((node) => node.text === "signal");
    if (!signal) throw new Error("Expected signal identifier");
    expect(signal.startIndex).toBe(source.indexOf("signal"));
    expect(signal.endIndex).toBe(source.indexOf("signal") + "signal".length);
    const facts = await analyzeInfraLanguage({
      languageId: "systemverilog",
      source,
    });
    const node = facts.nodes.find(
      ({ range }) =>
        range.startCoordinate.utf16Offset === signal.startIndex &&
        range.endCoordinate.utf16Offset === signal.endIndex,
    );
    if (!node) throw new Error("Expected worker identifier range");
    expect(node.range.startByte).toBe(
      Buffer.byteLength(source.slice(0, signal.startIndex)),
    );
    expect(node.range.endByte).toBe(
      Buffer.byteLength(source.slice(0, signal.endIndex)),
    );
  } finally {
    tree?.delete();
    parser.delete();
  }
});
test("Verilog subset shares the replacement asset with a distinct cache identity", () => {
  expect(resolveWasmGrammarAsset("verilog")).toBe(
    resolveWasmGrammarAsset("systemverilog"),
  );
  expect(wasmGrammarFingerprint("systemverilog:verilog-subset-v1")).not.toBe(
    wasmGrammarFingerprint("systemverilog"),
  );
  expect(wasmParserFingerprint()).toMatch(/^[a-f0-9]{64}$/);
});

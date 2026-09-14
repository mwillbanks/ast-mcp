import { describe, expect, test } from "bun:test";
import {
  EmbeddedSourceMap,
  findStructuralMatches,
  LANGUAGE_CAPABILITY_CATALOG,
  LanguageRegistry,
  ParserError,
  ParserWorkerPool,
  PINNED_GRAMMAR_REGISTRATIONS,
  parseSource,
  rewriteStructuralMatches,
  SourceCoordinateIndex,
  StructuredParserRegistry,
  validateGrammarAsset,
} from "../src/intelligence/parser/index.ts";
import { languageForExtension } from "../src/patch/languages.ts";

describe("native intelligence parser", () => {
  test("extracts reusable TypeScript syntax facts without paths", () => {
    const source = [
      'import client, { request as send } from "./client.ts";',
      "export class Service extends Base implements Runnable {",
      "  run(value: string) { return send(value); }",
      "}",
      "export const factory = () => new Service();",
    ].join("\n");
    const facts = parseSource({ languageId: "typescript", source });

    expect(facts.partial).toBe(false);
    expect(facts.symbols.map((symbol) => symbol.qualifiedName)).toEqual([
      "Service",
      "Service.run",
      "factory",
    ]);
    expect(
      facts.imports.map((entry) => [
        entry.importedName,
        entry.localName,
        entry.source,
      ]),
    ).toEqual([
      ["default", "client", "./client.ts"],
      ["request", "send", "./client.ts"],
    ]);
    expect(facts.exports.map((entry) => entry.exportedName)).toContain(
      "Service",
    );
    expect(facts.inheritance.map((entry) => entry.targetName)).toEqual([
      "Base",
    ]);
    expect(facts.implementations.map((entry) => entry.targetName)).toEqual([
      "Runnable",
    ]);
    expect(facts.calls.map((call) => call.callee)).toEqual(["send"]);
    expect(
      facts.symbols.find((symbol) => symbol.name === "factory")?.exported,
    ).toBe(true);
    expect(facts.nodes.length).toBeGreaterThan(10);
  });

  test("extracts primitive and destructured variable bindings", () => {
    const source = [
      "const plain = 1;",
      "let { source: alias, shorthand, nested: { value }, ...rest } = input;",
      "var [first, , ...tail] = items;",
    ].join("\n");
    const facts = parseSource({ languageId: "typescript", source });
    const variables = facts.symbols.filter(
      (symbol) => symbol.kind === "variable",
    );

    expect(variables.map((symbol) => symbol.name)).toEqual([
      "plain",
      "alias",
      "shorthand",
      "value",
      "rest",
      "first",
      "tail",
    ]);
    for (const symbol of variables) {
      const { startCoordinate, endCoordinate } = symbol.declarationRange;
      expect(
        source.slice(startCoordinate.utf16Offset, endCoordinate.utf16Offset),
      ).toBe(symbol.name);
    }
  });

  test("rejects invalid parser node bounds before parsing", () => {
    for (const maxNodes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        parseSource({
          languageId: "typescript",
          maxNodes,
          source: "const value = 1;",
        });
        throw new Error("Expected invalid maxNodes to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ParserError);
        expect((error as ParserError).code).toBe("invalid-request");
        expect((error as ParserError).retryable).toBe(false);
      }
    }
  });

  test("extracts import and export forms plus declaration kinds", () => {
    const facts = parseSource({
      languageId: "typescript",
      source: [
        'import "./side-effect.ts";',
        'import * as namespace from "./namespace.ts";',
        'export { value as renamed } from "./values.ts";',
        "export default function main() {}",
        'export * from "./all.ts";',
        "interface Shape { width: number }",
        "type Alias = Shape;",
        "enum Kind { One }",
        "function* iterate() { yield namespace; }",
      ].join("\n"),
    });

    expect(
      facts.imports.map((entry) => [entry.importedName, entry.localName]),
    ).toEqual([
      ["*side-effect*", "*side-effect*"],
      ["*", "namespace"],
    ]);
    expect(facts.exports.map((entry) => entry.exportedName)).toEqual([
      "renamed",
      "main",
      "default",
      "*",
    ]);
    expect(facts.symbols.map((symbol) => symbol.kind)).toEqual([
      "function",
      "interface",
      "type",
      "enum",
      "function",
    ]);
    expect(() =>
      parseSource({ languageId: "missing-language", source: "value" }),
    ).toThrow("Unsupported parser language");
  });

  test("uses content, language, grammar, and extractor versions for identity", () => {
    const request = {
      languageId: "typescript" as const,
      source: "export const value = 1;",
    };
    const left = parseSource(request);
    const right = parseSource(request);
    const grammarChanged = parseSource({
      ...request,
      grammarVersion: "fixture-grammar-v2",
    });
    const extractorChanged = parseSource({
      ...request,
      extractorVersion: "fixture-extractor-v2",
    });

    expect(left.syntaxFactsArtifactId).toBe(right.syntaxFactsArtifactId);
    expect(left.nodes).toEqual(right.nodes);
    expect(grammarChanged.syntaxFactsArtifactId).not.toBe(
      left.syntaxFactsArtifactId,
    );
    expect(extractorChanged.syntaxFactsArtifactId).not.toBe(
      left.syntaxFactsArtifactId,
    );
  });

  test("reports exact Unicode, CRLF, byte, character, and UTF-16 locations", () => {
    const source = 'const label = "🙂";\r\nfoo(café);';
    const facts = parseSource({ languageId: "typescript", source });
    const call = facts.calls[0];
    if (!call) throw new Error("Expected a call fact");
    const expectedStart = source.indexOf("foo");

    expect(call.range.start).toEqual({ column: 0, line: 1 });
    expect(call.range.startCoordinate.utf16Offset).toBe(expectedStart);
    expect(call.range.startByte).toBe(
      new TextEncoder().encode(source.slice(0, expectedStart)).byteLength,
    );
    expect(call.range.end.column).toBe(Array.from("foo(café)").length);
    expect(call.range.endCoordinate.utf16Column).toBe("foo(café)".length);
  });

  test("returns bounded partial facts and diagnostics for malformed source", () => {
    const facts = parseSource({
      languageId: "typescript",
      maxNodes: 2,
      source: "function broken(",
    });

    expect(facts.partial).toBe(true);
    expect(facts.nodes.length).toBeLessThanOrEqual(2);
    expect(facts.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "parse-error",
    );
    expect(facts.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "truncated",
    );
  });

  test("maps embedded ranges to host ranges and back losslessly", () => {
    const embedded = 'const emoji = "🙂";\r\nrun(emoji);';
    const host = ["before", embedded, "after"].join("\n");
    const hostStart = host.indexOf(embedded);
    const sourceMap = new EmbeddedSourceMap(host, embedded, [
      {
        embeddedEnd: embedded.length,
        embeddedStart: 0,
        hostEnd: hostStart + embedded.length,
        hostStart,
      },
    ]);
    const embeddedIndex = new SourceCoordinateIndex(embedded);
    const input = embeddedIndex.range(
      embedded.indexOf("run"),
      embedded.indexOf("run") + "run(emoji)".length,
    );
    const hostRange = sourceMap.embeddedToHost(input);
    if (!hostRange) throw new Error("Expected a mapped host range");

    expect(
      host.slice(
        hostRange.startCoordinate.utf16Offset,
        hostRange.endCoordinate.utf16Offset,
      ),
    ).toBe("run(emoji)");
    expect(sourceMap.hostToEmbedded(hostRange)).toEqual(input);

    const splitMap = new EmbeddedSourceMap("ab--cd", "abcd", [
      { embeddedEnd: 2, embeddedStart: 0, hostEnd: 2, hostStart: 0 },
      { embeddedEnd: 4, embeddedStart: 2, hostEnd: 6, hostStart: 4 },
    ]);
    expect(
      splitMap.embeddedToHost(new SourceCoordinateIndex("abcd").range(1, 3)),
    ).toBeNull();
  });

  test("rewrites all declared non-overlapping matches in memory", () => {
    const source = "foo(1); foo(2);";
    const matches = findStructuralMatches(source, "typescript", "foo($A)");
    const candidate = rewriteStructuralMatches(source, "typescript", [
      {
        expectedMatches: 2,
        pattern: "foo($A)",
        replacement: ["bar($A)", "baz($A)"],
      },
    ]);

    expect(matches).toHaveLength(2);
    expect(matches.map((match) => match.ordinal)).toEqual([0, 1]);
    expect(candidate.source).toBe("bar(1); baz(2);");
    expect(source).toBe("foo(1); foo(2);");
    expect(candidate.edits).toHaveLength(2);

    const multipleCapture = rewriteStructuralMatches(
      "foo(1, /* keep */ 2);",
      "typescript",
      [
        {
          expectedMatches: 1,
          pattern: "$F($$$ARGS)",
          replacement: "bar($$$ARGS)",
        },
      ],
    );
    expect(multipleCapture.source).toBe("bar(1, /* keep */ 2);");
  });

  test("rejects count mismatches and overlapping rewrite operations", () => {
    expect(() =>
      rewriteStructuralMatches("foo(1); foo(2);", "typescript", [
        { expectedMatches: 1, pattern: "foo($A)", replacement: "bar($A)" },
      ]),
    ).toThrow("expected 1 matches but found 2");

    expect(() =>
      rewriteStructuralMatches("foo(1);", "typescript", [
        { expectedMatches: 1, pattern: "foo($A)", replacement: "bar($A)" },
        {
          expectedMatches: 1,
          pattern: "$F($$$ARGS)",
          replacement: "baz($$$ARGS)",
        },
      ]),
    ).toThrow("overlap");
  });

  test("rejects capability claims without implementations", () => {
    const registry = new LanguageRegistry();
    const claim = registry.capabilities("typescript");
    expect(() =>
      registry.assertHonest("typescript", {
        ...claim,
        importResolution: {
          implementationFingerprint: "a".repeat(64),
          limitations: [],
          provider: "custom",
          status: "supported",
        },
      }),
    ).toThrow("has no registered implementation");

    expect(registry.capabilities("css").symbolExtraction.status).toBe(
      "unsupported",
    );
    expect(registry.capabilities("css").rewrite.status).toBe("supported");
  });

  test("parses and structurally matches JavaScript natively", () => {
    const source = "export function greet(name) { return console.log(name); }";
    const facts = parseSource({ languageId: "javascript", source });
    const matches = findStructuralMatches(
      source,
      "javascript",
      "console.log($A)",
    );

    expect(facts.symbols.map((symbol) => symbol.name)).toContain("greet");
    expect(facts.calls.map((call) => call.callee)).toContain("console.log");
    expect(matches.map((match) => match.text)).toEqual(["console.log(name)"]);
  });

  test("keeps structured parsers pluggable and their claims honest", async () => {
    const registry = new StructuredParserRegistry();
    registry.register({
      extensions: [".json"],
      format: "json",
      implementationFingerprint: "b".repeat(64),
      languageId: "fixture-json",
      parse: JSON.parse,
      preservesComments: false,
      structuralRead: (document, selector) =>
        (document as Record<string, unknown>)[selector],
    });

    expect(await registry.parse("fixture-json", '{"answer":42}')).toEqual({
      answer: 42,
    });
    const capabilities = registry.capabilities("fixture-json");
    expect(capabilities.parse.provider).toBe("structured-parser");
    expect(capabilities.structuralRead.status).toBe("supported");
    expect(capabilities.match.status).toBe("unsupported");
    expect(capabilities.rewrite.status).toBe("unsupported");
    expect(registry.list()).toEqual(["fixture-json"]);
    expect(() => registry.get("missing")).toThrow(
      "Unsupported structured parser language",
    );
    expect(() =>
      registry.register({
        extensions: [".bad"],
        format: "json",
        implementationFingerprint: "invalid",
        languageId: "invalid",
        parse: JSON.parse,
        preservesComments: false,
        structuralRead: () => null,
      }),
    ).toThrow("SHA-256 fingerprint");

    const richAdapter = {
      extensions: [".jsonc"],
      format: "jsonc" as const,
      implementationFingerprint: "c".repeat(64),
      languageId: "fixture-jsonc",
      match: () => [],
      parse: JSON.parse,
      preservesComments: true,
      rewrite: () => "{}",
      structuralRead: () => null,
    };
    registry.register(richAdapter);
    expect(registry.capabilities("fixture-jsonc").match.status).toBe(
      "supported",
    );
    expect(registry.capabilities("fixture-jsonc").rewrite.status).toBe(
      "supported",
    );
    expect(() => registry.register(richAdapter)).toThrow("already registered");
    expect(registry.list()).toEqual(["fixture-json", "fixture-jsonc"]);
  });

  test("uses one catalog for analysis and structural language support", () => {
    const registry = new LanguageRegistry(() => undefined);
    const catalogIds = LANGUAGE_CAPABILITY_CATALOG.map(
      (entry) => entry.languageId,
    );
    const registryIds = registry.list().map((grammar) => grammar.languageId);

    expect(registryIds).toEqual([...catalogIds].sort());
    expect(catalogIds).not.toContain("json");
    expect(catalogIds).not.toContain("jsonc");
    expect(Object.keys(PINNED_GRAMMAR_REGISTRATIONS).sort()).toEqual(
      catalogIds.slice(6).sort(),
    );
    expect(languageForExtension(".jsx")).toBe("jsx");
    expect(languageForExtension(".dart")).toBe("dart");
    expect(languageForExtension(".json")).toBe("json");
    expect(languageForExtension(".jsonc")).toBe("jsonc");

    const expectedVersions: Readonly<Record<string, string>> = {
      bash: "0.0.8",
      c: "0.0.6",
      cpp: "0.0.6",
      csharp: "0.0.6",
      dart: "0.0.7",
      elixir: "0.0.7",
      go: "0.0.6",
      java: "0.0.7",
      kotlin: "0.0.7",
      lua: "0.0.7",
      markdown: "0.0.6",
      php: "0.0.7",
      python: "0.0.6",
      ruby: "0.0.7",
      rust: "0.0.7",
      scala: "0.0.7",
      sql: "0.0.8",
      swift: "0.0.8",
      toml: "0.0.9",
      yaml: "0.0.6",
    };
    for (const entry of LANGUAGE_CAPABILITY_CATALOG) {
      expect(entry.structuralOperations).toEqual({
        match: true,
        parse: true,
        rewrite: true,
        structuralRead: true,
      });
      const expectedVersion = expectedVersions[entry.languageId];
      if (expectedVersion) {
        expect(entry.grammarVersion).toBe(
          `@ast-grep/lang-${entry.languageId}@${expectedVersion}`,
        );
      } else {
        expect(entry.grammarVersion).toStartWith("@ast-grep/napi@0.45.3:");
      }
    }

    expect(
      LANGUAGE_CAPABILITY_CATALOG.find(
        (entry) => entry.languageId === "typescript",
      )?.analysis.symbolExtraction,
    ).toBe(true);
    expect(
      LANGUAGE_CAPABILITY_CATALOG.find((entry) => entry.languageId === "toml")
        ?.analysis.symbolExtraction,
    ).toBe(false);
  });

  test("parses sources with pinned native grammar packages", () => {
    const samples: Readonly<Record<string, string>> = {
      bash: "echo ok",
      c: "int main(void) { return 0; }",
      cpp: "int main() { return 0; }",
      csharp: "class Service {}",
      dart: "void main() {}",
      elixir: "defmodule Service do\nend",
      go: "package main\nfunc main() {}",
      java: "class Service {}",
      kotlin: "class Service",
      lua: "local value = 1",
      markdown: "# Heading",
      php: "<?php function run() {}",
      python: "def run():\n    return 1",
      ruby: "def run\nend",
      rust: "fn main() {}",
      scala: "class Service",
      sql: "select 1;",
      swift: "func run() {}",
      toml: 'name = "fixture"',
      yaml: "name: fixture",
    };

    for (const [languageId, source] of Object.entries(samples)) {
      const facts = parseSource({ languageId, source });
      expect(facts.languageId).toBe(languageId);
      expect(facts.nodes.length).toBeGreaterThan(0);
      expect(facts.grammarFingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test("validates dynamic grammar assets by stable fingerprint", async () => {
    const nativeBindings = await Array.fromAsync(
      new Bun.Glob("node_modules/@ast-grep/napi-*/ast-grep-napi.*.node").scan({
        cwd: process.cwd(),
        onlyFiles: true,
      }),
    );
    const bindingPath = nativeBindings[0];
    if (!bindingPath)
      throw new Error("Expected an installed ast-grep native binding");
    const libraryPath = `${process.cwd()}/${bindingPath}`;
    const digest = new Bun.CryptoHasher("sha256");
    digest.update(await Bun.file(libraryPath).arrayBuffer());
    const sha256 = digest.digest("hex");

    await expect(
      validateGrammarAsset({ libraryPath, sha256 }),
    ).resolves.toBeUndefined();
    await expect(
      validateGrammarAsset({
        libraryPath: `${process.cwd()}/package.json`,
        sha256: "0".repeat(64),
      }),
    ).rejects.toThrow("native library filename");
    await expect(
      validateGrammarAsset({ libraryPath, sha256: "0".repeat(64) }),
    ).rejects.toThrow("fingerprint mismatch");

    const leftRegistry = new LanguageRegistry();
    const left = leftRegistry.get("typescript");
    const right = new LanguageRegistry().get("typescript");
    expect(left.grammarFingerprint).toBe(right.grammarFingerprint);
    expect(left.grammarVersion).toBe(right.grammarVersion);
    expect(leftRegistry.list().map((grammar) => grammar.languageId)).toContain(
      "typescript",
    );

    const implementation = {
      callResolution: false,
      embeddedLanguages: false,
      exportResolution: false,
      importResolution: false,
      inheritanceResolution: false,
      match: true,
      parse: true,
      rewrite: true,
      structuralRead: true,
      symbolExtraction: false,
    };
    const descriptor = {
      astGrepLanguage: "FixtureLanguage",
      dynamicAsset: { libraryPath, sha256 },
      extensions: [".fixture"],
      grammarVersion: "fixture-grammar-v1",
      languageId: "fixture-language",
    };
    const duplicateRegistry = new LanguageRegistry(() => undefined);
    await duplicateRegistry.addDynamic(descriptor, implementation);
    await expect(
      duplicateRegistry.addDynamic(descriptor, implementation),
    ).rejects.toThrow("already registered");

    const registrations: unknown[] = [];
    const dynamicRegistry = new LanguageRegistry((registration) => {
      registrations.push(registration);
    });
    await dynamicRegistry.addDynamic(
      {
        ...descriptor,
        dynamicAsset: {
          ...descriptor.dynamicAsset,
          expandoChar: "_",
          languageSymbol: "tree_sitter_fixture",
          metaVarChar: "$",
        },
      },
      implementation,
    );
    expect(dynamicRegistry.get("fixture-language").grammarFingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(
      dynamicRegistry.capabilities("fixture-language").rewrite.status,
    ).toBe("supported");
    // The installed .node file is the ast-grep runtime, not a tree-sitter grammar.
    // Native registration with the wrong symbol can abort before JavaScript catches it.
    // The injected registrar exercises the production manifest conversion safely.
    dynamicRegistry.registerDynamicGrammars();
    dynamicRegistry.registerDynamicGrammars();
    expect(registrations).toHaveLength(2);
    expect(Object.keys(registrations[0] as object).sort()).toEqual(
      Object.keys(PINNED_GRAMMAR_REGISTRATIONS).sort(),
    );
    expect(registrations[1]).toEqual({
      FixtureLanguage: {
        expandoChar: "_",
        extensions: [".fixture"],
        languageSymbol: "tree_sitter_fixture",
        libraryPath,
        metaVarChar: "$",
      },
    });
    const manifest = dynamicRegistry.dynamicManifest();
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.entries)).toBe(true);
    expect(Object.isFrozen(manifest.entries[0]?.descriptor.dynamicAsset)).toBe(
      true,
    );

    const initializationMessages: unknown[] = [];
    const workerFactory = (): Worker => {
      const fakeWorker = {
        onerror: null as ((event: ErrorEvent) => void) | null,
        onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
        postMessage(message: unknown): void {
          const cloned = structuredClone(message);
          if ((cloned as { type?: string }).type === "initialize") {
            initializationMessages.push(cloned);
            queueMicrotask(() => {
              fakeWorker.onmessage?.({
                data: { ok: true, type: "ready" },
              } as MessageEvent<unknown>);
            });
            return;
          }
          const parseMessage = cloned as {
            id: number;
            request: Parameters<typeof parseSource>[0];
          };
          queueMicrotask(() => {
            fakeWorker.onmessage?.({
              data: {
                facts: parseSource(parseMessage.request),
                id: parseMessage.id,
                ok: true,
                type: "result",
              },
            } as MessageEvent<unknown>);
          });
        },
        terminate(): void {},
      };
      return fakeWorker as unknown as Worker;
    };
    const mutableManifest = structuredClone(manifest);
    const pool = new ParserWorkerPool({
      dynamicGrammarManifest: mutableManifest,
      maxWorkers: 2,
      minWorkers: 1,
      workerFactory,
    });
    const mutableAsset = mutableManifest.entries[0]?.descriptor.dynamicAsset;
    if (!mutableAsset) throw new Error("Expected a dynamic manifest asset");
    mutableAsset.metaVarChar = "%";
    await Promise.all([
      pool.parse({ languageId: "typescript", source: "const first = 1;" }),
      pool.parse({ languageId: "typescript", source: "const second = 2;" }),
    ]);
    await pool.close({ drain: true });
    expect(initializationMessages).toHaveLength(2);
    for (const message of initializationMessages) {
      const initializedManifest = (
        message as { manifest: typeof mutableManifest }
      ).manifest;
      expect(
        initializedManifest.entries[0]?.descriptor.dynamicAsset?.metaVarChar,
      ).toBe("$");
    }

    const loadedRegistry = new LanguageRegistry(() => undefined);
    await loadedRegistry.loadDynamicManifest(manifest);
    expect(loadedRegistry.get("fixture-language").grammarFingerprint).toBe(
      dynamicRegistry.get("fixture-language").grammarFingerprint,
    );
    await expect(
      loadedRegistry.loadDynamicManifest({
        ...manifest,
        fingerprint: "0".repeat(64),
      }),
    ).rejects.toThrow("manifest fingerprint mismatch");
    await expect(
      loadedRegistry.loadDynamicManifest({
        ...manifest,
        schemaVersion: "unsupported" as typeof manifest.schemaVersion,
      }),
    ).rejects.toThrow("manifest version");

    const changedLoaderRegistry = new LanguageRegistry(() => undefined);
    await changedLoaderRegistry.addDynamic(
      {
        ...descriptor,
        dynamicAsset: { ...descriptor.dynamicAsset, metaVarChar: "%" },
      },
      implementation,
    );
    expect(
      changedLoaderRegistry.get("fixture-language").grammarFingerprint,
    ).not.toBe(dynamicRegistry.get("fixture-language").grammarFingerprint);

    await expect(
      new LanguageRegistry().addDynamic(
        { ...descriptor, languageId: "typescript" },
        implementation,
      ),
    ).rejects.toThrow("already registered");
    await expect(
      dynamicRegistry.addDynamic(descriptor, implementation),
    ).rejects.toThrow("before parsing");

    await expect(
      new LanguageRegistry().addDynamic(
        { ...descriptor, dynamicAsset: null, languageId: "missing-asset" },
        implementation,
      ),
    ).rejects.toThrow("require a native library asset");
    await expect(
      new LanguageRegistry().addDynamic(
        {
          ...descriptor,
          grammarFingerprint: "f".repeat(64),
          languageId: "wrong-fingerprint",
        },
        implementation,
      ),
    ).rejects.toThrow("does not match");

    const lockedRegistry = new LanguageRegistry();
    lockedRegistry.registerDynamicGrammars();
    await expect(
      lockedRegistry.addDynamic(descriptor, implementation),
    ).rejects.toThrow("before parsing");
  });
});

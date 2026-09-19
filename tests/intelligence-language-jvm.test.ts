import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { LanguageCapabilitySchema } from "../src/intelligence/contracts/language.ts";
import type {
  JvmGrammarAssetConfig,
  JvmLanguageId,
} from "../src/intelligence/languages/jvm/index.ts";
import {
  analyzeJvmLanguage,
  closeJvmLanguageWorker,
  createJvmGrammarManifest,
  drainJvmLanguageWorker,
  handleJvmWorkerError,
  interruptJvmLanguageWorker,
  JVM_WORKER_LIMITS,
  JvmWorkerError,
  jvmLanguageAdapter,
  jvmLanguageAdapters,
  jvmLanguageGroupManifest,
  jvmWorkerStats,
} from "../src/intelligence/languages/jvm/index.ts";
import { validateJvmWorkerRequest } from "../src/intelligence/languages/jvm/wasm-worker.ts";
import { validateJvmWorkerResponse } from "../src/intelligence/languages/jvm/worker-client.ts";

const root = join(
  import.meta.dir,
  "fixtures",
  "intelligence",
  "languages",
  "jvm",
);
const supported = [
  ["apex", "apex.cls"],
  ["java", "java.java"],
  ["kotlin", "kotlin.kt"],
  ["scala", "scala.scala"],
  ["groovy", "groovy.groovy"],
  ["csharp", "csharp.cs"],
] as const;

async function source(name: string) {
  return readFile(join(root, name), "utf8");
}
function range(value: { range: { startByte: number; endByte: number } }) {
  return [value.range.startByte, value.range.endByte];
}
function normalize(
  facts: Awaited<ReturnType<ReturnType<typeof jvmLanguageAdapter>["analyze"]>>,
) {
  return {
    calls: facts.calls.map((value) => ({
      callee: value.callee,
      range: range(value),
    })),
    diagnostics: facts.diagnostics.map((value) => ({
      code: value.code,
      range: range(value),
    })),
    exports: facts.exports.map((value) => ({
      exportedName: value.exportedName,
      localName: value.localName,
      range: range(value),
    })),
    implementations: facts.implementations.map((value) => ({
      range: range(value),
      targetName: value.targetName,
    })),
    imports: facts.imports.map((value) => ({
      importedName: value.importedName,
      localName: value.localName,
      range: range(value),
      source: value.source,
    })),
    inheritance: facts.inheritance.map((value) => ({
      range: range(value),
      targetName: value.targetName,
    })),
    partial: facts.partial,
    references: facts.references.map((value) => ({
      name: value.name,
      range: range(value),
      role: value.role,
    })),
    symbols: facts.symbols.map((value) => ({
      declarationRange: [
        value.declarationRange.startByte,
        value.declarationRange.endByte,
      ],
      kind: value.kind,
      name: value.name,
      range: range(value),
    })),
  };
}

afterAll(closeJvmLanguageWorker);

test("JVM ranges preserve byte, character, and UTF-16 coordinates", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = `//🙂${newline}class Café { void run(int value) { int local = target(value); } }`;
    const facts = await analyzeJvmLanguage({ languageId: "java", source });
    const symbol = facts.symbols.find(({ name }) => name === "Café");
    const owner = facts.symbols.find(({ name }) => name === "run");
    const call = facts.calls.find(({ callee }) => callee === "target");
    const binding = facts.references.find(
      ({ name, role }) => name === "local" && role === "write",
    );
    const reference = facts.references.find(
      ({ name, role }) => name === "target" && role === "read",
    );
    if (!symbol || !owner || !call || !binding || !reference) {
      throw new Error("Expected Unicode symbol, call, binding, and reference");
    }
    const range = symbol.declarationRange;
    const start = source.indexOf("Café");
    const end = start + "Café".length;
    const prefix = source.slice(0, start);

    expect(
      source.slice(
        range.startCoordinate.utf16Offset,
        range.endCoordinate.utf16Offset,
      ),
    ).toBe("Café");
    expect(range.startCoordinate.utf16Offset).toBe(start);
    expect(range.endCoordinate.utf16Offset).toBe(end);
    expect(range.startByte).toBe(new TextEncoder().encode(prefix).byteLength);
    expect(range.endByte).toBe(
      new TextEncoder().encode(source.slice(0, end)).byteLength,
    );
    expect(range.startCoordinate.characterOffset).toBe(
      Array.from(prefix).length,
    );
    expect(range.startCoordinate.line).toBe(1);
    expect(range.startCoordinate.utf16Column).toBe("class ".length);
    expect(range.startCoordinate.column).toBe("class ".length);
    expect(
      source.slice(
        call.range.startCoordinate.utf16Offset,
        call.range.endCoordinate.utf16Offset,
      ),
    ).toBe("target(value)");
    expect(
      source.slice(
        binding.range.startCoordinate.utf16Offset,
        binding.range.endCoordinate.utf16Offset,
      ),
    ).toBe("local");
    expect(
      source.slice(
        reference.range.startCoordinate.utf16Offset,
        reference.range.endCoordinate.utf16Offset,
      ),
    ).toBe("target");
    expect(call.enclosingSymbolId).toBe(owner.id);
    expect(binding.enclosingSymbolId).toBe(owner.id);
    expect(reference.enclosingSymbolId).toBe(owner.id);
    expect(owner.range.startCoordinate.utf16Offset).toBeLessThan(
      call.range.startCoordinate.utf16Offset,
    );
    expect(owner.range.endCoordinate.utf16Offset).toBeGreaterThan(
      call.range.endCoordinate.utf16Offset,
    );
  }
});

describe("JVM WASM language adapters", () => {
  test("publishes honest schema-valid availability and extraction claims", () => {
    expect(jvmLanguageGroupManifest.groupId).toBe("jvm");
    expect(jvmLanguageAdapters.map((value) => value.languageId)).toEqual([
      "apex",
      "csharp",
      "groovy",
      "java",
      "kotlin",
      "scala",
    ]);
    for (const adapter of jvmLanguageAdapters) {
      expect(LanguageCapabilitySchema.parse(adapter.capability)).toEqual(
        adapter.capability,
      );
      expect(adapter.available).toBe(true);
      expect(adapter.capability.parse.provider).toBe("tree-sitter");
      expect(adapter.capability.symbolExtraction.status).toBe("partial");
      expect(adapter.capability.callResolution.status).toBe("unsupported");
      expect(adapter.capability.match.status).toBe("unsupported");
      expect(adapter.capability.rewrite.status).toBe("unsupported");
    }
    expect(() => jvmLanguageAdapter("rust" as JvmLanguageId)).toThrow(
      "Unsupported JVM language",
    );
  });

  test("rejects malformed and contradictory worker protocol records", async () => {
    expect(
      validateJvmWorkerRequest({
        id: 1,
        languageId: "java",
        source: "class Valid {}",
        type: "start",
      }),
    ).toMatchObject({ id: 1, languageId: "java", type: "start" });
    expect(validateJvmWorkerRequest({ id: 2, type: "cancel" })).toEqual({
      id: 2,
      type: "cancel",
    });
    for (const invalid of [
      null,
      {},
      { id: 0, type: "cancel" },
      { extra: true, id: 1, type: "cancel" },
      { id: 1, type: "unknown" },
      { id: 1, languageId: "rust", source: "", type: "start" },
      { id: 1, languageId: "java", source: 1, type: "start" },
      { extra: true, id: 1, languageId: "java", source: "", type: "start" },
    ]) {
      expect(() => validateJvmWorkerRequest(invalid)).toThrow();
    }

    const source = "class Valid {}";
    const facts = await analyzeJvmLanguage({ languageId: "java", source });
    expect(
      validateJvmWorkerResponse(
        { facts, id: 7, ok: true, type: "result" },
        { id: 7, languageId: "java", source },
      ),
    ).toMatchObject({ id: 7, ok: true, type: "result" });
    for (const invalid of [
      { facts, id: 0, ok: true, type: "result" },
      { extra: true, facts, id: 7, ok: true, type: "result" },
      { error: "failure", facts, id: 7, ok: true, type: "result" },
      { error: "failure", extra: true, id: 7, ok: false, type: "result" },
      { facts: { ...facts, calls: [{}] }, id: 7, ok: true, type: "result" },
    ]) {
      expect(() => validateJvmWorkerResponse(invalid)).toThrow();
    }
    expect(() =>
      validateJvmWorkerResponse(
        { facts, id: 7, ok: true, type: "result" },
        { id: 8, languageId: "java", source },
      ),
    ).toThrow("id mismatch");
    expect(() =>
      validateJvmWorkerResponse(
        {
          facts: { ...facts, languageId: "kotlin" },
          id: 7,
          ok: true,
          type: "result",
        },
        { id: 7, languageId: "java", source },
      ),
    ).toThrow("requested language and source");
    expect(() =>
      validateJvmWorkerResponse(
        { facts, id: 7, ok: true, type: "result" },
        { id: 7, languageId: "java", source: "class Other {}" },
      ),
    ).toThrow("requested language and source");
    const tamperedRange = structuredClone(facts);
    const firstTamperedNode = tamperedRange.nodes[0];
    if (!firstTamperedNode) throw new Error("Expected syntax node");
    firstTamperedNode.range.endByte = 0;
    const tamperedFingerprint = { ...facts, parserFingerprint: "0".repeat(64) };
    const dangling = structuredClone(facts);
    dangling.nodes[0]?.childIds.push("f".repeat(64));
    const crossCollectionDuplicate = structuredClone(facts);
    const duplicateSymbol = crossCollectionDuplicate.symbols[0];
    const duplicateReference = crossCollectionDuplicate.references[0];
    if (!duplicateSymbol || !duplicateReference)
      throw new Error("Expected semantic facts");
    duplicateReference.id = duplicateSymbol.id;
    const duplicateChildren = structuredClone(facts);
    const parentWithChild = duplicateChildren.nodes.find(
      (node) => node.childIds.length > 0,
    );
    if (!parentWithChild) throw new Error("Expected parent node");
    const repeatedChild = parentWithChild.childIds[0];
    if (!repeatedChild) throw new Error("Expected child node");
    parentWithChild.childIds.push(repeatedChild);
    const danglingSymbol = structuredClone(facts);
    const pointerReference = danglingSymbol.references[0];
    if (!pointerReference) throw new Error("Expected reference");
    pointerReference.enclosingSymbolId = "f".repeat(64);
    for (const invalidFacts of [
      tamperedRange,
      tamperedFingerprint,
      dangling,
      crossCollectionDuplicate,
      duplicateChildren,
      danglingSymbol,
    ]) {
      expect(() =>
        validateJvmWorkerResponse(
          { facts: invalidFacts, id: 7, ok: true, type: "result" },
          { id: 7, languageId: "java", source },
        ),
      ).toThrow("internally inconsistent");
    }
  });

  test("matches the complete revision-pinned Graphify fact and range golden", async () => {
    const golden = JSON.parse(await source("graphify-golden.json"));
    expect(golden.provenance).toEqual({
      project: "graphify",
      revision: "3f82bf7f837a07fb0f7668fbdbd5662801906942",
      scope:
        "JVM fixture parity: complete extracted fact, reference, diagnostic, and byte-range sets",
    });
    for (const [languageId, file] of supported) {
      const facts = await jvmLanguageAdapter(languageId).analyze({
        languageId,
        source: await source(file),
      });
      expect(normalize(facts)).toEqual(golden.languages[languageId]);
      expect(facts.extractorFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(facts.grammarFingerprint).toMatch(/^[a-f0-9]{64}$/);
      if (languageId === "kotlin") {
        expect(facts.imports[0]?.localName).toBe("send");
      }
      if (languageId === "csharp") {
        expect(facts.imports[0]).toMatchObject({
          localName: "Events",
          source: "Demo.Events",
        });
      }
      if (languageId === "java") {
        expect(facts.exports.map((value) => value.exportedName)).toContain(
          "CaféService",
        );
      }
    }
  });

  test("verifies Graphify source, command, and fixture checksums", async () => {
    const provenance = JSON.parse(await source("graphify-provenance.json"));
    expect(provenance.source).toEqual({
      repository: "https://github.com/Graphify-Labs/graphify",
      revision: "3f82bf7f837a07fb0f7668fbdbd5662801906942",
    });
    expect(provenance.reproduction.command).toContain(
      provenance.source.revision,
    );
    for (const [file, checksum] of Object.entries(provenance.checksums)) {
      const bytes = await Bun.file(join(root, file)).arrayBuffer();
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      expect(digest).toBe(String(checksum));
    }
  });

  test("uses content-derived identities and preserves malformed AST diagnostics", async () => {
    const text = await source("malformed.java");
    const adapter = jvmLanguageAdapter("java");
    const first = await adapter.analyze({ languageId: "java", source: text });
    const repeat = await adapter.analyze({ languageId: "java", source: text });
    const changed = await adapter.analyze({
      languageId: "java",
      source: text.replace("Broken", "Changed"),
    });
    expect(first.partial).toBe(true);
    expect(first.diagnostics.length).toBeGreaterThan(0);
    expect(first.syntaxFactsArtifactId).toBe(repeat.syntaxFactsArtifactId);
    expect(first.syntaxFactsArtifactId).not.toBe(changed.syntaxFactsArtifactId);
  });

  test("parses Apex through the declared Java-compatible AST subset", async () => {
    const adapter = jvmLanguageAdapter("apex");
    const facts = await adapter.analyze({
      languageId: "apex",
      source: await source("apex.cls"),
    });
    expect(facts.languageId).toBe("apex");
    expect(facts.symbols.map((value) => value.name)).toContain("ApexService");
    expect(facts.calls.map((value) => value.callee)).toContain("emit");
    expect(adapter.capability.parse.status).toBe("partial");
    expect(adapter.capability.structuralRead.status).toBe("partial");
  });

  test("suppresses Apex facts from unsupported parser regions", async () => {
    const facts = await jvmLanguageAdapter("apex").analyze({
      languageId: "apex",
      source:
        "public class QueryService { public void run() { List<Account> rows = [SELECT Id FROM Account]; } }",
    });
    expect(facts.partial).toBe(true);
    expect(facts.diagnostics.length).toBeGreaterThan(0);
    for (const reference of facts.references) {
      expect(
        facts.diagnostics.some(
          ({ range }) =>
            range.startByte <= reference.range.startByte &&
            range.endByte >= reference.range.endByte,
        ),
      ).toBe(false);
    }
    expect(facts.references.map(({ name }) => name)).not.toContain("SELECT");
  });

  test("suppresses ghost calls, exports, and references from Apex SOQL errors", async () => {
    const facts = await analyzeJvmLanguage({
      languageId: "apex",
      source:
        "public class QueryService { public void run() { List<Account> rows = [SELECT ghost() FROM Account]; public void leaked() {} } }",
    });
    expect(facts.partial).toBe(true);
    expect(facts.diagnostics.length).toBeGreaterThan(0);
    expect(facts.calls.map(({ callee }) => callee)).not.toContain("ghost");
    expect(facts.exports.map(({ exportedName }) => exportedName)).not.toContain(
      "leaked",
    );
    expect(facts.references.map(({ name }) => name)).not.toContain("ghost");
    expect(facts.references.map(({ name }) => name)).not.toContain("leaked");
  });

  test("classifies JVM parameters, locals, and later reads", async () => {
    const cases: Record<JvmLanguageId, string> = {
      apex: "public class C { public void f(Integer p) { Integer local = p; } }",
      csharp: "class C { void F(int p) { int local = p; } }",
      groovy: "class C { void f(def p) { def local = p } }",
      java: "class C { void f(int p) { int local = p; } }",
      kotlin: "class C { fun f(p: Int) { val local = p } }",
      scala: "class C { def f(p: Int): Unit = { val local = p } }",
    };
    for (const [languageId, text] of Object.entries(cases) as [
      JvmLanguageId,
      string,
    ][]) {
      const facts = await analyzeJvmLanguage({ languageId, source: text });
      expect(
        facts.references
          .filter(({ name }) => name === "p" || name === "local")
          .map(({ name, role }) => [name, role]),
      ).toEqual([
        ["p", "write"],
        ["local", "write"],
        ["p", "read"],
      ]);
    }
  });

  test("extracts Scala grouped aliases with source provenance", async () => {
    const facts = await analyzeJvmLanguage({
      languageId: "scala",
      source: await source("scala.scala"),
    });
    expect(facts.imports).toHaveLength(1);
    expect(facts.imports[0]).toMatchObject({
      importedName: "emit",
      localName: "send",
      source: "demo.Events",
    });
  });

  test("applies visibility, shadowing, CRLF, Unicode, and comment/string boundaries", async () => {
    const text = await source("adversarial.java");
    const facts = await jvmLanguageAdapter("java").analyze({
      languageId: "java",
      source: text,
    });
    expect(facts.exports.map((value) => value.exportedName)).toEqual([
      "UnicodeΩ",
      "run",
    ]);
    expect(facts.symbols.map((value) => value.name)).not.toContain(
      "CommentGhost",
    );
    expect(facts.symbols.map((value) => value.name)).not.toContain(
      "StringGhost",
    );
    expect(facts.calls.map((value) => value.callee)).toEqual(["call"]);
    expect(
      facts.references.filter((value) => value.name === "shadow"),
    ).toHaveLength(2);
    const unicode = facts.symbols.find((value) => value.name === "UnicodeΩ");
    expect(unicode?.declarationRange.startCoordinate.line).toBe(3);
    expect(unicode?.declarationRange.endByte).toBeGreaterThan(
      unicode?.declarationRange.endCoordinate.utf16Offset ?? 0,
    );
    const csharp = await jvmLanguageAdapter("csharp").analyze({
      languageId: "csharp",
      source: [
        "internal class Hidden {}",
        "public class Visible { private void Secret() {} public void Run() {} }",
      ].join("\n"),
    });
    expect(csharp.exports.map((value) => value.exportedName)).toEqual([
      "Visible",
      "Run",
    ]);
  });

  test("enforces bounded cancellation, capacity, drain, and close lifecycle", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      jvmLanguageAdapter("java").analyze({
        languageId: "java",
        signal: controller.signal,
        source: "class Value {}",
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    const activeController = new AbortController();
    const activeRequest = jvmLanguageAdapter("java").analyze({
      languageId: "java",
      signal: activeController.signal,
      source: "class Active { void run() {} }".repeat(10_000),
    });
    activeController.abort();
    await expect(activeRequest).rejects.toMatchObject({ code: "aborted" });
    await expect(
      jvmLanguageAdapter("java").analyze({
        languageId: "java",
        source: "class Timeout {}",
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    await expect(
      jvmLanguageAdapter("java").analyze({
        languageId: "java",
        source: "x".repeat(JVM_WORKER_LIMITS.maxOutstandingBytes + 1),
      }),
    ).rejects.toBeInstanceOf(JvmWorkerError);
    await drainJvmLanguageWorker();
    expect(jvmWorkerStats()).toEqual({
      outstandingBytes: 0,
      pendingRequests: 0,
    });
    const closing = jvmLanguageAdapter("java").analyze({
      languageId: "java",
      source: "class Closing {}".repeat(10_000),
    });
    const closingObserved = closing.catch((error: unknown) => error);
    await closeJvmLanguageWorker();
    expect(await closingObserved).toMatchObject({ code: "closed" });
    const crashing = jvmLanguageAdapter("java").analyze({
      languageId: "java",
      source: "class Crashing {}".repeat(10_000),
    });
    const crashObserved = crashing.catch((error: unknown) => error);
    await interruptJvmLanguageWorker();
    expect(await crashObserved).toMatchObject({ code: "worker-exit" });
    handleJvmWorkerError(null as never, new Error("stale worker"));
    const restarted = jvmLanguageAdapter("java").analyze({
      languageId: "java",
      source: "public class Restarted {}".repeat(100),
    });
    const drained = drainJvmLanguageWorker();
    const facts = await restarted;
    await drained;
    expect(facts.symbols[0]?.name).toBe("Restarted");
  });

  test("keeps abort floods charged through termination and recovers", async () => {
    const controllers = Array.from({ length: 12 }, () => new AbortController());
    const outcomes = controllers.map((controller) =>
      analyzeJvmLanguage({
        languageId: "java",
        signal: controller.signal,
        source: "class Pending { void run() {} }\n".repeat(1_000),
      }).catch((error: unknown) => error),
    );
    for (const controller of controllers) controller.abort();
    expect(jvmWorkerStats().pendingRequests).toBeGreaterThan(0);
    const recovery = analyzeJvmLanguage({
      languageId: "java",
      source: "public class Recovered {}",
    });
    await Promise.all(outcomes);
    expect((await recovery).symbols.map(({ name }) => name)).toEqual([
      "Recovered",
    ]);
    await drainJvmLanguageWorker();
    expect(jvmWorkerStats()).toEqual({
      outstandingBytes: 0,
      pendingRequests: 0,
    });
  });

  test("creates deterministic grammar manifests for available bundled languages", () => {
    const assets = supported.map(
      ([languageId], index): JvmGrammarAssetConfig => ({
        astGrepLanguage: `tree-sitter-${languageId}`,
        grammarVersion: `1.0.${index}`,
        languageId,
        libraryPath: `/grammars/${languageId}.wasm`,
        sha256: index.toString(16).padStart(64, "0"),
      }),
    );
    const first = createJvmGrammarManifest(assets);
    expect(first).toEqual(createJvmGrammarManifest([...assets].reverse()));
    expect(first.entries).toHaveLength(6);
    expect(first.entries.every((entry) => !entry.implementation.match)).toBe(
      true,
    );
    expect(first.entries.every((entry) => !entry.implementation.rewrite)).toBe(
      true,
    );
    expect(() => createJvmGrammarManifest(assets.slice(1))).toThrow(
      "Missing dynamic grammars",
    );
    const duplicate = assets[0];
    if (!duplicate) throw new Error("Expected a grammar asset");
    expect(() => createJvmGrammarManifest([...assets, duplicate])).toThrow(
      "Duplicate dynamic grammar",
    );
    expect(() =>
      createJvmGrammarManifest(
        assets.map((value, index) =>
          index === 0 ? { ...value, sha256: "invalid" } : value,
        ),
      ),
    ).toThrow("Invalid grammar SHA-256");
  });
});

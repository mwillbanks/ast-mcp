import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LanguageCapabilitySchema } from "../src/intelligence/contracts/language.ts";
import type {
  SystemsGrammarAssetConfig,
  SystemsLanguageId,
} from "../src/intelligence/languages/systems/index.ts";
import {
  closeSystemsLanguageWorker,
  createSystemsGrammarManifest,
  drainSystemsLanguageWorker,
  handleSystemsWorkerError,
  handleSystemsWorkerExit,
  handleSystemsWorkerResponse,
  interruptSystemsLanguageWorker,
  rejectPendingSystemsRequests,
  restartSystemsLanguageWorker,
  SYSTEMS_WORKER_LIMITS,
  SystemsWorkerError,
  systemsLanguageAdapter,
  systemsLanguageAdapters,
  systemsLanguageGroupManifest,
  systemsWorkerStats,
  validateSystemsWorkerResponse,
} from "../src/intelligence/languages/systems/index.ts";
import { validateSystemsWorkerRequest } from "../src/intelligence/languages/systems/wasm-worker.ts";
import { sha256 } from "../src/intelligence/parser/index.ts";

const root = join(
  import.meta.dir,
  "fixtures",
  "intelligence",
  "languages",
  "systems",
);
const cases = [
  ["c", "c.c"],
  ["cpp", "cpp.cpp"],
  ["objc", "objc.m"],
  ["swift", "swift.swift"],
  ["rust", "rust.rs"],
  ["go", "go.go"],
  ["zig", "zig.zig"],
  ["dart", "dart.dart"],
] as const;
const fixture = (name: string) => readFile(join(root, name), "utf8");
const range = (value: { range: { startByte: number; endByte: number } }) => [
  value.range.startByte,
  value.range.endByte,
];
function normalize(
  facts: Awaited<
    ReturnType<ReturnType<typeof systemsLanguageAdapter>["analyze"]>
  >,
) {
  return {
    calls: facts.calls.map((v) => ({ callee: v.callee, range: range(v) })),
    diagnostics: facts.diagnostics.map((v) => ({
      code: v.code,
      range: range(v),
    })),
    exports: facts.exports.map((v) => ({
      exportedName: v.exportedName,
      range: range(v),
    })),
    implementations: facts.implementations.map((v) => ({
      range: range(v),
      targetName: v.targetName,
    })),
    imports: facts.imports.map((v) => ({
      localName: v.localName,
      range: range(v),
      source: v.source,
    })),
    inheritance: facts.inheritance.map((v) => ({
      range: range(v),
      targetName: v.targetName,
    })),
    partial: facts.partial,
    references: facts.references.map((v) => ({
      name: v.name,
      range: range(v),
      role: v.role,
    })),
    symbols: facts.symbols.map((v) => ({
      declarationRange: [
        v.declarationRange.startByte,
        v.declarationRange.endByte,
      ],
      kind: v.kind,
      name: v.name,
      range: range(v),
    })),
  };
}
afterAll(closeSystemsLanguageWorker);

test("systems ranges preserve byte, character, and UTF-16 coordinates", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = `//🙂${newline}fn café(value: i32) { let local = target(value); }`;
    const facts = await systemsLanguageAdapter("rust").analyze({
      languageId: "rust",
      source,
    });
    const symbol = facts.symbols.find(({ name }) => name === "café");
    const call = facts.calls.find(({ callee }) => callee === "target");
    const binding = facts.references.find(
      ({ name, role }) => name === "local" && role === "write",
    );
    const reference = facts.references.find(
      ({ name, role }) => name === "target" && role === "read",
    );
    if (!symbol || !call || !binding || !reference) {
      throw new Error("Expected Unicode symbol, call, binding, and reference");
    }
    const range = symbol.declarationRange;
    const start = source.indexOf("café");
    const end = start + "café".length;
    const prefix = source.slice(0, start);

    expect(
      source.slice(
        range.startCoordinate.utf16Offset,
        range.endCoordinate.utf16Offset,
      ),
    ).toBe("café");
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
    expect(range.startCoordinate.utf16Column).toBe("fn ".length);
    expect(range.startCoordinate.column).toBe("fn ".length);
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
    expect(call.enclosingSymbolId).toBe(symbol.id);
    expect(binding.enclosingSymbolId).toBe(symbol.id);
    expect(reference.enclosingSymbolId).toBe(symbol.id);
    expect(symbol.range.startCoordinate.utf16Offset).toBeLessThan(
      call.range.startCoordinate.utf16Offset,
    );
    expect(symbol.range.endCoordinate.utf16Offset).toBeGreaterThan(
      call.range.endCoordinate.utf16Offset,
    );
  }
});

describe("systems language WASM adapters", () => {
  test("rejects malformed worker protocol records", async () => {
    expect(
      validateSystemsWorkerRequest({
        id: 1,
        languageId: "c",
        source: "int x(){}",
        type: "start",
      }),
    ).toMatchObject({ id: 1, type: "start" });
    expect(validateSystemsWorkerRequest({ id: 1, type: "cancel" })).toEqual({
      id: 1,
      type: "cancel",
    });
    for (const value of [
      null,
      {},
      { id: 0, type: "cancel" },
      { extra: true, id: 1, type: "cancel" },
      { id: 1, languageId: "java", source: "", type: "start" },
    ]) {
      expect(() => validateSystemsWorkerRequest(value)).toThrow();
    }
    const source = "int x(){}";
    const facts = await systemsLanguageAdapter("c").analyze({
      languageId: "c",
      source,
    });
    expect(
      validateSystemsWorkerResponse(
        { facts, id: 7, ok: true, type: "result" },
        { id: 7, languageId: "c", source },
      ),
    ).toMatchObject({ id: 7, ok: true });
    const completeFacts = structuredClone(facts);
    const declaredSymbol = completeFacts.symbols[0];
    if (!declaredSymbol) throw new Error("Expected declared symbol");
    completeFacts.inheritance = [
      {
        id: sha256("systems-validator-inheritance"),
        range: declaredSymbol.range,
        sourceSymbolId: declaredSymbol.id,
        targetName: "Base",
      },
    ];
    completeFacts.implementations = [
      {
        id: sha256("systems-validator-implementation"),
        range: declaredSymbol.range,
        sourceSymbolId: declaredSymbol.id,
        targetName: "Contract",
      },
    ];
    completeFacts.diagnostics = [
      {
        code: "parse-error",
        message: "synthetic validator diagnostic",
        range: declaredSymbol.range,
        severity: "error",
      },
    ];
    completeFacts.syntaxFactsArtifactId = sha256(
      JSON.stringify([
        completeFacts.sourceDigest,
        completeFacts.extractorFingerprint,
        completeFacts.symbols.map((item) => item.id),
        completeFacts.imports.map((item) => item.id),
        completeFacts.calls.map((item) => item.id),
        completeFacts.inheritance.map((item) => item.id),
        completeFacts.implementations.map((item) => item.id),
        completeFacts.exports.map((item) => item.id),
      ]),
    );
    expect(
      validateSystemsWorkerResponse(
        { facts: completeFacts, id: 7, ok: true, type: "result" },
        { id: 7, languageId: "c", source },
      ),
    ).toMatchObject({ id: 7, ok: true });
    expect(() =>
      validateSystemsWorkerResponse({
        extra: true,
        facts,
        id: 7,
        ok: true,
        type: "result",
      }),
    ).toThrow();
    expect(
      validateSystemsWorkerResponse({
        error: "parse failed",
        id: 8,
        ok: false,
        type: "result",
      }),
    ).toEqual({ error: "parse failed", id: 8, ok: false, type: "result" });
    expect(() =>
      validateSystemsWorkerResponse({
        error: "x",
        facts,
        id: 7,
        ok: true,
        type: "result",
      }),
    ).toThrow();
    expect(() =>
      validateSystemsWorkerResponse(
        { facts, id: 7, ok: true, type: "result" },
        { id: 8, languageId: "c", source },
      ),
    ).toThrow("id");
    expect(() =>
      validateSystemsWorkerResponse(
        { facts, id: 7, ok: true, type: "result" },
        { id: 7, languageId: "rust", source },
      ),
    ).toThrow("language");
    expect(() =>
      validateSystemsWorkerResponse(
        { facts, id: 7, ok: true, type: "result" },
        { id: 7, languageId: "c", source: "different" },
      ),
    ).toThrow("language and source");
    const tamperedRange = structuredClone(facts);
    const firstNode = tamperedRange.nodes[0];
    if (!firstNode) throw new Error("Expected node");
    firstNode.range.endByte = 0;
    const duplicateId = structuredClone(facts);
    const firstSymbol = duplicateId.symbols[0];
    const firstReference = duplicateId.references[0];
    if (!firstSymbol || !firstReference)
      throw new Error("Expected semantic facts");
    firstReference.id = firstSymbol.id;
    const duplicateChild = structuredClone(facts);
    const parent = duplicateChild.nodes.find(
      (node) => node.childIds.length > 0,
    );
    const child = parent?.childIds[0];
    if (!parent || !child) throw new Error("Expected parent and child");
    parent.childIds.push(child);
    const danglingSymbol = structuredClone(facts);
    const reference = danglingSymbol.references[0];
    if (!reference) throw new Error("Expected reference");
    reference.enclosingSymbolId = "f".repeat(64);
    const badFingerprint = { ...facts, grammarFingerprint: "0".repeat(64) };
    for (const invalidFacts of [
      tamperedRange,
      duplicateId,
      duplicateChild,
      danglingSymbol,
      badFingerprint,
    ]) {
      expect(() =>
        validateSystemsWorkerResponse(
          { facts: invalidFacts, id: 7, ok: true, type: "result" },
          { id: 7, languageId: "c", source },
        ),
      ).toThrow("internally inconsistent");
    }
    handleSystemsWorkerResponse(null as never, {
      error: "stale",
      id: 999,
      ok: false,
      type: "result",
    });
    handleSystemsWorkerExit(null as never, 1);
  });

  test("preserves valid Go siblings while excluding malformed ghost facts", async () => {
    const source = "package p\nfunc Real() {}\nfunc Broken() { ghost(";
    const facts = await systemsLanguageAdapter("go").analyze({
      languageId: "go",
      source,
    });
    expect(facts.partial).toBe(true);
    expect(facts.symbols.map((item) => item.name)).toContain("Real");
    expect(facts.exports.map((item) => item.exportedName)).toContain("Real");
    expect(
      facts.references.filter((item) => item.name === "Real"),
    ).toHaveLength(1);
    expect(facts.symbols.some((item) => item.name.includes("ghost"))).toBe(
      false,
    );
    expect(
      facts.exports.some((item) => item.exportedName.includes("ghost")),
    ).toBe(false);
    expect(facts.calls.some((item) => item.callee.includes("ghost"))).toBe(
      false,
    );
    expect(facts.references.some((item) => item.name.includes("ghost"))).toBe(
      false,
    );
  });

  test("classifies parameter and local bindings for every systems language", async () => {
    const samples: Record<SystemsLanguageId, string> = {
      c: "int f(int p){ int x=p; return x; }",
      cpp: "int f(int p){ int x=p; return x; }",
      dart: "int f(int p) { int x=p; return x; }",
      go: "package p\nfunc f(p int) int { x := p; return x }",
      objc: "int f(int p){ int x=p; return x; }",
      rust: "fn f(p:i32)->i32 { let x=p; x }",
      swift: "func f(p: Int) -> Int { let x=p; return x }",
      zig: "fn f(p: i32) i32 { const x = p; return x; }",
    };
    for (const [languageId, source] of Object.entries(samples) as [
      SystemsLanguageId,
      string,
    ][]) {
      const facts = await systemsLanguageAdapter(languageId).analyze({
        languageId,
        source,
      });
      for (const name of ["p", "x"]) {
        const roles = facts.references
          .filter((item) => item.name === name)
          .map((item) => item.role);
        expect(roles, `${languageId} ${name}`).toContain("write");
        expect(roles, `${languageId} ${name}`).toContain("read");
      }
    }
  });

  test("excludes every semantic category from malformed ranges", async () => {
    for (const [languageId, file] of cases) {
      const prefix =
        languageId === "swift"
          ? "func"
          : languageId === "rust" || languageId === "zig"
            ? "fn"
            : languageId === "go"
              ? "func"
              : languageId === "dart"
                ? "void"
                : "int";
      const source = `${await fixture(file)}\n${prefix} ghost( { @@@`;
      const facts = await systemsLanguageAdapter(languageId).analyze({
        languageId,
        source,
      });
      expect(facts.diagnostics.length, languageId).toBeGreaterThan(0);
      const semantic = [
        ...facts.symbols,
        ...facts.imports,
        ...facts.exports,
        ...facts.calls,
        ...facts.inheritance,
        ...facts.implementations,
        ...facts.references,
      ];
      for (const item of semantic) {
        expect(
          facts.diagnostics.some(
            (diagnostic) =>
              diagnostic.range.startByte <= item.range.startByte &&
              diagnostic.range.endByte >= item.range.endByte,
          ),
          `${languageId} leaked ${"name" in item ? item.name : "fact"}`,
        ).toBe(false);
      }
    }
  });

  test("publishes honest deterministic capabilities", () => {
    expect(systemsLanguageGroupManifest.groupId).toBe("systems");
    expect(systemsLanguageAdapters).toHaveLength(8);
    for (const adapter of systemsLanguageAdapters) {
      expect(LanguageCapabilitySchema.parse(adapter.capability)).toEqual(
        adapter.capability,
      );
      expect(adapter.capability.parse.provider).toBe("tree-sitter");
      expect(adapter.capability.callResolution.status).toBe("unsupported");
      expect(adapter.capability.match.status).toBe("unsupported");
      expect(adapter.capability.rewrite.status).toBe("unsupported");
    }
    expect(() => systemsLanguageAdapter("java" as SystemsLanguageId)).toThrow(
      "Unsupported systems language",
    );
  });

  test("matches complete revision-pinned Graphify facts and exact ranges", async () => {
    const golden = JSON.parse(await fixture("graphify-golden.json"));
    expect(golden.provenance).toEqual({
      repository: "https://github.com/Graphify-Labs/graphify",
      revision: "3f82bf7f837a07fb0f7668fbdbd5662801906942",
    });
    for (const [languageId, file] of cases) {
      const source = await fixture(file);
      const facts = await systemsLanguageAdapter(languageId).analyze({
        languageId,
        source,
      });
      expect(normalize(facts)).toEqual(golden.languages[languageId]);
      expect(facts.syntaxFactsArtifactId).toMatch(/^[a-f0-9]{64}$/);
      for (const item of [
        ...facts.symbols,
        ...facts.imports,
        ...facts.calls,
        ...facts.references,
      ]) {
        const offset = item.range.startCoordinate.utf16Offset;
        expect(item.range.startByte).toBe(
          new TextEncoder().encode(source.slice(0, offset)).byteLength,
        );
      }
    }
  });

  test("verifies pinned provenance command and fixture checksums", async () => {
    const provenance = JSON.parse(await fixture("graphify-provenance.json"));
    expect(provenance.source.revision).toBe(
      "3f82bf7f837a07fb0f7668fbdbd5662801906942",
    );
    expect(provenance.reproduction.command).toContain(
      provenance.source.revision,
    );
    for (const [file, expected] of Object.entries(provenance.checksums)) {
      const bytes = await Bun.file(join(root, file)).arrayBuffer();
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      expect(digest).toBe(String(expected));
    }
  });

  test("preserves malformed diagnostics and ignores comment and string pseudo-code", async () => {
    const malformed = await systemsLanguageAdapter("c").analyze({
      languageId: "c",
      source: await fixture("malformed.c"),
    });
    expect(malformed.partial).toBe(true);
    expect(malformed.diagnostics.length).toBeGreaterThan(0);
    const clean = await systemsLanguageAdapter("c").analyze({
      languageId: "c",
      source:
        '// int ghost() {}\r\nconst char *s = "int phantom() {}";\r\nint real() {}',
    });
    expect(clean.symbols.map((v) => v.name)).toEqual(["real"]);
  });

  test("enforces abort, timeout, capacity, interruption, close, drain, and restart", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      systemsLanguageAdapter("c").analyze({
        languageId: "c",
        signal: aborted.signal,
        source: "int x(){}",
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    const activeController = new AbortController();
    const active = systemsLanguageAdapter("cpp").analyze({
      languageId: "cpp",
      signal: activeController.signal,
      source: "int active(){}".repeat(10_000),
    });
    activeController.abort();
    const queuedRecovery = systemsLanguageAdapter("c").analyze({
      languageId: "c",
      source: "int recovered(){}",
    });
    await expect(active).rejects.toMatchObject({ code: "aborted" });
    expect((await queuedRecovery).symbols.map((value) => value.name)).toContain(
      "recovered",
    );
    handleSystemsWorkerError(null as never, new Error("stale worker"));
    await expect(
      systemsLanguageAdapter("c").analyze({
        languageId: "c",
        source: "int timeout(){}".repeat(100_000),
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    await expect(
      systemsLanguageAdapter("c").analyze({
        languageId: "c",
        source: "x".repeat(SYSTEMS_WORKER_LIMITS.maxOutstandingBytes + 1),
      }),
    ).rejects.toBeInstanceOf(SystemsWorkerError);
    const closing = systemsLanguageAdapter("c").analyze({
      languageId: "c",
      source: "int closing(){}".repeat(10_000),
    });
    const closed = closing.catch((error: unknown) => error);
    await closeSystemsLanguageWorker();
    expect(await closed).toMatchObject({ code: "closed" });
    const crashing = systemsLanguageAdapter("rust").analyze({
      languageId: "rust",
      source: "fn crash(){}".repeat(10_000),
    });
    const crashed = crashing.catch((error: unknown) => error);
    await Bun.sleep(0);
    await interruptSystemsLanguageWorker();
    expect(await crashed).toMatchObject({ code: "worker-exit" });
    const restarted = systemsLanguageAdapter("go").analyze({
      languageId: "go",
      source: "package p\nfunc Restarted(){}",
    });
    const drained = drainSystemsLanguageWorker();
    expect((await restarted).symbols.map((v) => v.name)).toContain("Restarted");
    await drained;
    expect(systemsWorkerStats()).toEqual({
      outstandingBytes: 0,
      pendingRequests: 0,
    });
    await restartSystemsLanguageWorker();
    await interruptSystemsLanguageWorker();
    const manuallyRejected = systemsLanguageAdapter("c").analyze({
      languageId: "c",
      source: "int manual_reject(){}".repeat(10_000),
    });
    rejectPendingSystemsRequests("manual rejection");
    await expect(manuallyRejected).rejects.toThrow("manual rejection");
    const recoveredAfterIdleInterrupt = await systemsLanguageAdapter(
      "c",
    ).analyze({
      languageId: "c",
      source: "int idle_recovery(){}",
    });
    expect(
      recoveredAfterIdleInterrupt.symbols.map((value) => value.name),
    ).toContain("idle_recovery");
  });

  test("creates immutable-order manifests with extraction-only implementations", () => {
    const assets = cases.map(
      ([languageId], index): SystemsGrammarAssetConfig => ({
        astGrepLanguage: `tree-sitter-${languageId}`,
        grammarVersion: `1.0.${index}`,
        languageId,
        libraryPath: `/grammars/${languageId}.wasm`,
        sha256: index.toString(16).padStart(64, "0"),
      }),
    );
    const first = createSystemsGrammarManifest(assets);
    expect(first).toEqual(createSystemsGrammarManifest([...assets].reverse()));
    expect(first.entries).toHaveLength(8);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
    expect(Object.isFrozen(first.entries[0]?.descriptor.dynamicAsset)).toBe(
      true,
    );
    const frozenAsset = first.entries[0]?.descriptor.dynamicAsset;
    if (!frozenAsset) throw new Error("Expected frozen asset");
    expect(() =>
      Object.assign(frozenAsset, { libraryPath: "/mutated" }),
    ).toThrow();
    expect(
      first.entries.every(
        (entry) => !entry.implementation.match && !entry.implementation.rewrite,
      ),
    ).toBe(true);
    expect(() => createSystemsGrammarManifest(assets.slice(1))).toThrow(
      "Missing dynamic grammars",
    );
    const duplicate = assets[0];
    if (!duplicate) throw new Error("Expected asset");
    expect(() => createSystemsGrammarManifest([...assets, duplicate])).toThrow(
      "Duplicate dynamic grammar",
    );
  });
});

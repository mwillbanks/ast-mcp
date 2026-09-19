import { afterAll, describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

import {
  analyzeDynamicLanguage,
  closeDynamicLanguageWorker,
  createDynamicGrammarManifest,
  DYNAMIC_WORKER_LIMITS,
  type DynamicLanguageId,
  DynamicLanguageUnavailableError,
  drainDynamicLanguageWorker,
  dynamicLanguageAdapter,
  dynamicLanguageGroupManifest,
  dynamicWorkerStats,
  GRAPHIFY_DYNAMIC_BASELINE_REVISION,
  isDynamicSyntaxFacts,
  isDynamicWorkerRequest,
  isDynamicWorkerResult,
  rejectPendingDynamicRequests,
  restartDynamicLanguageWorker,
  terminateDynamicLanguageWorker,
} from "../src/intelligence/languages/dynamic/index.ts";

const fixtures: Record<DynamicLanguageId, string> = {
  elixir: "elixir.ex",
  julia: "julia.jl",
  lua: "lua.lua",
  luau: "luau.luau",
  php: "php.php",
  python: "python.py",
  r: "r.r",
  ruby: "ruby.rb",
};

// Records are pinned to Graphify revision 3f82bf7f837a07fb0f7668fbdbd5662801906942.
const golden = (await Bun.file(
  new URL(
    "./fixtures/intelligence/languages/dynamic/graphify-golden.json",
    import.meta.url,
  ),
).json()) as {
  languages: Record<DynamicLanguageId, unknown>;
  provenance: { revision: string };
  unsupported: Record<string, unknown>;
};

async function fixture(languageId: DynamicLanguageId): Promise<string> {
  return Bun.file(
    new URL(
      `./fixtures/intelligence/languages/dynamic/${fixtures[languageId]}`,
      import.meta.url,
    ),
  ).text();
}

function normalizedFacts(
  facts: Awaited<ReturnType<typeof analyzeDynamicLanguage>>,
): unknown {
  const range = (value: { startByte: number; endByte: number }) => [
    value.startByte,
    value.endByte,
  ];
  return {
    calls: facts.calls.map((item) => [item.callee, ...range(item.range)]),
    diagnostics: facts.diagnostics.map((item) => [
      item.code,
      item.severity,
      ...range(item.range),
    ]),
    exports: facts.exports.map((item) => [
      item.exportedName,
      item.localName,
      item.source,
      item.typeOnly,
      ...range(item.range),
    ]),
    imports: facts.imports.map((item) => [
      item.source,
      item.importedName,
      item.localName,
      item.typeOnly,
      ...range(item.range),
    ]),
    inheritance: facts.inheritance.map((item) => [
      item.targetName,
      ...range(item.range),
    ]),
    partial: facts.partial,
    references: facts.references.map((item) => [
      item.name,
      item.role,
      ...range(item.range),
    ]),
    symbols: facts.symbols.map((item) => [
      item.name,
      item.kind,
      item.exported,
      ...range(item.declarationRange),
      ...range(item.range),
    ]),
  };
}

afterAll(closeDynamicLanguageWorker);

test("dynamic ranges preserve byte, character, and UTF-16 coordinates", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = `#🙂${newline}def café(value):${newline}    local = target(value)${newline}    return local`;
    const facts = await analyzeDynamicLanguage({
      languageId: "python",
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
    expect(range.startCoordinate.utf16Column).toBe(
      "def café(value):".indexOf("café"),
    );
    expect(range.startCoordinate.column).toBe(
      Array.from(
        "def café(value):".slice(0, "def café(value):".indexOf("café")),
      ).length,
    );
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

test("strictly validates worker protocol and complete fact identity", async () => {
  const source = await fixture("python");
  const facts = await analyzeDynamicLanguage({ languageId: "python", source });
  const expected = {
    languageId: "python" as const,
    sourceDigest: facts.sourceDigest,
  };
  const success = { facts, id: 1, ok: true as const, type: "result" as const };
  const failure = {
    error: "failure",
    id: 1,
    ok: false as const,
    type: "result" as const,
  };

  expect(
    isDynamicWorkerRequest({
      id: 1,
      languageId: "python",
      source,
      type: "start",
    }),
  ).toBe(true);
  expect(isDynamicWorkerRequest({ id: 1, type: "cancel" })).toBe(true);
  expect(isDynamicWorkerResult(success, expected)).toBe(true);
  expect(isDynamicWorkerResult(failure, expected)).toBe(true);
  expect(isDynamicSyntaxFacts(facts, expected)).toBe(true);

  const invalidRequests = [
    { extra: true, id: 1, languageId: "python", source, type: "start" },
    { id: 1, source, type: "cancel" },
    { id: 1, languageId: "python", type: "start" },
    { id: 1, languageId: "unknown", source, type: "start" },
    { id: 1, type: "unknown" },
    { id: 0, type: "cancel" },
    { id: -1, type: "cancel" },
    { id: Number.MAX_SAFE_INTEGER + 1, type: "cancel" },
  ];
  for (const request of invalidRequests)
    expect(isDynamicWorkerRequest(request)).toBe(false);

  expect(isDynamicWorkerResult({ ...success, extra: true }, expected)).toBe(
    false,
  );
  expect(isDynamicWorkerResult({ ...success, facts: {} }, expected)).toBe(
    false,
  );
  expect(
    isDynamicWorkerResult(success, { ...expected, languageId: "ruby" }),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(success, {
      ...expected,
      sourceDigest: "0".repeat(64),
    }),
  ).toBe(false);
  expect(
    isDynamicWorkerResult({ ...success, error: "contradiction" }, expected),
  ).toBe(false);
  expect(isDynamicWorkerResult({ ...failure, facts }, expected)).toBe(false);
  expect(isDynamicWorkerResult({ ...failure, error: "" }, expected)).toBe(
    false,
  );
  expect(isDynamicWorkerResult({ ...failure, id: 0 }, expected)).toBe(false);
  expect(
    isDynamicWorkerResult(
      { ...failure, id: Number.MAX_SAFE_INTEGER + 1 },
      expected,
    ),
  ).toBe(false);

  const mutate = (change: (copy: typeof facts) => void) => {
    const copy = structuredClone(facts);
    change(copy);
    return { ...success, facts: copy };
  };
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        copy.nodes = [];
      }),
      expected,
    ),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        (copy.nodes[0]?.range as unknown as { startByte: string }).startByte =
          "0";
      }),
      expected,
    ),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        const nested = copy.nodes.find(
          ({ range }) => range.startCoordinate.utf16Offset > 0,
        );
        if (!nested) throw new Error("Expected a nested UTF-16 range");
        nested.range.endCoordinate.utf16Offset =
          nested.range.startCoordinate.utf16Offset - 1;
      }),
      expected,
    ),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        const nested = copy.nodes.find(
          ({ range }) => range.startCoordinate.characterOffset > 0,
        );
        if (!nested) throw new Error("Expected a nested character range");
        nested.range.endCoordinate.characterOffset =
          nested.range.startCoordinate.characterOffset - 1;
      }),
      expected,
    ),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        const first = copy.nodes.at(0);
        if (!first) throw new Error("Expected a syntax node");
        first.range.start.column += 1;
      }),
      expected,
    ),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        const first = copy.nodes.at(0);
        if (!first) throw new Error("Expected a syntax node");
        copy.nodes.push(structuredClone(first));
      }),
      expected,
    ),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        const first = copy.references.at(0);
        if (!first) throw new Error("Expected a syntax reference");
        copy.references.push(structuredClone(first));
      }),
      expected,
    ),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        copy.languageId = "ruby";
      }),
      expected,
    ),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        copy.sourceDigest = "0".repeat(64);
      }),
      expected,
    ),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        copy.sourceArtifactId = "0".repeat(64);
      }),
      expected,
    ),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        copy.syntaxFactsArtifactId = "0".repeat(64);
      }),
      expected,
    ),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        copy.extractorFingerprint = "0".repeat(64);
      }),
      expected,
    ),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        copy.grammarFingerprint = "0".repeat(64);
      }),
      expected,
    ),
  ).toBe(false);
  expect(
    isDynamicWorkerResult(
      mutate((copy) => {
        copy.parserFingerprint = "0".repeat(64);
      }),
      expected,
    ),
  ).toBe(false);
});

describe.serial("dynamic language WASM adapters", () => {
  test("pins the Graphify comparison revision and unsupported outputs", () => {
    expect(GRAPHIFY_DYNAMIC_BASELINE_REVISION).toBe(
      "3f82bf7f837a07fb0f7668fbdbd5662801906942",
    );
    expect(golden.provenance.revision).toBe(GRAPHIFY_DYNAMIC_BASELINE_REVISION);
    expect(golden.unsupported).toEqual({
      callResolution: true,
      exportResolution: true,
      importResolution: true,
      inheritanceResolution: true,
      luauParse: "partial",
      match: true,
      rewrite: true,
    });
  });

  test("advertises only implemented capabilities", () => {
    expect(dynamicLanguageGroupManifest.adapters).toHaveLength(8);
    for (const adapter of dynamicLanguageGroupManifest.adapters) {
      expect(adapter.available).toBeTrue();
      expect(adapter.capability.match.status).toBe("unsupported");
      expect(adapter.capability.rewrite.status).toBe("unsupported");
      expect(adapter.capability.callResolution.status).toBe("unsupported");
      expect(adapter.capability.importResolution.status).toBe("unsupported");
      expect(adapter.capability.exportResolution.status).toBe("unsupported");
      expect(adapter.capability.inheritanceResolution.status).toBe(
        "unsupported",
      );
    }
    const luau = dynamicLanguageAdapter("luau").capability;
    expect(luau.parse.status).toBe("partial");
    expect(luau.structuralRead.status).toBe("partial");
    expect(luau.structuralRead.limitations.join(" ")).toContain(
      "Lua-compatible syntax only",
    );
  });

  for (const languageId of Object.keys(fixtures) as DynamicLanguageId[]) {
    test(`extracts the exact Graphify baseline set for ${languageId} through the worker`, async () => {
      const source = await fixture(languageId);
      const first = await dynamicLanguageAdapter(languageId).analyze({
        languageId,
        source,
      });
      const second = await analyzeDynamicLanguage({ languageId, source });
      expect(normalizedFacts(first)).toEqual(golden.languages[languageId]);
      expect(first.syntaxFactsArtifactId).toBe(second.syntaxFactsArtifactId);
      expect(first.nodes.length).toBeGreaterThan(0);
      expect(first.references.length).toBeGreaterThan(0);
      for (const item of [
        ...first.nodes,
        ...first.symbols,
        ...first.imports,
        ...first.calls,
        ...first.references,
      ]) {
        expect(item.range.endByte).toBeGreaterThanOrEqual(item.range.startByte);
        expect(item.range.endCoordinate.utf16Offset).toBeGreaterThanOrEqual(
          item.range.startCoordinate.utf16Offset,
        );
      }
    });
  }

  test("matches revision-provenanced Python reference records and ranges", async () => {
    const facts = await analyzeDynamicLanguage({
      languageId: "python",
      source: await fixture("python"),
    });
    expect(
      facts.references.map(({ name, range, role }) => ({
        endByte: range.endByte,
        name,
        role,
        startByte: range.startByte,
      })),
    ).toEqual([
      { endByte: 12, name: "pathlib", role: "read", startByte: 5 },
      { endByte: 24, name: "Path", role: "read", startByte: 20 },
      { endByte: 36, name: "FilePath", role: "write", startByte: 28 },
      { endByte: 48, name: "json", role: "write", startByte: 44 },
      { endByte: 62, name: "Service", role: "write", startByte: 55 },
      { endByte: 74, name: "BaseService", role: "read", startByte: 63 },
      { endByte: 83, name: "Audited", role: "read", startByte: 76 },
      { endByte: 97, name: "run", role: "write", startByte: 94 },
      { endByte: 102, name: "self", role: "write", startByte: 98 },
      { endByte: 128, name: "FilePath", role: "read", startByte: 120 },
    ]);
  });

  test("classifies parameters, destructuring, locals, and reads per language", async () => {
    const cases: Record<DynamicLanguageId, string> = {
      elixir:
        "defmodule M do\n def f(pair) do\n  {a, b} = pair\n  a\n end\nend",
      julia: "function f(pair)\n (a, b) = pair\n a\nend",
      lua: "local function f(pair)\n local a, b = pair\n return a\nend",
      luau: "local function f(pair)\n local a, b = pair\n return a\nend",
      php: "<?php function f($pair) { [$a, $b] = $pair; return $a; }",
      python: "def f(pair):\n a, b = pair\n return a",
      r: "f <- function(pair) { c(a, b) <- pair; a }",
      ruby: "def f(pair)\n a, b = pair\n a\nend",
    };
    for (const [languageId, source] of Object.entries(cases) as [
      DynamicLanguageId,
      string,
    ][]) {
      const facts = await analyzeDynamicLanguage({ languageId, source });
      const roles = facts.references.map(({ name, role }) => [name, role]);
      const parameter = languageId === "php" ? "$pair" : "pair";
      const first = languageId === "php" ? "$a" : "a";
      const second = languageId === "php" ? "$b" : "b";
      expect(roles).toContainEqual([parameter, "write"]);
      expect(roles).toContainEqual([first, "write"]);
      expect(roles).toContainEqual([second, "write"]);
      expect(roles).toContainEqual([parameter, "read"]);
      expect(roles).toContainEqual([first, "read"]);
    }
  });

  test("couples Julia imported aliases to source-bearing reexports", async () => {
    const facts = await analyzeDynamicLanguage({
      languageId: "julia",
      source: "using External: PublicName\nexport PublicName\n",
    });
    expect(facts.imports).toHaveLength(1);
    expect(facts.imports[0]).toMatchObject({
      importedName: "PublicName",
      localName: "PublicName",
      source: "External",
    });
    expect(facts.exports).toHaveLength(1);
    expect(facts.exports[0]).toMatchObject({
      exportedName: "PublicName",
      localName: "PublicName",
      source: "External",
    });
  });

  test("preserves Python import aliases", async () => {
    const facts = await analyzeDynamicLanguage({
      languageId: "python",
      source: await fixture("python"),
    });
    expect(facts.imports[0]).toMatchObject({
      importedName: "Path",
      localName: "FilePath",
      source: "pathlib",
    });
  });

  test("does not create facts from comments or strings", async () => {
    const source =
      '# class Fake(Base):\r\npayload = "import ghost; Fake.call()"\r\nclass Real:\r\n    pass\r\n';
    const facts = await analyzeDynamicLanguage({
      languageId: "python",
      source,
    });
    expect(facts.symbols.map(({ name }) => name)).toEqual(["Real"]);
    expect(facts.imports).toEqual([]);
    expect(facts.calls).toEqual([]);
    expect(facts.inheritance).toEqual([]);
  });

  test("reports real malformed parser recovery", async () => {
    const source = await Bun.file(
      new URL(
        "./fixtures/intelligence/languages/dynamic/malformed.py",
        import.meta.url,
      ),
    ).text();
    const facts = await analyzeDynamicLanguage({
      languageId: "python",
      source,
    });
    expect(facts.partial).toBeTrue();
    expect(facts.diagnostics.length).toBeGreaterThan(0);
    expect(
      facts.diagnostics.every(
        ({ code }) => code === "parse-error" || code === "missing-node",
      ),
    ).toBeTrue();
  });

  test("fails closed for Luau-only export type syntax", async () => {
    const facts = await analyzeDynamicLanguage({
      languageId: "luau",
      source: await fixture("luau"),
    });
    expect(facts.partial).toBeTrue();
    expect(facts.diagnostics.length).toBeGreaterThan(0);
    expect(facts.symbols.some(({ name }) => name === "Result")).toBeFalse();
    expect(
      facts.exports.some(({ exportedName }) => exportedName === "Result"),
    ).toBeFalse();
    expect(facts.references.some(({ name }) => name === "Result")).toBeFalse();
    const errorRanges = facts.diagnostics.map(({ range }) => range);
    for (const item of [
      ...facts.symbols,
      ...facts.references,
      ...facts.calls,
      ...facts.imports,
      ...facts.exports,
      ...facts.inheritance,
      ...facts.implementations,
    ]) {
      expect(
        errorRanges.some(
          (range) =>
            range.startByte <= item.range.startByte &&
            range.endByte >= item.range.endByte,
        ),
      ).toBeFalse();
    }
  });

  test("uses exact UTF-8, UTF-16, Unicode, and CRLF ranges", async () => {
    const source = (
      await Bun.file(
        new URL(
          "./fixtures/intelligence/languages/dynamic/unicode.py",
          import.meta.url,
        ),
      ).text()
    ).replace(/\r?\n/gu, "\r\n");
    const facts = await analyzeDynamicLanguage({
      languageId: "python",
      source,
    });
    const symbol = facts.symbols.find(({ name }) => name === "café");
    expect(symbol?.declarationRange).toMatchObject({
      endByte: 25,
      endCoordinate: {
        byteOffset: 25,
        characterOffset: 21,
        column: 8,
        line: 1,
        utf16Column: 8,
        utf16Offset: 22,
      },
      startByte: 20,
      startCoordinate: {
        byteOffset: 20,
        characterOffset: 17,
        column: 4,
        line: 1,
        utf16Column: 4,
        utf16Offset: 18,
      },
    });
    expect(
      source.slice(
        symbol?.declarationRange.startCoordinate.utf16Offset,
        symbol?.declarationRange.endCoordinate.utf16Offset,
      ),
    ).toBe("café");
  });

  test("keeps references scoped across shadowed names", async () => {
    const source =
      "def outer(alias):\n    alias()\ndef inner(alias):\n    alias()\n";
    const facts = await analyzeDynamicLanguage({
      languageId: "python",
      source,
    });
    const calls = facts.calls.filter(({ callee }) => callee === "alias");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.enclosingSymbolId).not.toBe(calls[1]?.enclosingSymbolId);
    const aliases = facts.references.filter(({ name }) => name === "alias");
    expect(aliases.filter(({ role }) => role === "write")).toHaveLength(2);
    expect(aliases.filter(({ role }) => role === "read")).toHaveLength(2);
    expect(
      new Set(aliases.map(({ enclosingSymbolId }) => enclosingSymbolId)).size,
    ).toBe(2);
  });

  test("builds deterministic sorted grammar manifests", () => {
    const assets = [
      {
        astGrepLanguage: "ruby",
        grammarVersion: "1",
        languageId: "ruby",
        libraryPath: "/ruby.wasm",
        sha256: "b".repeat(64),
      },
      {
        astGrepLanguage: "python",
        grammarVersion: "1",
        languageId: "python",
        libraryPath: "/python.wasm",
        sha256: "a".repeat(64),
      },
    ] as const;
    const manifest = createDynamicGrammarManifest(assets);
    expect(
      manifest.entries.map(({ descriptor }) => descriptor.languageId),
    ).toEqual(["python", "ruby"]);
    expect(manifest.fingerprint).toBe(
      createDynamicGrammarManifest([...assets].reverse()).fingerprint,
    );
    expect(
      manifest.entries.every(({ implementation }) => !implementation.match),
    ).toBeTrue();
    expect(
      manifest.entries.every(({ implementation }) => !implementation.rewrite),
    ).toBeTrue();
    expect(() => createDynamicGrammarManifest([assets[0], assets[0]])).toThrow(
      "Duplicate dynamic grammar",
    );
    expect(() =>
      createDynamicGrammarManifest([{ ...assets[0], sha256: "bad" }]),
    ).toThrow("Invalid grammar SHA-256");
  });

  test("does not infer runtime metaprogramming", async () => {
    const source = await Bun.file(
      new URL(
        "./fixtures/intelligence/languages/dynamic/unsupported.py",
        import.meta.url,
      ),
    ).text();
    const facts = await analyzeDynamicLanguage({
      languageId: "python",
      source,
    });
    expect(facts.symbols).toEqual([]);
    expect(facts.inheritance).toEqual([]);
    expect(facts.calls.map(({ callee }) => callee)).toEqual(["type"]);
  });

  test("exposes a deterministic unavailable error contract", () => {
    const error = new DynamicLanguageUnavailableError("luau");
    expect(error).toMatchObject({
      code: "dynamic_grammar_unavailable",
      languageId: "luau",
      retryable: false,
    });
  });

  test("rejects missing and unknown worker request discriminants", async () => {
    const worker = new Worker(
      new URL(
        "../src/intelligence/languages/dynamic/wasm-worker.ts",
        import.meta.url,
      ),
    );
    const response = (message: unknown) =>
      new Promise<unknown>((resolve) => {
        worker.once("message", resolve);
        worker.postMessage(message);
      });
    expect(await response({ id: 71 })).toEqual({
      error: "Invalid dynamic parser worker request",
      id: 71,
      ok: false,
      type: "result",
    });
    expect(
      await response({
        id: 72,
        languageId: "python",
        source: "x = 1",
        type: "unknown",
      }),
    ).toEqual({
      error: "Invalid dynamic parser worker request",
      id: 72,
      ok: false,
      type: "result",
    });
    await worker.terminate();
  });

  test("normalizes worker failures and safely clears an empty queue", async () => {
    await closeDynamicLanguageWorker();
    expect(() => rejectPendingDynamicRequests("worker failed")).not.toThrow();
  });

  test("bounds bytes, supports abort and timeout, drains, and restarts", async () => {
    await expect(
      analyzeDynamicLanguage({
        languageId: "python",
        source: "x".repeat(DYNAMIC_WORKER_LIMITS.maxOutstandingBytes + 1),
      }),
    ).rejects.toMatchObject({ code: "queue-full" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzeDynamicLanguage({
        languageId: "python",
        signal: controller.signal,
        source: "x = 1",
      }),
    ).rejects.toMatchObject({ code: "aborted" });

    const activeController = new AbortController();
    const active = analyzeDynamicLanguage({
      languageId: "python",
      signal: activeController.signal,
      source: "x = 1\n".repeat(100),
    });
    const activeOutcome = active.catch((error: unknown) => error);
    activeController.abort();
    expect(await activeOutcome).toMatchObject({ code: "aborted" });

    await expect(
      analyzeDynamicLanguage({
        languageId: "python",
        source: "x = 1",
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    await drainDynamicLanguageWorker();
    expect(dynamicWorkerStats()).toEqual({
      active: false,
      outstandingBytes: 0,
      pendingRequests: 0,
    });

    await restartDynamicLanguageWorker();
    const parse = analyzeDynamicLanguage({
      languageId: "python",
      source: "def live():\n    pass\n",
    });
    const drained = drainDynamicLanguageWorker();
    const facts = await parse;
    await drained;
    expect(facts.symbols.map(({ name }) => name)).toEqual(["live"]);
  });

  test("rejects outstanding work during close and restarts safely", async () => {
    const request = analyzeDynamicLanguage({
      languageId: "python",
      source: "x = 1\n".repeat(100),
    });
    const outcome = request.catch((error: unknown) => error);
    await closeDynamicLanguageWorker();
    expect(await outcome).toMatchObject({ code: "closed" });
    const facts = await analyzeDynamicLanguage({
      languageId: "python",
      source: "x = 1",
    });
    expect(facts.languageId).toBe("python");
  });

  test("rejects pending work on unexpected worker exit and restarts", async () => {
    const request = analyzeDynamicLanguage({
      languageId: "python",
      source: "x = 1",
    });
    const outcome = request.catch((error: unknown) => error);
    await terminateDynamicLanguageWorker();
    expect(await outcome).toMatchObject({ code: "worker-exit" });
    const facts = await analyzeDynamicLanguage({
      languageId: "python",
      source: "x = 1",
    });
    expect(facts.languageId).toBe("python");
  });

  test("keeps cancellation floods charged until termination drains", async () => {
    const controllers = Array.from({ length: 12 }, () => new AbortController());
    const outcomes = controllers.map((controller) =>
      analyzeDynamicLanguage({
        languageId: "python",
        signal: controller.signal,
        source: "x = 1\n".repeat(100),
      }).catch((error: unknown) => error),
    );
    for (const controller of controllers) controller.abort();
    expect(dynamicWorkerStats().pendingRequests).toBeGreaterThan(0);
    const recovery = analyzeDynamicLanguage({
      languageId: "python",
      source: "def recovered():\n    pass\n",
    });
    await Promise.all(outcomes);
    expect((await recovery).symbols.map(({ name }) => name)).toEqual([
      "recovered",
    ]);
    await drainDynamicLanguageWorker();
    expect(dynamicWorkerStats()).toEqual({
      active: true,
      outstandingBytes: 0,
      pendingRequests: 0,
    });
  });

  test("rejects unknown language adapters", () => {
    expect(() =>
      dynamicLanguageAdapter("unknown" as DynamicLanguageId),
    ).toThrow("Unsupported dynamic language");
  });
});

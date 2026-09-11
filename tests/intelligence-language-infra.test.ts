import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LanguageCapabilitySchema } from "../src/intelligence/contracts/language.ts";
import type {
  InfraGrammarAssetConfig,
  InfraLanguageId,
} from "../src/intelligence/languages/infra/index.ts";
import {
  analyzeInfraLanguage,
  closeInfraLanguageWorker,
  createInfraGrammarManifest,
  drainInfraLanguageWorker,
  handleInfraWorkerError,
  INFRA_WORKER_LIMITS,
  InfraWorkerError,
  infraLanguageAdapter,
  infraLanguageAdapters,
  infraLanguageGroupManifest,
  infraWorkerStats,
  interruptInfraLanguageWorker,
  rejectPendingInfraRequests,
  restartInfraLanguageWorker,
} from "../src/intelligence/languages/infra/index.ts";
import { validateInfraWorkerRequest } from "../src/intelligence/languages/infra/wasm-worker.ts";
import { validateInfraWorkerResponse } from "../src/intelligence/languages/infra/worker-client.ts";

const root = join(
  import.meta.dir,
  "fixtures",
  "intelligence",
  "languages",
  "infra",
);
const cases = {
  bash: "bash.sh",
  fortran: "fortran.f90",
  hcl: "hcl.tf",
  powershell: "powershell.ps1",
  sql: "sql.sql",
  systemverilog: "systemverilog.sv",
  verilog: "verilog.v",
} as const;
const source = (name: string) => readFile(join(root, name), "utf8");
function normalize(facts: Awaited<ReturnType<typeof analyzeInfraLanguage>>) {
  return facts;
}
function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
afterAll(closeInfraLanguageWorker);

describe("infrastructure language adapters", () => {
  test("publishes immutable, honest capabilities for every language", () => {
    expect(infraLanguageGroupManifest.groupId).toBe("infra");
    expect(infraLanguageAdapters.map(({ languageId }) => languageId)).toEqual([
      "bash",
      "fortran",
      "hcl",
      "powershell",
      "sql",
      "systemverilog",
      "verilog",
    ]);
    expect(Object.isFrozen(infraLanguageGroupManifest)).toBe(true);
    expect(Object.isFrozen(infraLanguageGroupManifest.adapters)).toBe(true);
    for (const adapter of infraLanguageAdapters) {
      expect(LanguageCapabilitySchema.parse(adapter.capability)).toEqual(
        adapter.capability,
      );
      expect(adapter.available).toBe(true);
      expect(adapter.capability.symbolExtraction.status).toBe("partial");
      expect(adapter.capability.callResolution.status).toBe("unsupported");
      expect(adapter.capability.importResolution.status).toBe("unsupported");
      expect(adapter.capability.match.status).toBe("unsupported");
      expect(adapter.capability.rewrite.status).toBe("unsupported");
    }
    expect(infraLanguageAdapter("bash").capability.parse.provider).toBe(
      "tree-sitter",
    );
    expect(infraLanguageAdapter("sql").capability.parse.provider).toBe(
      "custom",
    );
    expect(infraLanguageAdapter("verilog").capability.parse.status).toBe(
      "partial",
    );
    expect(() => infraLanguageAdapter("unknown" as InfraLanguageId)).toThrow(
      "Unsupported infrastructure language",
    );
  });

  test("matches the revision-pinned Graphify parity golden with UTF-8 byte ranges", async () => {
    const golden = JSON.parse(await source("graphify-golden.json"));
    expect(golden.project).toEqual({
      name: "graphify",
      revision: "3f82bf7f837a07fb0f7668fbdbd5662801906942",
    });
    const actual: Record<string, ReturnType<typeof normalize>> = {};
    for (const [languageId, fileName] of Object.entries(cases) as [
      InfraLanguageId,
      string,
    ][]) {
      const facts = await analyzeInfraLanguage({
        languageId,
        source: await source(fileName),
      });
      actual[languageId] = normalize(facts);
      expect(facts.schemaVersion).toBe("ast-mcp.syntax-facts.v1");
      expect(facts.sourceArtifactId).toHaveLength(64);
      expect(facts.syntaxFactsArtifactId).toHaveLength(64);
    }
    expect(actual).toEqual(golden.cases);
    const bash = await analyzeInfraLanguage({
      languageId: "bash",
      source: await source("bash.sh"),
    });
    const unicode = bash.nodes.find(({ range }) => range.startByte === 39);
    expect(unicode?.range.endByte).toBeGreaterThan(
      unicode?.range.endCoordinate.utf16Offset ?? 0,
    );
  });

  test("extracts language-aware declarations, dependencies, calls, and writes", async () => {
    const sql = await analyzeInfraLanguage({
      languageId: "sql",
      source: await source("sql.sql"),
    });
    expect(sql.symbols.map(({ name }) => name)).toEqual(["users"]);
    expect(sql.imports.map(({ source: value }) => value)).toEqual(["users"]);
    expect(sql.calls.map(({ callee }) => callee)).toEqual(["refresh_cache"]);
    expect(sql.references.find(({ name }) => name === "users")?.role).toBe(
      "write",
    );
    const hcl = await analyzeInfraLanguage({
      languageId: "hcl",
      source: await source("hcl.tf"),
    });
    expect(hcl.symbols.map(({ name }) => name)).toEqual(["logs"]);
    expect(hcl.imports.map(({ source: value }) => value)).toEqual(["./module"]);
    expect(hcl.calls.map(({ callee }) => callee)).toEqual(["format"]);
    const verilog = await analyzeInfraLanguage({
      languageId: "verilog",
      source: await source("verilog.v"),
    });
    expect(verilog.partial).toBe(true);
    expect(verilog.diagnostics).toContainEqual(
      expect.objectContaining({ code: "truncated", severity: "warning" }),
    );
  });

  test("rejects malformed, extra, contradictory, and unsafe worker protocol records", async () => {
    expect(
      validateInfraWorkerRequest({
        id: 1,
        languageId: "sql",
        source: "SELECT 1;",
        type: "start",
      }),
    ).toMatchObject({ id: 1, languageId: "sql" });
    expect(validateInfraWorkerRequest({ id: 2, type: "cancel" })).toEqual({
      id: 2,
      type: "cancel",
    });
    for (const invalid of [
      null,
      { id: 0, type: "cancel" },
      { id: Number.MAX_SAFE_INTEGER + 1, type: "cancel" },
      { extra: true, id: 1, type: "cancel" },
      { id: 1, type: "other" },
      { id: 1, languageId: "unknown", source: "", type: "start" },
      { id: 1, languageId: "sql", source: 1, type: "start" },
      { extra: true, id: 1, languageId: "sql", source: "", type: "start" },
    ])
      expect(() => validateInfraWorkerRequest(invalid)).toThrow();
    const sourceText = "CREATE TABLE valid; SELECT * FROM valid; CALL refresh;";
    const facts = await analyzeInfraLanguage({
      languageId: "sql",
      source: sourceText,
    });
    expect(
      validateInfraWorkerResponse(
        { facts, id: 7, ok: true, type: "result" },
        { id: 7, languageId: "sql", source: sourceText },
      ),
    ).toMatchObject({ id: 7, ok: true });
    expect(() =>
      validateInfraWorkerResponse({
        extra: true,
        facts,
        id: 7,
        ok: true,
        type: "result",
      }),
    ).toThrow();
    expect(() =>
      validateInfraWorkerResponse({ facts, id: 0, ok: true, type: "result" }),
    ).toThrow();
    expect(() =>
      validateInfraWorkerResponse({
        error: "failed",
        facts,
        id: 7,
        ok: false,
        type: "result",
      }),
    ).toThrow();
    expect(
      validateInfraWorkerResponse({
        error: "failed",
        id: 7,
        ok: false,
        type: "result",
      }),
    ).toEqual({ error: "failed", id: 7, ok: false, type: "result" });
    expect(() =>
      validateInfraWorkerResponse(
        { error: "failed", id: 7, ok: false, type: "result" },
        { id: 8, languageId: "sql", source: sourceText },
      ),
    ).toThrow();
    expect(() =>
      validateInfraWorkerResponse(
        {
          facts: { ...facts, sourceDigest: "0".repeat(64) },
          id: 7,
          ok: true,
          type: "result",
        },
        { id: 7, languageId: "sql", source: sourceText },
      ),
    ).toThrow();
    expect(() =>
      validateInfraWorkerResponse({
        facts: { ...facts, calls: [{}] },
        id: 7,
        ok: true,
        type: "result",
      }),
    ).toThrow();
  });

  test("rejects inconsistent identities, coordinates, links, and semantic pointers", async () => {
    const sourceText = "CREATE TABLE valid; SELECT * FROM valid;";
    const facts = await analyzeInfraLanguage({
      languageId: "sql",
      source: sourceText,
    });
    const complete = structuredClone(facts);
    const completeSymbol = required(complete.symbols[0], "Expected SQL symbol");
    const relationshipRange = completeSymbol.declarationRange;
    complete.inheritance.push({
      id: createHash("sha256").update("infra-inheritance").digest("hex"),
      range: relationshipRange,
      sourceSymbolId: completeSymbol.id,
      targetName: "base",
    });
    complete.implementations.push({
      id: createHash("sha256").update("infra-implementation").digest("hex"),
      range: relationshipRange,
      sourceSymbolId: completeSymbol.id,
      targetName: "contract",
    });
    complete.syntaxFactsArtifactId = createHash("sha256")
      .update(
        JSON.stringify([
          complete.sourceDigest,
          complete.extractorFingerprint,
          complete.symbols.map((item) => item.id),
          complete.imports.map((item) => item.id),
          complete.calls.map((item) => item.id),
          complete.inheritance.map((item) => item.id),
          complete.implementations.map((item) => item.id),
          complete.exports.map((item) => item.id),
        ]),
      )
      .digest("hex");
    expect(
      validateInfraWorkerResponse(
        { facts: complete, id: 9, ok: true, type: "result" },
        { id: 9, languageId: "sql", source: sourceText },
      ),
    ).toMatchObject({ id: 9, ok: true });

    const reject = (mutate: (copy: typeof facts) => void) => {
      const copy = structuredClone(facts);
      mutate(copy);
      expect(() =>
        validateInfraWorkerResponse(
          { facts: copy, id: 9, ok: true, type: "result" },
          { id: 9, languageId: "sql", source: sourceText },
        ),
      ).toThrow(InfraWorkerError);
    };
    reject((copy) => {
      required(copy.nodes[0], "Expected root node").range.startByte++;
    });
    reject((copy) => {
      const rootNode = required(copy.nodes[0], "Expected root node");
      rootNode.range.startCoordinate.utf16Offset =
        rootNode.range.endCoordinate.utf16Offset + 1;
    });
    reject((copy) => {
      copy.grammarFingerprint = "0".repeat(64);
    });
    reject((copy) => {
      copy.syntaxFactsArtifactId = "0".repeat(64);
    });
    reject((copy) => {
      required(copy.nodes[1], "Expected child node").parentId = "f".repeat(64);
    });
    reject((copy) => {
      const rootNode = required(copy.nodes[0], "Expected root node");
      rootNode.childIds.push(
        required(rootNode.childIds[0], "Expected child id"),
      );
    });
    reject((copy) => {
      const rootNode = required(copy.nodes[0], "Expected root node");
      rootNode.childIds = rootNode.childIds.slice(1);
    });
    reject((copy) => {
      required(copy.references[0], "Expected reference").id = required(
        copy.nodes[0],
        "Expected root node",
      ).id;
    });
    reject((copy) => {
      required(copy.references[0], "Expected reference").enclosingSymbolId =
        "e".repeat(64);
    });
  });

  test("ignores comments, resolves guarded SQL declarations, and classifies variable roles", async () => {
    const sql = await analyzeInfraLanguage({
      languageId: "sql",
      source:
        "-- CREATE TABLE ghost;\n/* CALL phantom; */\nCREATE TABLE IF NOT EXISTS users;",
    });
    expect(sql.symbols.map(({ name }) => name)).toEqual(["users"]);
    expect(sql.calls).toEqual([]);

    for (const [languageId, value, expected] of [
      ["bash", "item=one\necho $item", "item"],
      ["hcl", "# ghost = bad\nname = var.name\noutput = name", "name"],
      ["fortran", "! ghost = bad\nvalue = input\nprint *, value", "value"],
      [
        "powershell",
        "function Test($Name) { $value = $Name; Write-Output $value }",
        "$value",
      ],
    ] as const) {
      const facts = await analyzeInfraLanguage({ languageId, source: value });
      const roles = facts.references
        .filter(({ name }) => name === expected)
        .map(({ role }) => role);
      expect(roles).toContain("write");
      expect(roles).toContain("read");
    }
    const powershell = await analyzeInfraLanguage({
      languageId: "powershell",
      source: "function Test($Name) { Write-Output $Name }",
    });
    expect(
      powershell.references.find(({ name }) => name === "$Name")?.role,
    ).toBe("write");
    const ansi = await analyzeInfraLanguage({
      languageId: "systemverilog",
      source: "module top(input logic clk); child u0(); endmodule",
    });
    expect(ansi.symbols.map(({ name }) => name)).toEqual(["top"]);
    expect(ansi.calls.map(({ callee }) => callee)).toEqual(["child"]);
    expect(ansi.partial).toBe(false);
  });

  test("diagnoses malformed structured spans while preserving valid siblings", async () => {
    for (const [languageId, value, preserved] of [
      ["sql", "CREATE TABLE valid;\nSELECT 'unterminated", "valid"],
      ["hcl", 'resource "kind" "kept" {}\nname = "unterminated', "kept"],
      ["fortran", "program kept\nvalue = (input\nend program kept", "kept"],
    ] as const) {
      const facts = await analyzeInfraLanguage({ languageId, source: value });
      expect(facts.partial).toBe(true);
      expect(facts.diagnostics).toContainEqual(
        expect.objectContaining({ code: "parse-error", severity: "error" }),
      );
      expect(facts.symbols.map(({ name }) => name)).toContain(preserved);
      for (const fact of [
        ...facts.symbols,
        ...facts.imports,
        ...facts.exports,
        ...facts.calls,
        ...facts.references,
      ])
        expect(
          facts.diagnostics.some(
            ({ range }) =>
              range.startByte < fact.range.endByte &&
              range.endByte > fact.range.startByte,
          ),
        ).toBe(false);
    }
  });

  test("suppresses every semantic fact contained by parser error regions", async () => {
    const facts = await analyzeInfraLanguage({
      languageId: "bash",
      source: await source("malformed.sh"),
    });
    expect(facts.partial).toBe(true);
    expect(facts.diagnostics.length).toBeGreaterThan(0);
    expect(facts.calls.map(({ callee }) => callee)).toContain("echo");
    expect(facts.calls.map(({ callee }) => callee)).toContain("good");
    expect(facts.calls.map(({ callee }) => callee)).not.toContain("broken");
    const semantic = [
      ...facts.symbols,
      ...facts.imports,
      ...facts.exports,
      ...facts.calls,
      ...facts.inheritance,
      ...facts.implementations,
      ...facts.references,
    ];
    for (const fact of semantic) {
      expect(
        facts.diagnostics.some(
          ({ range }) =>
            range.startByte <= fact.range.startByte &&
            range.endByte >= fact.range.endByte,
        ),
      ).toBe(false);
    }
  });

  test("enforces bounded cancellation, timeout, termination, drain, and recovery", async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(
      analyzeInfraLanguage({
        languageId: "bash",
        signal: pre.signal,
        source: "echo ok",
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    await expect(
      analyzeInfraLanguage({
        languageId: "bash",
        source: "echo timeout\n".repeat(20_000),
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    await expect(
      analyzeInfraLanguage({
        languageId: "sql",
        source: "x".repeat(INFRA_WORKER_LIMITS.maxOutstandingBytes + 1),
      }),
    ).rejects.toBeInstanceOf(InfraWorkerError);
    const capacityRequests = Array.from(
      { length: INFRA_WORKER_LIMITS.maxPendingRequests },
      () =>
        analyzeInfraLanguage({
          languageId: "bash",
          source: "echo capacity\n".repeat(100),
        }),
    );
    await expect(
      analyzeInfraLanguage({ languageId: "bash", source: "echo overflow" }),
    ).rejects.toMatchObject({ code: "queue-full" });
    await Promise.all(capacityRequests);
    const activeController = new AbortController();
    const active = analyzeInfraLanguage({
      languageId: "bash",
      signal: activeController.signal,
      source: "echo pending\n".repeat(20_000),
    });
    const observed = active.catch((error: unknown) => error);
    activeController.abort();
    expect(await observed).toMatchObject({ code: "aborted" });
    await drainInfraLanguageWorker();
    expect(infraWorkerStats()).toEqual({
      outstandingBytes: 0,
      pendingRequests: 0,
    });
    const closing = analyzeInfraLanguage({
      languageId: "bash",
      source: "echo closing\n".repeat(20_000),
    });
    const closingObserved = closing.catch((error: unknown) => error);
    await closeInfraLanguageWorker();
    expect(await closingObserved).toMatchObject({ code: "closed" });
    const crashing = analyzeInfraLanguage({
      languageId: "bash",
      source: "echo crash\n".repeat(20_000),
    });
    const crashObserved = crashing.catch((error: unknown) => error);
    await interruptInfraLanguageWorker();
    expect(await crashObserved).toMatchObject({ code: "worker-exit" });
    handleInfraWorkerError(null as never, new Error("stale"));
    rejectPendingInfraRequests("no pending requests");
    await restartInfraLanguageWorker();
    const restarted = await analyzeInfraLanguage({
      languageId: "sql",
      source: "CREATE TABLE recovered;",
    });
    expect(restarted.symbols.map(({ name }) => name)).toEqual(["recovered"]);
  });

  test("retains accounting during abort floods and serves queued recovery", async () => {
    const controllers = Array.from({ length: 12 }, () => new AbortController());
    const outcomes = controllers.map((controller) =>
      analyzeInfraLanguage({
        languageId: "bash",
        signal: controller.signal,
        source: "echo pending\n".repeat(2_000),
      }).catch((error: unknown) => error),
    );
    for (const controller of controllers) controller.abort();
    expect(infraWorkerStats().pendingRequests).toBeGreaterThan(0);
    const recovery = analyzeInfraLanguage({
      languageId: "sql",
      source: "CREATE TABLE recovered;",
    });
    await Promise.all(outcomes);
    expect((await recovery).symbols[0]?.name).toBe("recovered");
    await drainInfraLanguageWorker();
    expect(infraWorkerStats()).toEqual({
      outstandingBytes: 0,
      pendingRequests: 0,
    });
  });

  test("creates deterministic, deeply frozen grammar manifests", () => {
    const assets = infraLanguageAdapters.map(
      (adapter, index): InfraGrammarAssetConfig => ({
        astGrepLanguage: `tree-sitter-${adapter.languageId}`,
        grammarVersion: `1.0.${index}`,
        languageId: adapter.languageId,
        libraryPath: `/grammars/${adapter.languageId}.wasm`,
        sha256: index.toString(16).padStart(64, "0"),
      }),
    );
    const manifest = createInfraGrammarManifest(assets);
    expect(manifest).toEqual(createInfraGrammarManifest([...assets].reverse()));
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.entries)).toBe(true);
    expect(Object.isFrozen(manifest.entries[0]?.descriptor)).toBe(true);
    expect(
      manifest.entries.every(
        ({ implementation }) =>
          !implementation.match && !implementation.rewrite,
      ),
    ).toBe(true);
    expect(() => createInfraGrammarManifest(assets.slice(1))).toThrow(
      "Missing infrastructure grammars",
    );
    const duplicate = assets[0];
    if (!duplicate) throw new Error("Expected an infrastructure grammar asset");
    expect(() => createInfraGrammarManifest([...assets, duplicate])).toThrow(
      "Duplicate infrastructure grammar",
    );
    expect(() =>
      createInfraGrammarManifest(
        assets.map((value, index) =>
          index ? value : { ...value, sha256: "bad" },
        ),
      ),
    ).toThrow("Invalid grammar SHA-256");
  });

  test("verifies Graphify and parser provenance checksums", async () => {
    const provenance = JSON.parse(await source("graphify-provenance.json"));
    expect(provenance.source).toEqual({
      repository: "https://github.com/Graphify-Labs/graphify",
      revision: "3f82bf7f837a07fb0f7668fbdbd5662801906942",
    });
    for (const [name, expected] of Object.entries(provenance.fixtures) as [
      string,
      string,
    ][]) {
      expect(
        createHash("sha256")
          .update(await source(name))
          .digest("hex"),
      ).toBe(expected);
    }
    for (const parser of Object.values(provenance.parsers) as Record<
      string,
      string
    >[]) {
      if (!parser.asset) continue;
      const bytes = await readFile(
        join(
          import.meta.dir,
          "..",
          "node_modules",
          "tree-sitter-wasm",
          parser.asset,
        ),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        parser.sha256,
      );
    }
  });
});

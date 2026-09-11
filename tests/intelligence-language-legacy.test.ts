import { afterAll, describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import {
  analyzeLegacyLanguage,
  closeLegacyLanguageWorker,
  drainLegacyLanguageWorker,
  GRAPHIFY_LEGACY_BASELINE_REVISION,
  isLegacySyntaxFacts,
  isLegacyWorkerRequest,
  isLegacyWorkerResult,
  LEGACY_WORKER_LIMITS,
  type LegacyLanguageId,
  LegacyLanguageUnavailableError,
  legacyLanguageAdapter,
  legacyLanguageGroupManifest,
  legacySyntaxFactsArtifactId,
  legacyWorkerStats,
  rejectPendingLegacyRequests,
  restartLegacyLanguageWorker,
  terminateLegacyLanguageWorker,
} from "../src/intelligence/languages/legacy/index.ts";

const fixtureNames: Record<LegacyLanguageId, string> = {
  "common-lisp": "common-lisp.lisp",
  dreammaker: "dreammaker.dm",
  ocaml: "ocaml.ml",
  pascal: "pascal.pas",
  "robot-framework": "robot.robot",
};
const golden = await Bun.file(
  new URL(
    "./fixtures/intelligence/languages/legacy/graphify-golden.json",
    import.meta.url,
  ),
).json();
async function fixture(id: LegacyLanguageId) {
  return Bun.file(
    new URL(
      `./fixtures/intelligence/languages/legacy/${fixtureNames[id]}`,
      import.meta.url,
    ),
  ).text();
}
afterAll(closeLegacyLanguageWorker);

describe("legacy language adapters", () => {
  test("matches pinned exact Graphify-parity records for all languages", async () => {
    expect(golden.provenance.revision).toBe(GRAPHIFY_LEGACY_BASELINE_REVISION);
    expect(golden.provenance.repository).toBe(
      "https://github.com/Graphify-Labs/graphify",
    );
    expect(golden.provenance.source).toEqual({
      path: "graphify/extract.py",
      sha256:
        "b74400146d86f48ad8023cb0732533990da1c62a4546a304c97939563281ee3b",
    });
    expect(golden.provenance.reproductionCommand).toBe(
      "bun run tests/fixtures/intelligence/languages/legacy/reproduce-golden.ts --check",
    );
    for (const id of Object.keys(fixtureNames) as LegacyLanguageId[]) {
      const source = await fixture(id);
      const checksum = new Bun.CryptoHasher("sha256")
        .update(source)
        .digest("hex");
      expect(checksum).toBe(golden.provenance.fixtureChecksums[id]);
      const facts = await analyzeLegacyLanguage({ languageId: id, source });
      expect(facts).toEqual(golden.languages[id]);
    }
  });
  test("keeps capability claims honest and manifests deeply immutable", () => {
    for (const adapter of legacyLanguageGroupManifest.adapters) {
      expect(adapter.available).toBe(true);
      expect(adapter.capability.match.status).toBe("unsupported");
      expect(adapter.capability.rewrite.status).toBe("unsupported");
      expect(adapter.capability.callResolution.status).toBe("unsupported");
      expect(adapter.capability.symbolExtraction.status).toBe("partial");
      expect(adapter.capability.structuredParser.mode).toBe("none");
      expect(adapter.capability.parse.provider).toBe(
        adapter.languageId === "ocaml" || adapter.languageId === "common-lisp"
          ? "tree-sitter"
          : "custom",
      );
    }
    expect(Object.isFrozen(legacyLanguageGroupManifest)).toBe(true);
    expect(Object.isFrozen(legacyLanguageGroupManifest.adapters)).toBe(true);
    expect(
      Object.isFrozen(legacyLanguageGroupManifest.adapters[0]?.capability),
    ).toBe(true);
    expect(() => legacyLanguageAdapter("bad" as LegacyLanguageId)).toThrow(
      "Unsupported legacy language",
    );
  });
  test("uses exact UTF-8 ranges and ignores comments and strings", async () => {
    const source =
      "procedure café;\nbegin\n  // procedure fake;\n  WriteLn('function hidden');\nend;\n";
    const facts = await analyzeLegacyLanguage({ languageId: "pascal", source });
    const symbol = facts.symbols.find((x) => x.name === "café");
    expect(symbol?.range).toMatchObject({
      endByte: 15,
      endCoordinate: { utf16Offset: 14 },
      startByte: 10,
      startCoordinate: { utf16Offset: 10 },
    });
    expect(
      facts.symbols.some((x) => x.name === "fake" || x.name === "hidden"),
    ).toBe(false);
  });
  test("suppresses facts inside malformed regions and emits diagnostics", async () => {
    for (const [languageId, source] of [
      ["pascal", "procedure broken(x: integer;\nbegin hidden();"],
      ["ocaml", "let broken = ( hidden value"],
    ] as const) {
      const facts = await analyzeLegacyLanguage({ languageId, source });
      expect(facts.partial).toBe(true);
      expect(facts.diagnostics.length).toBeGreaterThan(0);
      for (const item of [
        ...facts.symbols,
        ...facts.calls,
        ...facts.references,
      ]) {
        expect(
          facts.diagnostics.some(
            (d) =>
              d.range.startByte <= item.range.startByte &&
              d.range.endByte >= item.range.endByte,
          ),
        ).toBe(false);
      }
    }
  });
  test("provides language-aware declaration and parameter roles", async () => {
    const cases: Array<[LegacyLanguageId, string, string[]]> = [
      ["pascal", "procedure P(value: integer); begin end;", ["P", "value"]],
      ["ocaml", "let add x y = x + y", ["add", "x", "y"]],
      ["common-lisp", "(defun add (x y) (+ x y))", ["add", "x", "y"]],
      ["dreammaker", "/mob/proc/greet(name)\n  log(name)", ["name"]],
      [
        "robot-framework",
        "*** Keywords ***\nMy Keyword\n    No Operation\n",
        ["My Keyword"],
      ],
    ];
    for (const [languageId, source, writes] of cases) {
      const facts = await analyzeLegacyLanguage({ languageId, source });
      expect(
        facts.references.filter((x) => x.role === "write").map((x) => x.name),
      ).toEqual(writes);
    }
  });
  test("extracts dependencies and rejects non-executable call lookalikes", async () => {
    const pascal = await analyzeLegacyLanguage({
      languageId: "pascal",
      source:
        "type TChild = class(TBase) end; begin if (ready) then while (busy) do Work(); end;",
    });
    expect(pascal.symbols.map(({ name }) => name)).toContain("TChild");
    expect(pascal.inheritance.map(({ targetName }) => targetName)).toContain(
      "TBase",
    );
    expect(pascal.calls.map(({ callee }) => callee)).toEqual(["Work"]);

    const lisp = await analyzeLegacyLanguage({
      languageId: "common-lisp",
      source: "(require :alexandria)\n(defun run () (work))",
    });
    expect(lisp.imports.map(({ source }) => source)).toEqual(["alexandria"]);

    const dreammaker = await analyzeLegacyLanguage({
      languageId: "dreammaker",
      source: '#include "shared.dm"\n/mob/proc/run()\n  if(ready) work()',
    });
    expect(dreammaker.imports.map(({ source }) => source)).toEqual([
      "shared.dm",
    ]);
    expect(dreammaker.calls.map(({ callee }) => callee)).toEqual(["work"]);

    const robot = await analyzeLegacyLanguage({
      languageId: "robot-framework",
      source:
        "*** Settings ***\nLibrary    Browser\nResource    shared.resource\n# Fake    Call\n*** Test Cases ***\nCase\n    Log    hello\n",
    });
    expect(robot.imports.map(({ source }) => source)).toEqual([
      "Browser",
      "shared.resource",
    ]);
    expect(robot.calls.map(({ callee }) => callee)).toEqual(["Log"]);
  });

  test("strictly validates protocol, recursive facts, identities, and duplicates", async () => {
    const source = await fixture("ocaml");
    const facts = await analyzeLegacyLanguage({ languageId: "ocaml", source });
    const expected = {
      languageId: "ocaml" as const,
      sourceDigest: facts.sourceDigest,
    };
    const success = {
      facts,
      id: 1,
      ok: true as const,
      type: "result" as const,
    };
    expect(
      isLegacyWorkerRequest({
        id: 1,
        languageId: "ocaml",
        source,
        type: "start",
      }),
    ).toBe(true);
    expect(isLegacyWorkerRequest({ id: 1, type: "cancel" })).toBe(true);
    for (const bad of [
      { id: 0, type: "cancel" },
      { extra: true, id: 1, type: "cancel" },
      { id: 1, languageId: "ocaml", type: "start" },
      { id: 1, type: "unknown" },
    ])
      expect(isLegacyWorkerRequest(bad)).toBe(false);
    expect(isLegacyWorkerResult(success, expected)).toBe(true);
    expect(isLegacySyntaxFacts(facts, expected)).toBe(true);
    const withExport = structuredClone(facts);
    const exportRange = withExport.symbols.at(0)?.range;
    if (!exportRange) throw new Error("Expected an OCaml symbol");
    withExport.exports.push({
      exportedName: "add",
      id: "e".repeat(64),
      localName: "add",
      range: exportRange,
      source: null,
      typeOnly: false,
    });
    withExport.syntaxFactsArtifactId = legacySyntaxFactsArtifactId(withExport);
    expect(
      isLegacyWorkerResult({ ...success, facts: withExport }, expected),
    ).toBe(true);
    const mutate = (fn: (copy: typeof facts) => void) => {
      const copy = structuredClone(facts);
      fn(copy);
      return { ...success, facts: copy };
    };
    expect(isLegacyWorkerResult({ ...success, extra: true }, expected)).toBe(
      false,
    );
    expect(
      isLegacyWorkerResult(
        mutate((x) => {
          x.sourceDigest = "0".repeat(64);
        }),
        expected,
      ),
    ).toBe(false);
    expect(
      isLegacyWorkerResult(
        mutate((x) => {
          x.nodes.push(
            structuredClone(x.nodes[0] as NonNullable<(typeof x.nodes)[0]>),
          );
        }),
        expected,
      ),
    ).toBe(false);
    expect(
      isLegacyWorkerResult(
        mutate((x) => {
          const node = x.nodes.at(1);
          const semantic = x.symbols.at(0) ?? x.references.at(0);
          if (!node || !semantic)
            throw new Error("Expected collision candidates");
          node.id = semantic.id;
          x.syntaxFactsArtifactId = legacySyntaxFactsArtifactId(x);
        }),
        expected,
      ),
    ).toBe(false);
    expect(
      isLegacyWorkerResult(
        mutate((x) => {
          const n = x.nodes.at(1);
          if (n)
            n.range.endCoordinate.utf16Offset =
              n.range.startCoordinate.utf16Offset - 1;
        }),
        expected,
      ),
    ).toBe(false);
  });
  test("rejects malformed worker messages with correlated result envelopes", async () => {
    const worker = new Worker(
      new URL(
        "../src/intelligence/languages/legacy/wasm-worker.ts",
        import.meta.url,
      ),
    );
    const response = new Promise((resolve) => worker.once("message", resolve));
    worker.postMessage({ id: 7, type: "unknown" });
    expect(await response).toEqual({
      error: "Invalid legacy parser worker request",
      id: 7,
      ok: false,
      type: "result",
    });
    await worker.terminate();
  });
  test("bounds, aborts, drains, closes, and restarts persistent workers", async () => {
    expect(new LegacyLanguageUnavailableError("pascal")).toMatchObject({
      code: "legacy_grammar_unavailable",
      retryable: false,
    });
    expect(() => rejectPendingLegacyRequests("idle failure")).not.toThrow();
    await expect(
      analyzeLegacyLanguage({
        languageId: "pascal",
        source: "x".repeat(LEGACY_WORKER_LIMITS.maxOutstandingBytes + 1),
      }),
    ).rejects.toMatchObject({ code: "queue-full" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzeLegacyLanguage({
        languageId: "ocaml",
        signal: controller.signal,
        source: "let x = 1",
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    const activeController = new AbortController();
    const active = analyzeLegacyLanguage({
      languageId: "ocaml",
      signal: activeController.signal,
      source: "let x = 1\n".repeat(10_000),
    });
    const activeOutcome = active.catch((error) => error);
    activeController.abort();
    const recovery = analyzeLegacyLanguage({
      languageId: "ocaml",
      source: "let recovered = 1",
    });
    expect(await activeOutcome).toMatchObject({ code: "aborted" });
    expect((await recovery).symbols[0]?.name).toBe("recovered");
    await expect(
      analyzeLegacyLanguage({
        languageId: "ocaml",
        source: "let x = 1\n".repeat(10_000),
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    await drainLegacyLanguageWorker();
    expect(legacyWorkerStats()).toEqual({
      outstandingBytes: 0,
      pendingRequests: 0,
    });
    await restartLegacyLanguageWorker();
    const drainingParse = analyzeLegacyLanguage({
      languageId: "ocaml",
      source: "let x = 1\n".repeat(1_000),
    });
    const draining = drainLegacyLanguageWorker();
    await drainingParse;
    await draining;
    const closing = analyzeLegacyLanguage({
      languageId: "ocaml",
      source: "let x = 1\n".repeat(10_000),
    });
    const closingOutcome = closing.catch((error) => error);
    await closeLegacyLanguageWorker();
    expect(await closingOutcome).toMatchObject({ code: "closed" });
    const pending = analyzeLegacyLanguage({
      languageId: "ocaml",
      source: "let x = 1\n".repeat(10_000),
    });
    const outcome = pending.catch((error) => error);
    await terminateLegacyLanguageWorker();
    expect(await outcome).toMatchObject({ code: "worker-exit" });
  });
});

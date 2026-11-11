import { describe, expect, test } from "bun:test";

import { parseSource } from "../../src/intelligence/parser/index.ts";
import {
  acquireWorker,
  ParseFactsCache,
  parseCacheKey,
  releaseWorker,
} from "../../src/tools/code-intelligence-cache.ts";
import { computeNative } from "../../src/tools/code-intelligence-compute.ts";

const source = [
  'const title = "λ";',
  "export function target() { return title; }",
  "export function entry() { return target(); }",
].join("\n");
const file = {
  facts: parseSource({ languageId: "typescript", source }),
  path: "/workspace/entry.ts",
  source,
};

class TestWorker extends EventTarget {
  references = 0;
  stops = 0;

  ref() {
    this.references++;
  }

  unref() {
    this.references--;
  }

  terminate() {
    this.stops++;
  }

  worker() {
    return this as unknown as Worker;
  }
}

describe("native parse worker retention", () => {
  test("reuses only compatible workers and discards workers that fail while idle", () => {
    const failed = new TestWorker();
    const retained = new TestWorker();
    const replacement = new TestWorker();
    releaseWorker(failed.worker(), "failed-grammar");
    releaseWorker(retained.worker(), "retained-grammar");
    try {
      expect(failed.references).toBe(-1);
      failed.dispatchEvent(new Event("error"));
      expect(failed.stops).toBe(1);
      expect(acquireWorker(() => replacement.worker(), "failed-grammar")).toBe(
        replacement.worker(),
      );
      expect(
        acquireWorker(() => replacement.worker(), "retained-grammar"),
      ).toBe(retained.worker());
      expect(retained.references).toBe(0);
      retained.dispatchEvent(new Event("error"));
      expect(retained.stops).toBe(0);
    } finally {
      acquireWorker(() => replacement.worker(), "retained-grammar");
      retained.terminate();
      replacement.terminate();
    }
  });

  test("bounds idle workers and evicts incompatible grammars first", () => {
    const reusable = Array.from({ length: 4 }, () => new TestWorker());
    const overflow = new TestWorker();
    const newGrammar = new TestWorker();
    for (const item of reusable) releaseWorker(item.worker(), "old-grammar");
    try {
      releaseWorker(overflow.worker(), "old-grammar");
      expect(overflow.stops).toBe(1);
      releaseWorker(newGrammar.worker(), "new-grammar");
      expect(reusable[0]?.stops).toBe(1);
      reusable[0]?.dispatchEvent(new Event("error"));
      expect(reusable[0]?.stops).toBe(1);
      expect(acquireWorker(() => overflow.worker(), "new-grammar")).toBe(
        newGrammar.worker(),
      );
    } finally {
      for (const item of reusable) {
        acquireWorker(() => overflow.worker(), "old-grammar");
        item.terminate();
      }
      acquireWorker(() => overflow.worker(), "new-grammar");
      newGrammar.terminate();
    }
  });
});

describe("bounded native intelligence", () => {
  test("preserves direct-tool definitions and callers in a batched read", async () => {
    const [batch, definition, callers] = await Promise.all([
      computeNative(
        "read_symbols",
        { symbols: ["target", "missing"] },
        [file],
        "/workspace",
        [],
      ),
      computeNative("show", { target: "target" }, [file], "/workspace", []),
      computeNative("callers", { target: "target" }, [file], "/workspace", []),
    ]);
    if (
      !("items" in batch) ||
      !("items" in definition) ||
      !("items" in callers)
    )
      throw new Error("Expected definition and call results");
    expect(batch.items).toEqual([
      {
        symbol: "target",
        status: "found",
        definition: { items: definition.items, total: 1, truncated: false },
        callers: { items: callers.items, total: 1, truncated: false },
      },
      {
        symbol: "missing",
        status: "missing",
        definition: { items: [], total: 0, truncated: false },
        callers: { items: [], total: 0, truncated: false },
      },
    ]);
  });

  test("preserves ordered compact outcomes at the exact UTF-8 budget", async () => {
    const symbols = ["target", "λ", "target"];
    const expected = {
      items: symbols.map((symbol) => ({ symbol, status: "truncated" })),
      schema: "ast-mcp.read_symbols.v1",
      total: symbols.length,
      truncated: true,
    };
    const budget = Buffer.byteLength(JSON.stringify(expected));
    const read = (budget: number) =>
      computeNative(
        "read_symbols",
        { symbols, budget },
        [file],
        "/workspace",
        [],
      );
    expect(await read(budget)).toEqual(expected);
    await expect(read(budget - 1)).rejects.toMatchObject({
      code: "intelligence_budget_exceeded",
      retryable: true,
    });
  });

  test("keeps details that fit beside compact outcomes", async () => {
    const expected = {
      items: [
        {
          symbol: "missing",
          status: "missing",
          definition: { items: [], total: 0, truncated: false },
          callers: { items: [], total: 0, truncated: false },
        },
        { symbol: "target", status: "truncated" },
      ],
      schema: "ast-mcp.read_symbols.v1",
      total: 2,
      truncated: true,
    };
    const budget = Buffer.byteLength(JSON.stringify(expected));
    const batch = await computeNative(
      "read_symbols",
      { symbols: ["missing", "target"], budget },
      [file],
      "/workspace",
      [],
    );
    expect(batch).toEqual(expected);
  });

  test("distinguishes an incomplete scan from a definitive miss", async () => {
    const input = { symbols: ["target", "missing"] };
    const fromOmittedFiles = await computeNative(
      "read_symbols",
      input,
      [file],
      "/workspace",
      [],
      undefined,
      false,
    );
    const fromPartialFacts = await computeNative(
      "read_symbols",
      input,
      [{ ...file, facts: { ...file.facts, partial: true } }],
      "/workspace",
      [],
    );
    expect(fromOmittedFiles).toMatchObject({
      truncated: true,
      items: [
        { symbol: "target", status: "incomplete", definition: { total: 1 } },
        { symbol: "missing", status: "incomplete", definition: { total: 0 } },
      ],
    });
    expect(fromPartialFacts).toEqual(fromOmittedFiles);
  });

  test("keys cached facts by source, language and workspace scope", () => {
    const cache = new ParseFactsCache();
    const key = parseCacheKey("worktree:a", "typescript", source);
    cache.set(key, file.facts, 1);
    expect(cache.get(key)?.payload.toString()).toBe(JSON.stringify(file.facts));
    expect(
      cache.get(parseCacheKey("worktree:b", "typescript", source)),
    ).toBeUndefined();
    expect(
      cache.get(parseCacheKey("worktree:a", "javascript", source)),
    ).toBeUndefined();
    expect(
      cache.get(parseCacheKey("worktree:a", "typescript", source + "\n")),
    ).toBeUndefined();
  });

  test("evicts least-recently used backing buffers at the byte limit", () => {
    const bytes = Buffer.byteLength(JSON.stringify(file.facts));
    const cache = new ParseFactsCache(bytes * 2, 3);
    cache.set("keep", file.facts, 1);
    cache.set("evict", file.facts, 1);
    expect(cache.get("keep")?.payload.buffer.byteLength).toBe(bytes);
    cache.set("new", file.facts, 7);
    expect(cache.get("evict")).toBeUndefined();
    expect(cache.get("keep")?.transferredBytes).toBe(1);
    expect(cache.get("new")?.transferredBytes).toBe(7);
  });

  test("enforces the entry limit independently of payload size", () => {
    const cache = new ParseFactsCache(Number.MAX_SAFE_INTEGER, 1);
    cache.set("old", file.facts, 1);
    cache.set("new", file.facts, 2);
    expect(cache.get("old")).toBeUndefined();
    expect(cache.get("new")?.transferredBytes).toBe(2);
  });
});

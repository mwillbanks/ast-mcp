import { describe, expect, test } from "bun:test";

import { parseSource } from "../../src/intelligence/parser/index.ts";
import {
  ParseFactsCache,
  parseCacheKey,
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

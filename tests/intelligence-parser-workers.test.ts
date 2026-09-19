import { describe, expect, test } from "bun:test";

import {
  LanguageRegistry,
  ParserError,
  ParserWorkerPool,
} from "../src/intelligence/parser/index.ts";

const expectParserCode = async (
  promise: Promise<unknown>,
  code: ParserError["code"],
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected parser request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ParserError);
    expect((error as ParserError).code).toBe(code);
  }
};

describe("parser worker pool", () => {
  test("reuses a bounded adaptive pool for concurrent parsing", async () => {
    const pool = new ParserWorkerPool({
      dynamicGrammarManifest: new LanguageRegistry().dynamicManifest(),
      maxWorkers: 2,
      minWorkers: 1,
      queueLimit: 8,
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          pool.parse({
            languageId: "typescript",
            source: `export const value${index} = ${index};`,
          }),
        ),
      );
      expect(results).toHaveLength(6);
      expect(pool.stats.workers).toBe(2);
      expect(pool.stats.active).toBe(0);
      expect(pool.stats.queued).toBe(0);
      expect(
        new Set(results.map((facts) => facts.syntaxFactsArtifactId)).size,
      ).toBe(6);
    } finally {
      await pool.close({ drain: true });
    }
  });

  test("caches immutable parse snapshots and reports production reuse", async () => {
    const pool = new ParserWorkerPool({
      maxParseCacheBytes: 256 * 1024,
      maxParseCacheEntries: 4,
      maxWorkers: 1,
      minWorkers: 0,
    });
    try {
      const request = {
        languageId: "typescript" as const,
        source: "export function cached() { return true; }",
      };
      const cold = await pool.parse(request);
      expect(pool.stats.cache).toMatchObject({
        entries: 1,
        evictions: 0,
        hits: 0,
        misses: 1,
      });
      expect(pool.stats.cache.bytes).toBeGreaterThan(0);

      const coldSymbol = cold.symbols.find(
        (symbol) => symbol.name === "cached",
      );
      expect(coldSymbol).toBeDefined();
      if (coldSymbol) coldSymbol.name = "mutated";
      const warm = await pool.parse(request);
      expect(warm.symbols.map((symbol) => symbol.name)).toContain("cached");
      expect(pool.stats.cache).toMatchObject({
        entries: 1,
        evictions: 0,
        hits: 1,
        misses: 1,
      });

      const warmSymbol = warm.symbols.find(
        (symbol) => symbol.name === "cached",
      );
      expect(warmSymbol).toBeDefined();
      if (warmSymbol) warmSymbol.name = "mutated-again";
      const repeated = await pool.parse(request);
      expect(repeated.symbols.map((symbol) => symbol.name)).toContain("cached");
      expect(pool.stats.cache.hits).toBe(2);
    } finally {
      await pool.close({ drain: true });
    }
    expect(pool.stats.cache.entries).toBe(0);
    expect(pool.stats.cache.bytes).toBe(0);
  });

  test("keys cached parses by source and effective parser options", async () => {
    const pool = new ParserWorkerPool({
      maxParseCacheEntries: 8,
      maxWorkers: 1,
      minWorkers: 0,
    });
    try {
      const base = {
        languageId: "typescript" as const,
        source: "export const keyed = 1;",
      };
      await pool.parse(base);
      await pool.parse({ ...base, source: "export const keyed = 2;" });
      await pool.parse({ ...base, extractorVersion: "extractor-v2" });
      await pool.parse({ ...base, grammarVersion: "grammar-v2" });
      await pool.parse({ ...base, maxNodes: 2 });
      expect(pool.stats.cache).toMatchObject({
        entries: 5,
        hits: 0,
        misses: 5,
      });

      await pool.parse({ ...base, maxNodes: 2 });
      expect(pool.stats.cache.hits).toBe(1);
      expect(pool.stats.cache.misses).toBe(5);
    } finally {
      await pool.close({ drain: true });
    }
  });

  test("evicts least-recently-used parses within configured bounds", async () => {
    const pool = new ParserWorkerPool({
      maxParseCacheBytes: 256 * 1024,
      maxParseCacheEntries: 1,
      maxWorkers: 1,
      minWorkers: 0,
    });
    try {
      const first = {
        languageId: "typescript" as const,
        source: "export const firstCached = 1;",
      };
      const second = {
        languageId: "typescript" as const,
        source: "export const secondCached = 2;",
      };
      await pool.parse(first);
      await pool.parse(second);
      expect(pool.stats.cache).toMatchObject({
        entries: 1,
        evictions: 1,
        hits: 0,
        misses: 2,
      });

      await pool.parse(first);
      expect(pool.stats.cache).toMatchObject({
        entries: 1,
        evictions: 2,
        hits: 0,
        misses: 3,
      });
    } finally {
      await pool.close({ drain: true });
    }
  });

  test("enforces queue and memory bounds before dispatch", async () => {
    const queuePool = new ParserWorkerPool({
      maxWorkers: 1,
      minWorkers: 0,
      queueLimit: 1,
    });
    const first = queuePool.parse({
      languageId: "typescript",
      source: "export const first = 1;",
    });
    await expectParserCode(
      queuePool.parse({
        languageId: "typescript",
        source: "export const second = 2;",
      }),
      "queue-full",
    );
    await first;
    await queuePool.close({ drain: true });

    const memoryPool = new ParserWorkerPool({
      maxOutstandingBytes: 8,
      maxSourceBytes: 8,
      maxWorkers: 1,
      minWorkers: 0,
    });
    await expectParserCode(
      memoryPool.parse({
        languageId: "typescript",
        source: "export const tooLarge = true;",
      }),
      "source-too-large",
    );
    await memoryPool.close();

    const invalidBoundPool = new ParserWorkerPool({
      maxWorkers: 1,
      minWorkers: 0,
    });
    for (const maxNodes of [0, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const failure = invalidBoundPool.parse({
        languageId: "typescript",
        maxNodes,
        source: "const value = 1;",
      });
      await expectParserCode(failure, "invalid-request");
      await expect(failure).rejects.toMatchObject({ retryable: false });
    }
    await invalidBoundPool.close();

    const nodeBoundPool = new ParserWorkerPool({
      maxNodesPerJob: 2,
      maxWorkers: 1,
      minWorkers: 0,
    });
    const bounded = await nodeBoundPool.parse({
      languageId: "typescript",
      maxNodes: 1_000_000,
      source: "export function bounded(value: string) { return value; }",
    });
    expect(bounded.nodes).toHaveLength(2);
    expect(bounded.partial).toBe(true);
    expect(bounded.diagnostics.map((item) => item.code)).toContain("truncated");
    await nodeBoundPool.close({ drain: true });
  });

  test("cancellation does not poison later work", async () => {
    const pool = new ParserWorkerPool({ maxWorkers: 1, minWorkers: 0 });
    try {
      const controller = new AbortController();
      const cancelled = pool.parse(
        {
          languageId: "typescript",
          source: "export const cancelled = 1;",
        },
        { signal: controller.signal },
      );
      controller.abort();
      await expectParserCode(cancelled, "aborted");

      const facts = await pool.parse({
        languageId: "typescript",
        source: "export function healthy() { return 2; }",
      });
      expect(facts.symbols.map((symbol) => symbol.name)).toContain("healthy");
    } finally {
      await pool.close({ drain: true });
    }
  });

  test("serializes worker errors deterministically", async () => {
    const pool = new ParserWorkerPool({ maxWorkers: 1, minWorkers: 0 });
    try {
      const failure = pool.parse({
        languageId: "not-a-language",
        source: "value",
      });
      await expectParserCode(failure, "invalid-language");
      try {
        await failure;
      } catch (error) {
        expect((error as ParserError).toJSON()).toEqual({
          code: "invalid-language",
          message: "Unsupported parser language: not-a-language",
          retryable: false,
        });
      }
    } finally {
      await pool.close({ drain: true });
    }
  });

  test("rejects a tampered worker grammar manifest before dispatch", async () => {
    const manifest = new LanguageRegistry().dynamicManifest();
    const tampered = { ...manifest, fingerprint: "0".repeat(64) };
    expect(
      () =>
        new ParserWorkerPool({
          dynamicGrammarManifest: tampered,
          maxWorkers: 1,
          minWorkers: 0,
        }),
    ).toThrow("manifest fingerprint mismatch");

    const worker = new Worker(
      new URL("../src/intelligence/parser/worker.ts", import.meta.url).href,
      { type: "module" },
    );
    try {
      const ready = new Promise<{
        error?: { message: string };
        ok: boolean;
        type: string;
      }>((resolve) => {
        worker.onmessage = (event) => resolve(event.data);
      });
      worker.postMessage({ manifest: tampered, type: "initialize" });
      await expect(ready).resolves.toMatchObject({
        error: { message: "Dynamic grammar manifest fingerprint mismatch" },
        ok: false,
        type: "ready",
      });
    } finally {
      worker.terminate();
    }
  });

  test("recovers deterministically when a worker fails to load", async () => {
    const pool = new ParserWorkerPool({
      maxWorkers: 1,
      minWorkers: 0,
      workerUrl: new URL("./missing-parser-worker.ts", import.meta.url).href,
    });
    try {
      await expectParserCode(
        pool.parse({
          languageId: "typescript",
          source: "export const unreachable = true;",
        }),
        "worker-error",
      );
    } finally {
      await pool.close();
    }
  });

  test("timeouts replace a worker and later jobs succeed", async () => {
    const pool = new ParserWorkerPool({
      maxOutstandingBytes: 512 * 1024,
      maxSourceBytes: 512 * 1024,
      maxWorkers: 1,
      minWorkers: 0,
    });
    try {
      const largeSource = Array.from(
        { length: 12_000 },
        (_, index) => `const value${index} = ${index};`,
      ).join("\n");
      await expectParserCode(
        pool.parse(
          { languageId: "typescript", source: largeSource },
          { timeoutMs: 1 },
        ),
        "timeout",
      );
      const facts = await pool.parse(
        { languageId: "typescript", source: "export function ready() {}" },
        { timeoutMs: 10_000 },
      );
      expect(facts.symbols.map((symbol) => symbol.name)).toContain("ready");
    } finally {
      await pool.close({ drain: true });
    }
  });

  test("draining shutdown completes accepted jobs and rejects new work", async () => {
    const pool = new ParserWorkerPool({ maxWorkers: 1, minWorkers: 1 });
    const accepted = pool.parse({
      languageId: "typescript",
      source: "export function accepted() { return true; }",
    });
    const closing = pool.close({ drain: true });
    await expectParserCode(
      pool.parse({
        languageId: "typescript",
        source: "export const late = false;",
      }),
      "closed",
    );
    const facts = await accepted;
    await closing;

    expect(facts.symbols.map((symbol) => symbol.name)).toContain("accepted");
    expect(pool.stats.state).toBe("closed");
    expect(pool.stats.workers).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";

import {
  ParserWorkerPool,
  parseSource,
  type ParserPoolOptions,
} from "../../../src/intelligence/parser/index.ts";

const request = { languageId: "typescript", source: "export const value = 1;" };
describe("parser worker failure and lifecycle contracts", () => {
  test("rejects invalid worker limits and requests before starting workers", async () => {
    for (const options of [
      { minWorkers: -1 },
      { maxWorkers: 0 },
      { minWorkers: 2, maxWorkers: 1 },
      { queueLimit: 0 },
      { maxSourceBytes: 0 },
      { defaultTimeoutMs: 0 },
      { maxParseCacheBytes: -1 },
      { maxParseCacheEntries: -1 },
    ])
      expect(() => new ParserWorkerPool(options)).toThrow(TypeError);
    const pool = new ParserWorkerPool({ minWorkers: 0 });
    try {
      for (const timeoutMs of [0, -1, 1.5])
        await expect(pool.parse(request, { timeoutMs })).rejects.toMatchObject({
          code: "timeout",
          retryable: false,
        });
      await expect(
        pool.parse(request, { signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ code: "aborted" });
      expect(pool.stats.workers).toBe(0);
    } finally {
      await pool.close();
      await pool.close();
    }
  });

  test("non-draining close rejects accepted work and releases byte reservations", async () => {
    const pool = new ParserWorkerPool({ minWorkers: 0, maxWorkers: 1 });
    const accepted = pool.parse(request).catch((error: unknown) => error);
    await pool.close();
    expect(await accepted).toMatchObject({ code: "closed", retryable: true });
    expect(pool.stats).toMatchObject({
      state: "closed",
      outstandingBytes: 0,
      queued: 0,
      active: 0,
      workers: 0,
    });
  });

  test("disabled and undersized caches never retain parsed source", async () => {
    for (const options of [
      { maxParseCacheEntries: 0 },
      { maxParseCacheBytes: 0 },
      { maxParseCacheBytes: 1 },
    ]) {
      const pool = new ParserWorkerPool({
        ...options,
        minWorkers: 0,
        maxWorkers: 1,
      });
      try {
        await pool.parse(request);
        await pool.parse(request);
        expect(pool.stats.cache).toMatchObject({
          entries: 0,
          bytes: 0,
          hits: 0,
          misses: 2,
        });
      } finally {
        await pool.close();
      }
    }
  });

  test("concurrent identical parses replace one cache entry without double-counting bytes", async () => {
    const pool = new ParserWorkerPool({ minWorkers: 0, maxWorkers: 2 });
    try {
      const results = await Promise.all([
        pool.parse(request),
        pool.parse(request),
      ]);
      expect(results[0]).toEqual(results[1]);
      const bytes = pool.stats.cache.bytes;
      expect(pool.stats.cache.entries).toBe(1);
      expect(bytes).toBeGreaterThan(0);
      await pool.parse(request);
      expect(pool.stats.cache.bytes).toBe(bytes);
      expect(pool.stats.cache.hits).toBe(1);
    } finally {
      await pool.close();
    }
  });

  test("replaces a failed active worker and dispatches queued work", async () => {
    const transports: Array<{
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: ((event: ErrorEvent) => void) | null;
      postMessage(message: {
        type: string;
        id?: number;
        request?: typeof request;
      }): void;
      terminate(): void;
    }> = [];
    let terminated = 0;
    const workerFactory: ParserPoolOptions["workerFactory"] = () => {
      const worker = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null as ((event: ErrorEvent) => void) | null,
        postMessage(message: {
          type: string;
          id?: number;
          request?: typeof request;
        }) {
          if (message.type === "initialize")
            queueMicrotask(() =>
              worker.onmessage?.({
                data: { type: "ready", ok: true },
              } as MessageEvent),
            );
          else if (transports.length > 1 && message.request)
            queueMicrotask(() =>
              worker.onmessage?.({
                data: {
                  type: "result",
                  id: message.id,
                  ok: true,
                  facts: parseSource(message.request!),
                },
              } as MessageEvent),
            );
        },
        terminate() {
          terminated++;
        },
      };
      transports.push(worker);
      return worker as unknown as Worker;
    };
    const pool = new ParserWorkerPool({
      workerFactory,
      maxWorkers: 1,
      minWorkers: 1,
    });
    const failed = pool.parse(request).catch((error: unknown) => error);
    const next = pool.parse({
      ...request,
      source: "export const recovered = true;",
    });
    await Bun.sleep(1);
    transports[0]?.onerror?.({ message: "transport failed" } as ErrorEvent);
    expect(await failed).toMatchObject({
      code: "worker-error",
      retryable: true,
      message: "transport failed",
    });
    expect((await next).symbols.map((symbol) => symbol.name)).toContain(
      "recovered",
    );
    expect(pool.stats.outstandingBytes).toBe(0);
    expect(terminated).toBe(1);
    await pool.close();
  });

  test("rejects malformed worker replies and ignores stale request IDs", async () => {
    let receive!: (data: unknown) => void;
    let dispatchedId = 0;
    const pool = new ParserWorkerPool({
      minWorkers: 0,
      maxWorkers: 1,
      workerFactory: () => {
        const worker = {
          onmessage: null as ((event: MessageEvent) => void) | null,
          onerror: null,
          postMessage(message: { type: string; id?: number }) {
            if (message.type === "initialize")
              queueMicrotask(() => receive({ type: "ready", ok: true }));
            else dispatchedId = message.id!;
          },
          terminate() {},
        };
        receive = (data) => worker.onmessage?.({ data } as MessageEvent);
        return worker as unknown as Worker;
      },
    });
    try {
      const pending = pool.parse(request);
      await Bun.sleep(1);
      receive({ type: "result", id: dispatchedId + 1, ok: true });
      expect(pool.stats.active).toBe(1);
      receive({ type: "result", id: dispatchedId, ok: false });
      await expect(pending).rejects.toMatchObject({
        code: "worker-error",
        retryable: false,
      });
      expect(pool.stats.outstandingBytes).toBe(0);
    } finally {
      await pool.close();
    }
  });

  test("rejects all waiting jobs when initialization reports failure", async () => {
    const pool = new ParserWorkerPool({
      minWorkers: 0,
      maxWorkers: 1,
      workerFactory: () => {
        const worker = {
          onmessage: null as ((event: MessageEvent) => void) | null,
          onerror: null,
          postMessage() {
            queueMicrotask(() =>
              worker.onmessage?.({
                data: { type: "ready", ok: false },
              } as MessageEvent),
            );
          },
          terminate() {},
        };
        return worker as unknown as Worker;
      },
    });
    const jobs = [
      pool.parse(request),
      pool.parse({ ...request, source: "const second = 2;" }),
    ];
    const results = await Promise.allSettled(jobs);
    expect(
      results.every(
        (result) =>
          result.status === "rejected" && result.reason.code === "worker-error",
      ),
    ).toBe(true);
    expect(pool.stats).toMatchObject({
      state: "closed",
      queued: 0,
      outstandingBytes: 0,
      workers: 0,
    });
    await pool.close();
  });
});

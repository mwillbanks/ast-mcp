import { describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

import type { PatchStrategyContext } from "../../src/patch/strategy.ts";
import {
  aiderBlockStrategy,
  inlineAiderBlockStrategy,
} from "../../src/patch/strategy/aiderBlock.ts";
import {
  astStrategy,
  inlineAstStrategy,
} from "../../src/patch/strategy/ast.ts";
import { PatchPreparationPool } from "../../src/patch/strategy/worker-client.ts";

function context(): PatchStrategyContext {
  return {
    aiderBlocks: [{ search: "const value = 1;", replace: "const value = 2;" }],
    astRules: [],
    original: "const value = 1;",
    filePath: "/fixture.ts",
    mode: 0o644,
    language: "typescript",
    capabilities: {
      effective: {
        aiderMatchers: ["exact"],
        patch: ["ast", "aider_block"],
        read: ["text", "ast"],
      },
      intrinsic: {
        patch: ["ast", "aider_block"],
        read: ["text", "ast"],
        search: ["ast"],
      },
      generation: 1,
      filePath: "/fixture.ts",
      kind: "source",
      language: "typescript",
      parseErrorCount: 0,
      parseStatus: "parseable",
      size: 16,
    },
  };
}
const fixture = (body: string) =>
  new URL(
    "data:text/javascript," +
      encodeURIComponent(
        'import { parentPort } from "node:worker_threads"; parentPort.on("message", request => {' +
          body +
          "});",
      ),
  );
const success =
  "parentPort.postMessage({ ok: true, patch: { candidate: request.context.original, metadata: { operations: 1, strategy: request.strategy } } });";

describe("isolated patch preparation", () => {
  test("failed termination cannot free a still-running native worker slot", async () => {
    const worker = new Worker(fixture(success));
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => Promise.reject(new Error("termination failed"));
    const pool = new PatchPreparationPool({
      maxWorkers: 1,
      maxPending: 1,
      timeoutMs: 200,
      workerFactory: () => worker,
    });
    try {
      expect((await pool.prepare("aider_block", context())).candidate).toBe(
        "const value = 1;",
      );
      await Bun.sleep(1);
      await expect(
        pool.prepare("aider_block", context()),
      ).rejects.toMatchObject({ code: "patch_queue_full" });
    } finally {
      await terminate();
    }
  });

  test("queued requests use their admitted snapshot", async () => {
    const pool = new PatchPreparationPool({
      maxWorkers: 1,
      workerUrl: fixture(success),
    });
    const first = pool.prepare("aider_block", context());
    const mutable = context();
    const second = pool.prepare("aider_block", mutable);
    mutable.original = "changed after admission";
    expect((await second).candidate).toBe("const value = 1;");
    await first;
  });

  test("preserves native and textual preparation results across the worker boundary", async () => {
    expect(await aiderBlockStrategy.prepare(context())).toEqual(
      await inlineAiderBlockStrategy.prepare(context()),
    );
    const ast = {
      ...context(),
      aiderBlocks: [],
      astRules: [{ pattern: "const value = 1", fix: "const value = 3" }],
    };
    expect(await astStrategy.prepare(ast)).toEqual(
      await inlineAstStrategy.prepare(ast),
    );
    expect((await astStrategy.prepare(ast)).candidate).toBe("const value = 3");
  });

  test("preserves validation and matching errors from both isolated adapters", async () => {
    for (const adapter of [astStrategy, inlineAstStrategy]) {
      await expect(
        adapter.prepare({ ...context(), aiderBlocks: [], astRules: [] }),
      ).rejects.toMatchObject({ code: "patch_strategy_arguments" });
      await expect(
        adapter.prepare({ ...context(), language: undefined }),
      ).rejects.toMatchObject({ code: "patch_strategy_unavailable" });
      await expect(
        adapter.prepare({
          ...context(),
          aiderBlocks: [],
          astRules: [
            {
              expectedMatches: 2,
              pattern: "const value = 1",
              fix: "const value = 2",
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "ast_match_count",
        details: { expected: 2, matches: 1 },
      });
      await expect(
        adapter.prepare({
          ...context(),
          original: "foo(foo(1));",
          aiderBlocks: [],
          astRules: [
            { expectedMatches: 2, pattern: "foo($A)", fix: "bar($A)" },
          ],
        }),
      ).rejects.toMatchObject({ code: "ast_rewrite_overlap" });
      await expect(
        adapter.prepare({
          ...context(),
          language: "unsupported-language",
          aiderBlocks: [],
          astRules: [{ pattern: "value", fix: "next" }],
        }),
      ).rejects.toMatchObject({ code: "ast_preview_error" });
    }
    for (const adapter of [aiderBlockStrategy, inlineAiderBlockStrategy]) {
      const disabled = context();
      disabled.capabilities.effective.patch = [];
      await expect(adapter.prepare(disabled)).rejects.toMatchObject({
        code: "patch_strategy_unavailable",
      });
      await expect(
        adapter.prepare({ ...context(), aiderBlocks: [] }),
      ).rejects.toMatchObject({ code: "patch_strategy_arguments" });
      await expect(
        adapter.prepare({
          ...context(),
          aiderBlocks: [{ search: "absent", replace: "next" }],
        }),
      ).rejects.toMatchObject({ code: "aider_no_match" });
      const denied = context();
      denied.capabilities.effective.aiderMatchers = [];
      await expect(adapter.prepare(denied)).rejects.toMatchObject({
        code: "aider_matcher_disabled",
      });
      expect(
        (
          await adapter.prepare({
            ...context(),
            aiderBlocks: [{ search: "", replace: " appended" }],
          })
        ).candidate,
      ).toContain(" appended");
    }
  });

  test("times out a stuck native worker without blocking the main event loop", async () => {
    const pool = new PatchPreparationPool({
      timeoutMs: 100,
      workerUrl: fixture("while (true) {}"),
    });
    let eventLoopResponded = false;
    const timer = setTimeout(() => {
      eventLoopResponded = true;
    }, 10);
    await expect(pool.prepare("aider_block", context())).rejects.toMatchObject({
      code: "patch_timeout",
    });
    expect(eventLoopResponded).toBe(true);
    clearTimeout(timer);
  });

  test("bounds queued work and observes queue and active cancellation", async () => {
    const pool = new PatchPreparationPool({
      maxWorkers: 1,
      maxPending: 2,
      workerUrl: fixture(""),
      timeoutMs: 1000,
    });
    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();
    const active = pool
      .prepare("aider_block", { ...context(), signal: activeAbort.signal })
      .catch((error: Error) => error);
    const queued = pool
      .prepare("aider_block", { ...context(), signal: queuedAbort.signal })
      .catch((error: Error) => error);
    await expect(pool.prepare("aider_block", context())).rejects.toMatchObject({
      code: "patch_queue_full",
    });
    queuedAbort.abort();
    activeAbort.abort();
    expect(await queued).toMatchObject({ code: "aborted" });
    expect(await active).toMatchObject({ code: "aborted" });
    await expect(
      pool.prepare("aider_block", {
        ...context(),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    await expect(
      new PatchPreparationPool({ maxBytes: 1 }).prepare(
        "aider_block",
        context(),
      ),
    ).rejects.toMatchObject({ code: "patch_queue_full" });
  });

  test("deadline includes queued time and a retired worker retains its capacity", async () => {
    const worker = new Worker(fixture(""));
    const terminate = worker.terminate.bind(worker);
    let retire!: (code: number) => void;
    worker.terminate = () =>
      new Promise<number>((resolve) => {
        retire = resolve;
      });
    const pool = new PatchPreparationPool({
      maxWorkers: 1,
      maxPending: 2,
      timeoutMs: 50,
      workerFactory: () => worker,
    });
    try {
      const results = await Promise.allSettled([
        pool.prepare("aider_block", context()),
        pool.prepare("aider_block", context()),
      ]);
      expect(
        results.every(
          (result) =>
            result.status === "rejected" &&
            result.reason.code === "patch_timeout",
        ),
      ).toBe(true);
      await expect(
        pool.prepare("aider_block", context()),
      ).rejects.toMatchObject({ code: "patch_timeout" });
      retire(0);
      await Bun.sleep(1);
    } finally {
      await terminate();
    }
  });

  test("settles startup, crash, exit, protocol, clone, and typed failures", async () => {
    for (const [body, code] of [
      ['throw new Error("crash")', "patch_worker_error"],
      ["process.exit(0)", "patch_worker_exit"],
      ["parentPort.postMessage(null)", "patch_worker_protocol"],
      [
        'parentPort.postMessage({ok:false,error:{name:"TypeError",message:"typed",code:"fixture"}})',
        "fixture",
      ],
    ]) {
      const pool = new PatchPreparationPool({
        workerUrl: fixture(body!),
        timeoutMs: 1000,
      });
      await expect(
        pool.prepare("aider_block", context()),
      ).rejects.toMatchObject({ code });
    }
    const startup = new PatchPreparationPool({
      workerUrl: new URL("https://invalid.test/worker.ts"),
    });
    await expect(
      startup.prepare("aider_block", context()),
    ).rejects.toMatchObject({ code: "patch_worker_start" });
    const clone = new PatchPreparationPool({ workerUrl: fixture(success) });
    await expect(
      clone.prepare("aider_block", {
        ...context(),
        mode: (() => {}) as unknown as number,
      }),
    ).rejects.toMatchObject({ code: "patch_worker_start" });
    const rejected = new PatchPreparationPool({
      workerUrl: fixture(
        'parentPort.postMessage({ok:false,error:{message:"generic",code:"generic"}});',
      ),
    });
    await expect(
      rejected.prepare("aider_block", context()),
    ).rejects.toMatchObject({ code: "generic" });
  });

  test("continues admission after ordinary worker retirement", async () => {
    const pool = new PatchPreparationPool({
      maxWorkers: 1,
      workerUrl: fixture(success),
    });
    expect(
      (
        await Promise.all([
          pool.prepare("aider_block", context()),
          pool.prepare("aider_block", context()),
        ])
      ).map((patch) => patch.candidate),
    ).toEqual(["const value = 1;", "const value = 1;"]);
  });
});

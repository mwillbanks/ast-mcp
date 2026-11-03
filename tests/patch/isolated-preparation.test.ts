import { beforeEach, describe, expect, test } from "bun:test";

import { PatchPreparationPool } from "../../src/patch/strategy/worker-client";
import { ControlledWorker } from "../support/controlled-worker";
import {
  createMockTime,
  flushMicrotasks,
  type MockTime,
} from "../support/mock-time";
import { patchContext as context } from "../support/patch-context";

let time: MockTime;
beforeEach(() => {
  time = createMockTime();
});
function success(message: any, worker: ControlledWorker) {
  worker.emit("message", {
    ok: true,
    patch: {
      candidate: message.context.original,
      metadata: { operations: 1, strategy: message.strategy },
    },
  });
}

describe("isolated patch preparation", () => {
  test("failed termination cannot free a quarantined worker slot", async () => {
    const worker = new ControlledWorker(success);
    worker.terminate = () => {
      worker.terminationRequested.resolve();
      return Promise.reject(new Error("termination failed"));
    };
    const pool = new PatchPreparationPool({
      maxWorkers: 1,
      maxPending: 1,
      timeoutMs: 200,
      workerFactory: () => worker.asWorker(),
    });
    expect((await pool.prepare("aider_block", context())).candidate).toBe(
      "const value = 1;",
    );
    await worker.terminationRequested.promise;
    await flushMicrotasks();
    await expect(pool.prepare("aider_block", context())).rejects.toMatchObject({
      code: "patch_queue_full",
    });
  });

  test("queued requests use their admitted snapshot", async () => {
    const pool = new PatchPreparationPool({
      maxWorkers: 1,
      workerFactory: () => new ControlledWorker(success).asWorker(),
    });
    const first = pool.prepare("aider_block", context());
    const mutable = context();
    const second = pool.prepare("aider_block", mutable);
    mutable.original = "changed after admission";
    expect((await second).candidate).toBe("const value = 1;");
    await first;
    await flushMicrotasks();
  });

  test("the active preparation deadline rejects at its exact boundary", async () => {
    const worker = new ControlledWorker();
    const pool = new PatchPreparationPool({
      timeoutMs: 100,
      workerFactory: () => worker.asWorker(),
    });
    let settled = false;
    const pending = pool.prepare("aider_block", context()).catch((error) => {
      settled = true;
      return error;
    });
    await worker.posted.promise;
    await time.advanceBy(99);
    expect(settled).toBe(false);
    await time.advanceBy(1);
    expect(await pending).toMatchObject({ code: "patch_timeout" });
    await worker.terminationRequested.promise;
    await flushMicrotasks();
  });

  test("bounds queued work and observes queue and active cancellation", async () => {
    const pool = new PatchPreparationPool({
      maxWorkers: 1,
      maxPending: 2,
      workerFactory: () => new ControlledWorker().asWorker(),
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

  test("deadline includes queued time and retirement retains capacity until confirmation", async () => {
    const worker = new ControlledWorker(undefined, false);
    let starts = 0;
    const pool = new PatchPreparationPool({
      maxWorkers: 1,
      maxPending: 2,
      timeoutMs: 50,
      workerFactory: () => {
        starts++;
        return starts === 1
          ? worker.asWorker()
          : new ControlledWorker(success).asWorker();
      },
    });
    const results = Promise.allSettled([
      pool.prepare("aider_block", context()),
      pool.prepare("aider_block", context()),
    ]);
    let settled = false;
    void results.then(() => {
      settled = true;
    });
    await time.advanceBy(49);
    expect(settled).toBe(false);
    await time.advanceBy(1);
    expect(
      (await results).every(
        (result) =>
          result.status === "rejected" &&
          result.reason.code === "patch_timeout",
      ),
    ).toBe(true);
    const queued = pool
      .prepare("aider_block", context())
      .catch((error) => error);
    await time.advanceBy(50);
    expect(await queued).toMatchObject({ code: "patch_timeout" });
    expect(starts).toBe(1);
    worker.retired.resolve(0);
    await flushMicrotasks();
    expect((await pool.prepare("aider_block", context())).candidate).toBe(
      "const value = 1;",
    );
    expect(starts).toBe(2);
    await flushMicrotasks();
  });

  test("settles startup, crash, exit, protocol, clone, and typed failures", async () => {
    for (const [respond, code] of [
      [
        (_message: unknown, worker: ControlledWorker) =>
          worker.emit("error", new Error("crash")),
        "patch_worker_error",
      ],
      [
        (_message: unknown, worker: ControlledWorker) => worker.emit("exit", 0),
        "patch_worker_exit",
      ],
      [
        (_message: unknown, worker: ControlledWorker) =>
          worker.emit("message", null),
        "patch_worker_protocol",
      ],
      [
        (_message: unknown, worker: ControlledWorker) =>
          worker.emit("message", {
            ok: false,
            error: { name: "TypeError", message: "typed", code: "fixture" },
          }),
        "fixture",
      ],
    ] as const) {
      const pool = new PatchPreparationPool({
        workerFactory: () => new ControlledWorker(respond).asWorker(),
      });
      await expect(
        pool.prepare("aider_block", context()),
      ).rejects.toMatchObject({ code });
    }
    const startup = new PatchPreparationPool({
      workerFactory: () => {
        throw new Error("construction failed");
      },
    });
    await expect(
      startup.prepare("aider_block", context()),
    ).rejects.toMatchObject({ code: "patch_worker_start" });
    const posting = new ControlledWorker();
    posting.postMessage = () => {
      throw new Error("posting failed");
    };
    await expect(
      new PatchPreparationPool({
        workerFactory: () => posting.asWorker(),
      }).prepare("aider_block", context()),
    ).rejects.toMatchObject({ code: "patch_worker_start" });
    const clone = new PatchPreparationPool({
      workerFactory: () => new ControlledWorker(success).asWorker(),
    });
    await expect(
      clone.prepare("aider_block", {
        ...context(),
        mode: (() => {}) as unknown as number,
      }),
    ).rejects.toMatchObject({ code: "patch_worker_start" });
    const rejected = new PatchPreparationPool({
      workerFactory: () =>
        new ControlledWorker((_message, worker) =>
          worker.emit("message", {
            ok: false,
            error: { message: "generic", code: "generic" },
          }),
        ).asWorker(),
    });
    await expect(
      rejected.prepare("aider_block", context()),
    ).rejects.toMatchObject({ code: "generic" });
    await flushMicrotasks();
  });

  test("continues admission after ordinary worker retirement", async () => {
    const pool = new PatchPreparationPool({
      maxWorkers: 1,
      workerFactory: () => new ControlledWorker(success).asWorker(),
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

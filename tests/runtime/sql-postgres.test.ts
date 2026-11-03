import { beforeEach, describe, expect, test } from "bun:test";

import { PostgresSqlAdapter } from "../../src/runtime/sql-postgres";
import { ControlledWorker } from "../support/controlled-worker";
import {
  createMockTime,
  flushMicrotasks,
  type MockTime,
} from "../support/mock-time";
import { sqlRequest as request } from "../support/sql-request";

const plpgsql =
  "CREATE FUNCTION f() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;";
const malformedBody =
  "CREATE FUNCTION f() RETURNS integer LANGUAGE plpgsql AS $$ BROKEN BODY $$;";
let time: MockTime;
beforeEach(() => {
  time = createMockTime();
});
function valid(_message: unknown, worker: ControlledWorker) {
  worker.emit("message", { status: "valid", complete: true, scope: "sql" });
}

describe("optional PostgreSQL adapter", () => {
  test("sanitizes and bounds worker diagnostics", async () => {
    const adapter = new PostgresSqlAdapter({
      workerFactory: () =>
        new ControlledWorker((message, worker) =>
          worker.emit("message", {
            status: "invalid",
            complete: true,
            scope: "sql",
            diagnostics: Array.from({ length: 30 }, () => ({
              message: message.source,
              line: 0,
              column: 2,
              offset: 4,
            })).concat([
              { message: "private", line: -1, column: NaN, offset: Infinity },
            ]),
          }),
        ).asWorker(),
    });
    const result = await adapter.validate(request("private SQL"));
    expect(result.diagnostics).toHaveLength(20);
    expect(result.diagnostics?.[0]).toEqual({
      message: "SQL syntax rejected by the selected validator",
      line: 0,
      column: 2,
      offset: 4,
    });
    expect(JSON.stringify(result)).not.toContain("private SQL");
    const invalid = new PostgresSqlAdapter({
      workerFactory: () =>
        new ControlledWorker((_message, worker) =>
          worker.emit("message", {
            status: "invalid",
            complete: true,
            scope: "sql",
            diagnostics: [{ line: -1, column: NaN, offset: Infinity }],
          }),
        ).asWorker(),
    });
    expect((await invalid.validate(request())).diagnostics).toEqual([
      { message: "SQL syntax rejected by the selected validator" },
    ]);
  });

  test("worker construction and posting failures recover capacity", async () => {
    for (const posting of [false, true]) {
      let first = true;
      const adapter = new PostgresSqlAdapter({
        workerFactory: () => {
          if (first && !posting) {
            first = false;
            throw new Error("construction failed");
          }
          const worker = new ControlledWorker(valid);
          if (first) {
            first = false;
            worker.postMessage = () => {
              throw new Error("posting failed");
            };
          }
          return worker.asWorker();
        },
      });
      expect(await adapter.validate(request())).toMatchObject({
        status: "unavailable",
      });
      expect(adapter.stats().pending).toBe(0);
      expect(await adapter.validate(request())).toMatchObject({
        status: "valid",
      });
    }
  });

  test("rejects unknown versions and variants without starting a worker", async () => {
    let starts = 0;
    const adapter = new PostgresSqlAdapter({
      workerFactory: () => {
        starts++;
        throw new Error("not needed");
      },
    });
    for (const extra of [
      { version: "17" },
      { variant: "pgvector" },
      { dialect: "mysql" },
    ]) {
      expect(await adapter.validate(request("SELECT 1;", extra))).toMatchObject(
        { status: "unsupported", complete: false },
      );
    }
    expect(starts).toBe(0);
  });

  test("procedural variants remain unsupported without a typed parser error channel", async () => {
    let starts = 0;
    const adapter = new PostgresSqlAdapter({
      workerFactory: () => {
        starts++;
        throw new Error("must not load");
      },
    });
    for (const source of [plpgsql, malformedBody, "SELECT 1;"]) {
      expect(
        await adapter.validate(request(source, { variant: "plpgsql" })),
      ).toMatchObject({ status: "unsupported", complete: false, scope: "sql" });
    }
    expect(starts).toBe(0);
  });

  test("bounds source bytes before worker admission", async () => {
    let starts = 0;
    const adapter = new PostgresSqlAdapter({
      maxSourceBytes: 2,
      workerFactory: () => {
        starts++;
        throw new Error("not needed");
      },
    });
    expect(await adapter.validate(request())).toMatchObject({
      status: "unavailable",
      complete: false,
    });
    expect(starts).toBe(0);
    expect(adapter.stats()).toEqual({
      pending: 0,
      active: 0,
      outstandingBytes: 0,
    });
  });

  test("bounds queued work and reclaims active and queued cancellation", async () => {
    const worker = new ControlledWorker();
    const adapter = new PostgresSqlAdapter({
      maxPending: 2,
      workerFactory: () => worker.asWorker(),
    });
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = adapter
      .validate(request("SELECT 1;", { signal: activeController.signal }))
      .catch((error) => error);
    await worker.posted.promise;
    const queued = adapter
      .validate(request("SELECT 2;", { signal: queuedController.signal }))
      .catch((error) => error);
    expect(await adapter.validate(request())).toMatchObject({
      status: "unavailable",
    });
    const reason = new Error("cancelled");
    queuedController.abort(reason);
    activeController.abort(reason);
    expect(await queued).toBe(reason);
    expect(await active).toBe(reason);
    expect(adapter.stats()).toEqual({
      pending: 0,
      active: 0,
      outstandingBytes: 0,
    });
  });

  test("active parsing expires at its deadline and recovers confirmed capacity", async () => {
    const worker = new ControlledWorker();
    let first = true;
    const adapter = new PostgresSqlAdapter({
      timeoutMs: 100,
      workerFactory: () => {
        if (first) {
          first = false;
          return worker.asWorker();
        }
        return new ControlledWorker(valid).asWorker();
      },
    });
    let settled = false;
    const pending = adapter.validate(request()).then((result) => {
      settled = true;
      return result;
    });
    await worker.posted.promise;
    await time.advanceBy(99);
    expect(settled).toBe(false);
    await time.advanceBy(1);
    expect(await pending).toMatchObject({ status: "unavailable" });
    await worker.terminationRequested.promise;
    expect(adapter.stats()).toEqual({
      pending: 0,
      active: 0,
      outstandingBytes: 0,
    });
    expect(await adapter.validate(request())).toMatchObject({
      status: "valid",
    });
  });

  test("queued deadlines and retirement budgets preserve unconfirmed capacity", async () => {
    const worker = new ControlledWorker(undefined, false);
    let starts = 0;
    const adapter = new PostgresSqlAdapter({
      maxPending: 2,
      timeoutMs: 20,
      workerFactory: () => {
        starts++;
        return worker.asWorker();
      },
    });
    let activeSettled = false;
    const active = adapter.validate(request()).then((result) => {
      activeSettled = true;
      return result;
    });
    const queued = adapter.validate(request("SELECT 2;"));
    expect(adapter.stats()).toEqual({
      pending: 2,
      active: 1,
      outstandingBytes: Buffer.byteLength("SELECT 1;SELECT 2;"),
    });
    await time.advanceBy(19);
    expect(activeSettled).toBe(false);
    await time.advanceBy(1);
    expect(await queued).toMatchObject({
      status: "unavailable",
      complete: false,
    });
    expect(activeSettled).toBe(false);
    await time.advanceBy(19);
    expect(activeSettled).toBe(false);
    await time.advanceBy(1);
    expect(await active).toMatchObject({
      status: "unavailable",
      complete: false,
    });
    expect(adapter.stats()).toEqual({
      pending: 1,
      active: 1,
      outstandingBytes: Buffer.byteLength("SELECT 1;"),
    });
    const blocked = adapter.validate(request());
    await time.advanceBy(20);
    expect(await blocked).toMatchObject({ status: "unavailable" });
    expect(starts).toBe(1);
    worker.emit("exit", 0);
    expect(adapter.stats()).toEqual({
      pending: 0,
      active: 0,
      outstandingBytes: 0,
    });
    worker.retired.resolve(0);
    await flushMicrotasks();
    expect(adapter.stats().active).toBe(0);
    expect(starts).toBe(1);
  });

  test("does not free a quarantined worker when termination fails", async () => {
    const worker = new ControlledWorker(valid);
    worker.terminate = () => Promise.reject(new Error("termination failed"));
    const adapter = new PostgresSqlAdapter({
      maxPending: 1,
      workerFactory: () => worker.asWorker(),
    });
    expect(await adapter.validate(request())).toMatchObject({
      status: "unavailable",
    });
    expect(await adapter.validate(request())).toMatchObject({
      status: "unavailable",
    });
    expect(adapter.stats().active).toBe(1);
    worker.emit("exit", 0);
    expect(adapter.stats()).toEqual({
      pending: 0,
      active: 0,
      outstandingBytes: 0,
    });
  });

  test("malformed worker responses and worker failures cannot claim validity", async () => {
    for (const respond of [
      (_message: unknown, worker: ControlledWorker) =>
        worker.emit("message", { status: "valid" }),
      (_message: unknown, worker: ControlledWorker) =>
        worker.emit("error", new Error("private SQL")),
      (_message: unknown, worker: ControlledWorker) => worker.emit("exit", 0),
    ]) {
      const adapter = new PostgresSqlAdapter({
        workerFactory: () => new ControlledWorker(respond).asWorker(),
      });
      expect(await adapter.validate(request())).toMatchObject({
        status: "unavailable",
        complete: false,
      });
      expect(adapter.stats()).toEqual({
        pending: 0,
        active: 0,
        outstandingBytes: 0,
      });
    }
  });

  test("cancellation and invalid resource options fail before work starts", async () => {
    const reason = new Error("cancelled");
    await expect(
      new PostgresSqlAdapter().validate(
        request("SELECT 1;", { signal: AbortSignal.abort(reason) }),
      ),
    ).rejects.toBe(reason);
    for (const options of [
      { maxPending: 0 },
      { maxSourceBytes: -1 },
      { timeoutMs: Number.NaN },
    ]) {
      expect(() => new PostgresSqlAdapter(options)).toThrow();
    }
  });
});

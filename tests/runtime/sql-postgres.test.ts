import { describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

import {
  evaluateSqlCandidate,
  type SqlAdapterRequest,
} from "../../src/runtime/sql-assistance";
import { PostgresSqlAdapter } from "../../src/runtime/sql-postgres";

const policy =
  "CREATE POLICY member_access ON public.members FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true)::uuid);";
const plpgsql =
  "CREATE FUNCTION f() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;";
const malformedBody =
  "CREATE FUNCTION f() RETURNS integer LANGUAGE plpgsql AS $$ BROKEN BODY $$;";

function request(
  source = "SELECT 1;",
  extra: Partial<SqlAdapterRequest> = {},
): SqlAdapterRequest {
  return {
    source,
    dialect: "postgresql",
    signal: new AbortController().signal,
    ...extra,
  };
}

function fixture(body: string): URL {
  return new URL(
    "data:text/javascript," +
      encodeURIComponent(
        'import { parentPort } from "node:worker_threads"; parentPort.once("message", request => {' +
          body +
          "});",
      ),
  );
}
const valid =
  'parentPort.postMessage({ status: "valid", complete: true, scope: "sql" });';

describe("optional PostgreSQL adapter", () => {
  test("accepts PostgreSQL policy grammar and rejects invalid SQL", async () => {
    const adapter = new PostgresSqlAdapter();
    expect(await adapter.validate(request(policy))).toMatchObject({
      status: "valid",
      complete: true,
      scope: "sql",
    });
    const invalid = await adapter.validate(request("SELECT FROM;"));
    expect(invalid).toMatchObject({
      status: "invalid",
      complete: true,
      scope: "sql",
    });
    expect(invalid.diagnostics).toHaveLength(1);
    expect(JSON.stringify(invalid)).not.toContain("SELECT FROM");
  });

  test("default registry validates real PostgreSQL candidates under required policy", async () => {
    for (const [source, allowed, status] of [
      [policy, true, "valid"],
      ["SELECT FROM;", false, "invalid"],
    ] as const) {
      expect(
        await evaluateSqlCandidate({
          source,
          options: { dialect: "postgresql", policy: "required" },
        }),
      ).toMatchObject({ allowed, validation: { status } });
    }
  });

  test("sanitizes and bounds worker diagnostics", async () => {
    const body =
      'parentPort.postMessage({ status: "invalid", complete: true, scope: "sql", diagnostics: Array.from({length: 30}, () => ({message: request.source, line: 0, column: 2, offset: 4})).concat([{line:-1,column:NaN,offset:Infinity}]) });';
    const adapter = new PostgresSqlAdapter({ workerUrl: fixture(body) });
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
      workerUrl: fixture(
        'parentPort.postMessage({ status: "invalid", complete: true, scope: "sql", diagnostics: [{line:-1,column:NaN,offset:Infinity}] });',
      ),
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
          const worker = new Worker(fixture(valid));
          if (first) {
            first = false;
            worker.postMessage = () => {
              throw new Error("posting failed");
            };
          }
          return worker;
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

  test("raw SQL validation does not certify function bodies", async () => {
    const adapter = new PostgresSqlAdapter();
    for (const source of [
      plpgsql,
      malformedBody,
      "DO $$ BEGIN NULL; END $$;",
    ]) {
      expect(await adapter.validate(request(source))).toMatchObject({
        status: "unsupported",
        complete: false,
        scope: "sql",
      });
    }
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

  test("diagnostic locations convert Unicode character positions to UTF-8 bytes", async () => {
    const adapter = new PostgresSqlAdapter();
    for (const prefix of [
      "SELECT '☃';\n",
      "SELECT '😀';\n",
      "SELECT '😀☃';\r\n",
    ]) {
      for (const invalid of ["SELECT FROM;", "SELECT FROM"]) {
        const source = prefix + invalid;
        const result = await adapter.validate(request(source));
        const expectedPrefix =
          prefix + (invalid.endsWith(";") ? "SELECT FROM" : invalid);
        expect(result).toMatchObject({ status: "invalid", complete: true });
        expect(result.diagnostics?.[0]).toMatchObject({
          line: 1,
          column: Array.from(invalid.endsWith(";") ? "SELECT FROM" : invalid)
            .length,
          offset: Buffer.byteLength(expectedPrefix),
        });
      }
    }
  });

  test("handles empty SQL and Unicode without exposing source in diagnostics", async () => {
    const adapter = new PostgresSqlAdapter();
    expect(await adapter.validate(request(""))).toMatchObject({
      status: "unavailable",
      complete: false,
    });
    expect(
      await adapter.validate(request("SELECT '☃';\nSELECT FROM;")),
    ).toMatchObject({ status: "invalid" });
    const result = await adapter.validate(
      request("SELECT 'secret_value';\nSELECT FROM;"),
    );
    expect(JSON.stringify(result)).not.toContain("secret_value");
    expect(result.diagnostics?.[0]?.line).toBe(1);
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
    let started!: () => void;
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapter = new PostgresSqlAdapter({
      maxPending: 2,
      workerFactory: (url) => {
        const worker = new Worker(url);
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (...args) => {
          post(...args);
          started();
        };
        return worker;
      },
      workerUrl: fixture(""),
    });
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = adapter
      .validate(request("SELECT 1;", { signal: activeController.signal }))
      .catch((e: unknown) => e);
    await admitted;
    const queued = adapter
      .validate(request("SELECT 2;", { signal: queuedController.signal }))
      .catch((e: unknown) => e);
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

  test("terminates stuck parsing and recovers capacity", async () => {
    const workers: Worker[] = [];
    let first = true;
    const adapter = new PostgresSqlAdapter({
      timeoutMs: 100,
      workerFactory: () => {
        const worker = new Worker(fixture(first ? "while (true) {}" : valid));
        first = false;
        workers.push(worker);
        return worker;
      },
    });
    try {
      let responsive = false;
      const timer = setTimeout(() => {
        responsive = true;
      }, 10);
      expect(await adapter.validate(request())).toMatchObject({
        status: "unavailable",
      });
      clearTimeout(timer);
      expect(responsive).toBeTrue();
      expect(adapter.stats()).toEqual({
        pending: 0,
        active: 0,
        outstandingBytes: 0,
      });
      expect(await adapter.validate(request())).toMatchObject({
        status: "valid",
      });
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  });

  test("expires queued work without starting it while live worker retirement is unconfirmed", async () => {
    const worker = new Worker(fixture("while (true) {}"));
    const terminate = worker.terminate.bind(worker);
    let confirm!: (code: number) => void;
    const confirmation = new Promise<number>((resolve) => {
      confirm = resolve;
    });
    worker.terminate = () => confirmation;
    let starts = 0;
    const adapter = new PostgresSqlAdapter({
      maxPending: 2,
      timeoutMs: 20,
      workerFactory: () => {
        starts++;
        return worker;
      },
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const active = adapter.validate(request());
      const queued = adapter.validate(request("SELECT 2;"));
      expect(adapter.stats()).toEqual({
        pending: 2,
        active: 1,
        outstandingBytes: Buffer.byteLength("SELECT 1;SELECT 2;"),
      });
      const result = await Promise.race([
        active,
        new Promise<"deadline">((resolve) => {
          deadline = setTimeout(() => resolve("deadline"), 1000);
        }),
      ]);
      expect(result).toMatchObject({ status: "unavailable", complete: false });
      expect(await queued).toMatchObject({
        status: "unavailable",
        complete: false,
      });
      expect(starts).toBe(1);
      expect(adapter.stats()).toEqual({
        pending: 1,
        active: 1,
        outstandingBytes: Buffer.byteLength("SELECT 1;"),
      });
      expect(await adapter.validate(request())).toMatchObject({
        status: "unavailable",
      });
      expect(starts).toBe(1);
    } finally {
      clearTimeout(deadline);
      const exitCode = await terminate();
      expect(adapter.stats()).toEqual({
        pending: 0,
        active: 0,
        outstandingBytes: 0,
      });
      confirm(exitCode);
      await confirmation;
      await Promise.resolve();
      expect(adapter.stats().active).toBe(0);
      expect(starts).toBe(1);
    }
  });

  test("does not free a quarantined worker when termination fails", async () => {
    const worker = new Worker(fixture(valid));
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => Promise.reject(new Error("termination failed"));
    const adapter = new PostgresSqlAdapter({
      maxPending: 1,
      workerFactory: () => worker,
    });
    try {
      expect(await adapter.validate(request())).toMatchObject({
        status: "unavailable",
      });
      expect(await adapter.validate(request())).toMatchObject({
        status: "unavailable",
      });
      expect(adapter.stats().active).toBe(1);
    } finally {
      await terminate();
      expect(adapter.stats()).toEqual({
        pending: 0,
        active: 0,
        outstandingBytes: 0,
      });
    }
  });

  test("malformed worker responses and worker failures cannot claim validity", async () => {
    for (const body of [
      'parentPort.postMessage({ status: "valid" });',
      'throw new Error("private SQL");',
      "parentPort.close();",
    ]) {
      const adapter = new PostgresSqlAdapter({ workerUrl: fixture(body) });
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

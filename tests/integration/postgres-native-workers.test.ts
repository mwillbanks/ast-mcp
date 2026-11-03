import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";

import { evaluateSqlCandidate } from "../../src/runtime/sql-assistance";
import { PostgresSqlAdapter } from "../../src/runtime/sql-postgres";
import { sqlRequest as request } from "../support/sql-request";

const policy =
  "CREATE POLICY member_access ON public.members FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true)::uuid);";
const plpgsql =
  "CREATE FUNCTION f() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;";
const malformedBody =
  "CREATE FUNCTION f() RETURNS integer LANGUAGE plpgsql AS $$ BROKEN BODY $$;";

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

describe("native PostgreSQL worker integration", () => {
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
  test("terminates a stuck parser and recovers native worker capacity", async () => {
    const stuck = new Worker(fixture("while (true) {}"));
    const workers = [stuck];
    let first = true;
    try {
      await once(stuck, "online");
      const adapter = new PostgresSqlAdapter({
        timeoutMs: 100,
        workerFactory: () => {
          if (first) {
            first = false;
            return stuck;
          }
          const worker = new Worker(fixture(valid));
          workers.push(worker);
          return worker;
        },
      });
      const pending = adapter.validate(request());
      expect(await Promise.resolve("responsive")).toBe("responsive");
      expect(await pending).toMatchObject({ status: "unavailable" });
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
});

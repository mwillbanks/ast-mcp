import { describe, expect, test } from "bun:test";

import {
  decideSqlPatch,
  type SqlValidationEvidence,
  evaluateSqlCandidate,
  resolveSqlAssistanceOptions,
  SqlAdapterRegistry,
  type SqlAdapterResult,
} from "../../src/runtime/sql-assistance";

function fixture(result: SqlAdapterResult) {
  const calls: string[] = [];
  const registry = new SqlAdapterRegistry();
  registry.register("postgresql", async () => {
    calls.push("load");
    return {
      id: "fixture-postgres",
      version: "18.0",
      async validate(request) {
        calls.push(request.source);
        return result;
      },
    };
  });
  return { calls, registry };
}

describe("optional SQL assistance", () => {
  test("default SQL patches do not initialize a configured dialect", async () => {
    const { calls, registry } = fixture({
      status: "valid",
      complete: true,
      scope: "sql",
    });
    const decision = await evaluateSqlCandidate({
      source: "CREATE POLICY member_access ON members USING (true);",
      defaults: { dialect: "postgresql", policy: "advisory" },
      registry,
    });
    expect(decision.allowed).toBeTrue();
    expect(decision.validation.status).toBe("not_requested");
    expect(calls).toEqual([]);
  });

  test("configured skip does not attribute an override to the operation", async () => {
    const { calls, registry } = fixture({
      status: "valid",
      complete: true,
      scope: "sql",
    });
    const decision = await evaluateSqlCandidate({
      source: "SELECT 1;",
      defaults: { policy: "skip", dialect: "postgresql" },
      registry,
    });
    expect(decision).toMatchObject({
      allowed: true,
      policy: "skip",
      overridden: false,
      validation: { status: "skipped" },
    });
    expect(calls).toEqual([]);
  });

  test("an operation override skips configured required validation", async () => {
    const { calls, registry } = fixture({
      status: "invalid",
      complete: true,
      scope: "sql",
    });
    const decision = await evaluateSqlCandidate({
      source: "extension specific SQL",
      defaults: { dialect: "postgresql", policy: "required" },
      options: { policy: "skip" },
      registry,
    });
    expect(decision).toMatchObject({
      allowed: true,
      policy: "skip",
      overridden: true,
      validation: { status: "skipped" },
    });
    expect(calls).toEqual([]);
  });

  for (const status of [
    "valid",
    "invalid",
    "unsupported",
    "unavailable",
  ] as const) {
    test(`advisory ${status} keeps guarded patching available`, async () => {
      const { registry } = fixture({
        status,
        complete: status === "valid" || status === "invalid",
        scope: "sql",
      });
      const decision = await evaluateSqlCandidate({
        source: "SELECT 1;",
        options: { dialect: "postgresql" },
        registry,
      });
      expect(decision.allowed).toBeTrue();
      expect(decision.validation.status).toBe(status);
    });

    test(`required ${status} uses validation evidence`, async () => {
      const { registry } = fixture({
        status,
        complete: status === "valid" || status === "invalid",
        scope: "sql",
      });
      const decision = await evaluateSqlCandidate({
        source: "SELECT 1;",
        defaults: { dialect: "postgresql", policy: "required" },
        registry,
      });
      expect(decision.allowed).toBe(status === "valid");
      expect(decision.validation.status).toBe(status);
    });
  }

  test("request policy outranks configured required policy", async () => {
    const { registry } = fixture({
      status: "invalid",
      complete: true,
      scope: "sql",
    });
    const decision = await evaluateSqlCandidate({
      source: "extension SQL",
      defaults: { dialect: "postgresql", policy: "required" },
      options: { policy: "advisory" },
      registry,
    });
    expect(decision.allowed).toBeTrue();
    expect(decision.validation.status).toBe("invalid");
  });

  test("a missing adapter reports unsupported instead of claiming validity", async () => {
    for (const policy of ["advisory", "required"] as const) {
      const decision = await evaluateSqlCandidate({
        source: "SELECT custom_extension();",
        options: { dialect: "oracle", policy },
      });
      expect(decision.allowed).toBe(policy === "advisory");
      expect(decision.validation).toMatchObject({
        status: "unsupported",
        reason: "adapter_not_available",
      });
    }
    const noDialect = await evaluateSqlCandidate({
      source: "SELECT 1;",
      options: { policy: "required" },
    });
    expect(noDialect.allowed).toBeFalse();
    expect(noDialect.validation).toMatchObject({
      status: "unsupported",
      reason: "dialect_not_selected",
    });
  });

  test("resolved selection is immutable and changes when policy or variant changes", () => {
    const defaults = {
      policy: "required" as const,
      dialect: "postgresql",
      version: "18",
    };
    const resolved = resolveSqlAssistanceOptions(
      { policy: "skip", variant: "extension" },
      defaults,
    );
    defaults.version = "17";
    expect(resolved).toMatchObject({
      policy: "skip",
      dialect: "postgresql",
      version: "18",
      variant: "extension",
      overridden: true,
    });
    expect(Object.isFrozen(resolved)).toBeTrue();
    expect(resolved).not.toEqual(
      resolveSqlAssistanceOptions(
        { policy: "required", variant: "extension" },
        defaults,
      ),
    );
    expect(() =>
      resolveSqlAssistanceOptions({ dialect: "../private.sql" }),
    ).toThrow();
  });

  test("request selection reaches the adapter without loading unrelated dialects", async () => {
    const seen: unknown[] = [];
    const registry = new SqlAdapterRegistry();
    registry.register("mysql", async () => {
      throw new Error("must not initialize");
    });
    registry.register("postgresql", async () => ({
      id: "postgres",
      version: "18.0",
      async validate(request) {
        seen.push({ ...request, signal: undefined });
        return { status: "valid", complete: true, scope: "sql-and-procedural" };
      },
    }));
    const decision = await evaluateSqlCandidate({
      source: "SELECT 1;",
      defaults: { dialect: "mysql" },
      options: { dialect: "PostgreSQL", version: "18", variant: "pgvector" },
      registry,
    });
    expect(seen).toEqual([
      {
        source: "SELECT 1;",
        dialect: "postgresql",
        version: "18",
        variant: "pgvector",
        signal: undefined,
      },
    ]);
    expect(decision.validation).toMatchObject({
      status: "valid",
      scope: "sql-and-procedural",
      validator: { id: "postgres", version: "18.0" },
    });
    expect(() =>
      registry.register("postgresql", async () => {
        throw new Error("duplicate");
      }),
    ).toThrow();
  });

  test("incomplete success cannot satisfy required validation", async () => {
    const { registry } = fixture({
      status: "valid",
      complete: false,
      scope: "sql",
    });
    const decision = await evaluateSqlCandidate({
      source: "SELECT 1;",
      options: { policy: "required", dialect: "postgresql" },
      registry,
    });
    expect(decision.allowed).toBeFalse();
    expect(decision.validation).toMatchObject({
      status: "unsupported",
      reason: "incomplete_validation",
    });
  });

  test("adapter errors cannot disclose SQL or private paths", async () => {
    const registry = new SqlAdapterRegistry();
    registry.register("postgresql", async () => {
      throw new Error("/private/project.sql contains SELECT secret_token;");
    });
    const decision = await evaluateSqlCandidate({
      source: "SELECT secret_token;",
      options: { dialect: "postgresql" },
      registry,
    });
    expect(decision.allowed).toBeTrue();
    expect(decision.validation).toMatchObject({
      status: "unavailable",
      reason: "adapter_load_failed",
    });
    expect(JSON.stringify(decision)).not.toContain("secret_token");
    expect(JSON.stringify(decision)).not.toContain("/private");
  });

  test("invalid adapter payloads remain unavailable and diagnostics are bounded", async () => {
    const malformed = fixture({
      status: "mystery",
    } as unknown as SqlAdapterResult);
    expect(
      (
        await evaluateSqlCandidate({
          source: "SELECT 1;",
          options: { dialect: "postgresql" },
          registry: malformed.registry,
        })
      ).validation,
    ).toMatchObject({ status: "unavailable", reason: "malformed_result" });
    const unsafe = fixture({
      status: "invalid",
      complete: true,
      scope: "sql",
      diagnostics: Array.from({ length: 100 }, () => ({
        message: "SELECT secret_token; /private/project.sql",
        line: 2,
        column: 8,
      })),
    });
    const decision = await evaluateSqlCandidate({
      source: "SELECT secret_token;",
      options: { dialect: "postgresql" },
      registry: unsafe.registry,
    });
    expect(decision.validation.diagnostics?.length).toBeLessThanOrEqual(20);
    expect(decision.validation.diagnostics?.[0]).toMatchObject({
      line: 2,
      column: 8,
    });
    expect(JSON.stringify(decision)).not.toContain("secret_token");
    expect(JSON.stringify(decision)).not.toContain("/private");
  });

  test("caller cancellation never becomes an advisory result", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const { calls, registry } = fixture({
      status: "valid",
      complete: true,
      scope: "sql",
    });
    controller.abort(reason);
    await expect(
      evaluateSqlCandidate({
        source: "SELECT 1;",
        signal: controller.signal,
        registry,
      }),
    ).rejects.toBe(reason);
    expect(calls).toEqual([]);

    const active = new AbortController();
    const activeRegistry = new SqlAdapterRegistry();
    activeRegistry.register("postgresql", async () => ({
      id: "postgres",
      version: "18",
      async validate() {
        active.abort(reason);
        throw reason;
      },
    }));
    await expect(
      evaluateSqlCandidate({
        source: "SELECT 1;",
        options: { dialect: "postgresql" },
        signal: active.signal,
        registry: activeRegistry,
      }),
    ).rejects.toBe(reason);
  });

  test("deadline aborts cooperative work and reports unavailability", async () => {
    let stopped = false;
    const registry = new SqlAdapterRegistry();
    registry.register(
      "postgresql",
      async (signal) =>
        await new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              stopped = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const decision = await evaluateSqlCandidate({
      source: "SELECT 1;",
      options: { dialect: "postgresql" },
      registry,
      timeoutMs: 5,
    });
    expect(stopped).toBeTrue();
    expect(decision).toMatchObject({
      allowed: true,
      validation: { status: "unavailable", reason: "timeout" },
    });
  });

  test("unsupported diagnostics retain safe locations without private text", async () => {
    const { registry } = fixture({
      status: "unsupported",
      complete: false,
      scope: "sql",
      diagnostics: [
        {
          message: "/private/query.sql",
          line: -1,
          column: Number.NaN,
          offset: 7,
        },
        { line: 2, column: 1.5, offset: Number.POSITIVE_INFINITY },
        null as unknown as { message: string },
      ],
    });
    const decision = await evaluateSqlCandidate({
      source: "extension SQL",
      options: { dialect: "postgresql" },
      registry,
    });
    expect(decision.validation).toMatchObject({
      status: "unsupported",
      reason: "unsupported_syntax",
    });
    expect(decision.validation.diagnostics).toEqual([
      {
        message: "SQL validation coverage is incomplete",
        line: undefined,
        column: undefined,
        offset: 7,
      },
      {
        message: "SQL validation coverage is incomplete",
        line: 2,
        column: undefined,
        offset: undefined,
      },
    ]);
  });

  test("parser execution failures remain distinct from syntax rejection", async () => {
    const registry = new SqlAdapterRegistry();
    registry.register("postgresql", async () => ({
      id: "postgres",
      version: "18",
      async validate() {
        throw new Error("/private/query.sql");
      },
    }));
    const decision = await evaluateSqlCandidate({
      source: "SELECT 1;",
      options: { dialect: "postgresql", policy: "required" },
      registry,
    });
    expect(decision).toMatchObject({
      allowed: false,
      validation: { status: "unavailable", reason: "adapter_failed" },
    });
    expect(JSON.stringify(decision)).not.toContain("/private");
  });

  test("untrusted adapter shapes cannot claim valid syntax", async () => {
    for (const raw of [
      null,
      { status: "valid", complete: true, scope: "unknown" },
      { status: "valid", scope: "sql" },
      {
        status: "valid",
        complete: true,
        scope: "sql",
        diagnostics: "private source",
      },
    ]) {
      const { registry } = fixture(raw as unknown as SqlAdapterResult);
      const decision = await evaluateSqlCandidate({
        source: "SELECT 1;",
        options: { dialect: "postgresql", policy: "required" },
        registry,
      });
      expect(decision).toMatchObject({
        allowed: false,
        validation: { status: "unavailable", reason: "malformed_result" },
      });
    }
    const registry = new SqlAdapterRegistry();
    registry.register("postgresql", async () => ({
      id: "/private/validator",
      version: "18",
      async validate() {
        return { status: "valid", complete: true, scope: "sql" };
      },
    }));
    expect(
      (
        await evaluateSqlCandidate({
          source: "SELECT 1;",
          options: { dialect: "postgresql" },
          registry,
        })
      ).validation,
    ).toMatchObject({ status: "unavailable", reason: "malformed_result" });
  });

  test("resource limits and selectors reject invalid caller values", async () => {
    for (const limits of [
      { timeoutMs: 0 },
      { timeoutMs: 120001 },
      { maxSourceBytes: 0 },
    ]) {
      await expect(
        evaluateSqlCandidate({
          source: "SELECT 1;",
          options: { dialect: "postgresql" },
          ...limits,
        }),
      ).rejects.toThrow("resource limit");
    }
    for (const options of [
      { policy: "unknown" },
      { dialect: "x".repeat(129) },
      { variant: "/private" },
      { version: "18 /private" },
    ]) {
      expect(() =>
        resolveSqlAssistanceOptions(
          options as Parameters<typeof resolveSqlAssistanceOptions>[0],
        ),
      ).toThrow();
    }
  });

  test("validation evidence cannot authorize a different SQL selection", () => {
    const options = resolveSqlAssistanceOptions({
      policy: "required",
      dialect: "postgresql",
      version: "18",
      variant: "pgvector",
    });
    const matching: SqlValidationEvidence = {
      status: "valid",
      complete: true,
      dialect: "postgresql",
      version: "18",
      variant: "pgvector",
      validator: { id: "postgres", version: "18.0" },
      scope: "sql",
    };
    expect(decideSqlPatch(options, matching).allowed).toBeTrue();
    for (const different of [
      { dialect: "mysql" },
      { version: "17" },
      { variant: "plpgsql" },
      { dialect: undefined },
    ]) {
      const rejected = decideSqlPatch(options, { ...matching, ...different });
      expect(rejected.allowed).toBeFalse();
      expect(rejected.validation).toMatchObject({
        status: "unsupported",
        reason: "selection_mismatch",
      });
    }
    const advisory = decideSqlPatch(
      resolveSqlAssistanceOptions({ dialect: "mysql" }),
      matching,
    );
    expect(advisory.allowed).toBeTrue();
    expect(advisory.validation).toMatchObject({
      status: "unsupported",
      reason: "selection_mismatch",
    });
  });

  test("changing dialect clears incompatible inherited version and variant", () => {
    const defaults = { dialect: "mysql", version: "8", variant: "mariadb" };
    expect(
      resolveSqlAssistanceOptions({ dialect: "postgresql" }, defaults),
    ).toMatchObject({
      dialect: "postgresql",
      version: undefined,
      variant: undefined,
    });
    expect(
      resolveSqlAssistanceOptions({ dialect: "MySQL" }, defaults),
    ).toMatchObject({
      dialect: "mysql",
      version: "8",
      variant: "mariadb",
    });
    expect(
      resolveSqlAssistanceOptions(
        { dialect: "postgresql", version: "18", variant: "pgvector" },
        defaults,
      ),
    ).toMatchObject({
      dialect: "postgresql",
      version: "18",
      variant: "pgvector",
    });
  });

  test("selector limits apply after normalization", () => {
    const padded = " ".repeat(128) + "PostgreSQL" + " ".repeat(128);
    expect(resolveSqlAssistanceOptions({ dialect: padded }).dialect).toBe(
      "postgresql",
    );
  });

  test("input limits do not load parsers and remain policy-specific", async () => {
    const { calls, registry } = fixture({
      status: "valid",
      complete: true,
      scope: "sql",
    });
    const decision = await evaluateSqlCandidate({
      source: "SELECT 1;",
      options: { policy: "required", dialect: "postgresql" },
      registry,
      maxSourceBytes: 2,
    });
    expect(decision).toMatchObject({
      allowed: false,
      validation: { status: "unavailable", reason: "input_limit" },
    });
    expect(calls).toEqual([]);
  });
});

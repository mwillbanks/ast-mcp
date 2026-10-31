export type SqlValidationPolicy = "advisory" | "required" | "skip";

export interface SqlAssistanceOptions {
  policy?: SqlValidationPolicy;
  dialect?: string;
  version?: string;
  variant?: string;
}

export interface ResolvedSqlAssistanceOptions {
  readonly policy: SqlValidationPolicy;
  readonly dialect?: string;
  readonly version?: string;
  readonly variant?: string;
  readonly requested: boolean;
  readonly overridden: boolean;
}

export type SqlValidationScope = "sql" | "sql-and-procedural";

export interface SqlDiagnostic {
  message: string;
  line?: number;
  column?: number;
  offset?: number;
}

export interface SqlValidatorIdentity {
  id: string;
  version: string;
}

export type SqlValidationReason =
  | "dialect_not_selected"
  | "selection_mismatch"
  | "adapter_not_available"
  | "unsupported_syntax"
  | "incomplete_validation"
  | "adapter_load_failed"
  | "adapter_failed"
  | "malformed_result"
  | "input_limit"
  | "timeout";

interface SqlEvidenceDetails {
  dialect?: string;
  version?: string;
  variant?: string;
  diagnostics?: SqlDiagnostic[];
  validator?: SqlValidatorIdentity;
  scope?: SqlValidationScope;
}

export type SqlValidationEvidence = SqlEvidenceDetails &
  (
    | { status: "not_requested" | "skipped"; complete: false }
    | { status: "valid" | "invalid"; complete: true }
    | {
        status: "unsupported" | "unavailable";
        complete: false;
        reason: SqlValidationReason;
      }
  );

export interface SqlPatchDecision {
  allowed: boolean;
  policy: SqlValidationPolicy;
  overridden: boolean;
  validation: SqlValidationEvidence;
}

export interface SqlAdapterResult {
  status: "valid" | "invalid" | "unsupported" | "unavailable";
  complete: boolean;
  scope: SqlValidationScope;
  diagnostics?: Array<{
    message?: string;
    line?: number;
    column?: number;
    offset?: number;
  }>;
}

export interface SqlAdapterRequest {
  source: string;
  dialect: string;
  version?: string;
  variant?: string;
  signal: AbortSignal;
}

/** Adapters must stop their worker or other owned work when the signal aborts. */
export interface SqlAdapter {
  id: string;
  version: string;
  validate(request: SqlAdapterRequest): Promise<SqlAdapterResult>;
}

export type SqlAdapterLoader = (signal: AbortSignal) => Promise<SqlAdapter>;

export const SQL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
export const SQL_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.+-]*$/;
export const SQL_SELECTOR_MAX_LENGTH = 128;
const MAX_DIAGNOSTICS = 20;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const TIMEOUT = Symbol("sql-assistance-timeout");

function selector(
  value: string | undefined,
  version = false,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim().length > SQL_SELECTOR_MAX_LENGTH ||
    !(version ? SQL_VERSION_PATTERN : SQL_NAME_PATTERN).test(value.trim())
  )
    throw new TypeError("Invalid SQL assistance selector");
  return version ? value.trim() : value.trim().toLowerCase();
}

export function resolveSqlAssistanceOptions(
  options: SqlAssistanceOptions = {},
  defaults: SqlAssistanceOptions = {},
): Readonly<ResolvedSqlAssistanceOptions> {
  const policy = options.policy ?? defaults.policy ?? "advisory";
  if (!["advisory", "required", "skip"].includes(policy))
    throw new TypeError("Invalid SQL validation policy");
  const dialect = selector(options.dialect ?? defaults.dialect);
  const changedDialect =
    options.dialect !== undefined && dialect !== selector(defaults.dialect);
  return Object.freeze({
    policy,
    dialect,
    version: selector(
      options.version ?? (changedDialect ? undefined : defaults.version),
      true,
    ),
    variant: selector(
      options.variant ?? (changedDialect ? undefined : defaults.variant),
    ),
    requested:
      policy === "required" ||
      options.policy !== undefined ||
      options.dialect !== undefined ||
      options.version !== undefined ||
      options.variant !== undefined,
    overridden:
      options.policy === "skip" ||
      (defaults.policy === "required" && options.policy === "advisory"),
  });
}

export function mergeSqlAssistanceDefaults(
  incoming: SqlAssistanceOptions = {},
  previous: SqlAssistanceOptions = {},
): SqlAssistanceOptions {
  const resolved = resolveSqlAssistanceOptions(incoming, previous);
  return Object.fromEntries(
    Object.entries({
      policy: incoming.policy ?? previous.policy,
      dialect: resolved.dialect,
      variant: resolved.variant,
      version: resolved.version,
    }).filter(([, value]) => value !== undefined),
  ) as SqlAssistanceOptions;
}

/** Stores factories only. Selection and unrequested edits never initialize adapters. */
export class SqlAdapterRegistry {
  readonly #loaders = new Map<string, SqlAdapterLoader>();

  register(dialect: string, load: SqlAdapterLoader): void {
    const key = selector(dialect)!;
    if (this.#loaders.has(key))
      throw new TypeError("SQL dialect adapter is already registered");
    this.#loaders.set(key, load);
  }

  loader(dialect: string): SqlAdapterLoader | undefined {
    return this.#loaders.get(dialect);
  }
}

export const sqlAdapterRegistry = new SqlAdapterRegistry();
sqlAdapterRegistry.register("postgresql", async () =>
  (await import("./sql-postgres")).loadPostgresSqlAdapter(),
);

export function decideSqlPatch(
  options: ResolvedSqlAssistanceOptions,
  validation: SqlValidationEvidence,
): SqlPatchDecision {
  if (
    validation.dialect !== options.dialect ||
    validation.version !== options.version ||
    validation.variant !== options.variant
  )
    validation = {
      ...selected(options),
      status: "unsupported",
      complete: false,
      reason: "selection_mismatch",
    };
  return {
    allowed: options.policy !== "required" || validation.status === "valid",
    policy: options.policy,
    overridden: options.overridden,
    validation,
  };
}

function selected(options: ResolvedSqlAssistanceOptions): SqlEvidenceDetails {
  return {
    dialect: options.dialect,
    version: options.version,
    variant: options.variant,
  };
}

function unavailable(
  options: ResolvedSqlAssistanceOptions,
  reason: SqlValidationReason,
): SqlValidationEvidence {
  return {
    ...selected(options),
    status: "unavailable",
    complete: false,
    reason,
  };
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function location(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function evidence(
  raw: unknown,
  adapter: SqlValidatorIdentity,
  options: ResolvedSqlAssistanceOptions,
): SqlValidationEvidence {
  if (
    !record(raw) ||
    !["valid", "invalid", "unsupported", "unavailable"].includes(
      raw.status as string,
    ) ||
    typeof raw.complete !== "boolean" ||
    !["sql", "sql-and-procedural"].includes(raw.scope as string) ||
    (raw.diagnostics !== undefined && !Array.isArray(raw.diagnostics))
  )
    return unavailable(options, "malformed_result");

  const details: SqlEvidenceDetails = {
    ...selected(options),
    validator: { id: adapter.id, version: adapter.version },
    scope: raw.scope as SqlValidationScope,
  };
  if (raw.diagnostics) {
    details.diagnostics = (raw.diagnostics as unknown[])
      .slice(0, MAX_DIAGNOSTICS)
      .filter(record)
      .map((diagnostic) => ({
        message:
          raw.status === "invalid"
            ? "SQL syntax rejected by the selected validator"
            : "SQL validation coverage is incomplete",
        line: location(diagnostic.line),
        column: location(diagnostic.column),
        offset: location(diagnostic.offset),
      }));
  }
  if (
    raw.status === "unsupported" ||
    ((raw.status === "valid" || raw.status === "invalid") && !raw.complete)
  )
    return {
      ...details,
      status: "unsupported",
      complete: false,
      reason:
        raw.status === "unsupported"
          ? "unsupported_syntax"
          : "incomplete_validation",
    };
  if (raw.status === "unavailable")
    return {
      ...details,
      status: "unavailable",
      complete: false,
      reason: "adapter_failed",
    };
  return {
    ...details,
    status: raw.status as "valid" | "invalid",
    complete: true,
  };
}

async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  caller?: AbortSignal,
): Promise<T> {
  caller?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(caller?.reason);
  caller?.addEventListener("abort", cancel, { once: true });
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  const deadline = setTimeout(() => controller.abort(TIMEOUT), timeoutMs);
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      interrupted,
    ]);
  } finally {
    clearTimeout(deadline);
    caller?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", abort);
  }
}

export async function evaluateSqlCandidate(request: {
  source: string;
  options?: SqlAssistanceOptions;
  defaults?: SqlAssistanceOptions;
  registry?: SqlAdapterRegistry;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxSourceBytes?: number;
}): Promise<SqlPatchDecision> {
  request.signal?.throwIfAborted();
  const options = resolveSqlAssistanceOptions(
    request.options,
    request.defaults,
  );
  const decide = (validation: SqlValidationEvidence) =>
    decideSqlPatch(options, validation);
  if (options.policy === "skip")
    return decide({ ...selected(options), status: "skipped", complete: false });
  if (!options.requested)
    return decide({
      ...selected(options),
      status: "not_requested",
      complete: false,
    });
  if (!options.dialect)
    return decide({
      ...selected(options),
      status: "unsupported",
      complete: false,
      reason: "dialect_not_selected",
    });

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSourceBytes = request.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  if (
    !positiveInteger(timeoutMs) ||
    timeoutMs > MAX_TIMEOUT_MS ||
    !positiveInteger(maxSourceBytes)
  )
    throw new TypeError("Invalid SQL assistance resource limit");
  if (Buffer.byteLength(request.source) > maxSourceBytes)
    return decide(unavailable(options, "input_limit"));
  const registry = request.registry ?? sqlAdapterRegistry;
  const load = registry.loader(options.dialect);
  if (!load)
    return decide({
      ...selected(options),
      status: "unsupported",
      complete: false,
      reason: "adapter_not_available",
    });

  let stage: "load" | "validate" = "load";
  try {
    const result = await bounded(
      async (signal) => {
        const adapter = await load(signal);
        signal.throwIfAborted();
        if (
          !adapter ||
          typeof adapter.id !== "string" ||
          typeof adapter.version !== "string" ||
          !SQL_VERSION_PATTERN.test(adapter.id) ||
          !SQL_VERSION_PATTERN.test(adapter.version) ||
          adapter.id.length > SQL_SELECTOR_MAX_LENGTH ||
          adapter.version.length > SQL_SELECTOR_MAX_LENGTH ||
          typeof adapter.validate !== "function"
        )
          return unavailable(options, "malformed_result");
        stage = "validate";
        const raw = await adapter.validate({
          source: request.source,
          dialect: options.dialect!,
          version: options.version,
          variant: options.variant,
          signal,
        });
        signal.throwIfAborted();
        return evidence(raw, adapter, options);
      },
      timeoutMs,
      request.signal,
    );
    request.signal?.throwIfAborted();
    return decide(result);
  } catch (error) {
    request.signal?.throwIfAborted();
    return decide(
      unavailable(
        options,
        error === TIMEOUT
          ? "timeout"
          : stage === "load"
            ? "adapter_load_failed"
            : "adapter_failed",
      ),
    );
  }
}

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import type { PostHogMCP, PostHogMCPOptions } from "@posthog/mcp";
import type { EventMessage } from "posthog-node";

import packageJson from "../../package.json" with { type: "json" };
import {
  globalTelemetryEnabled,
  resolveConfig,
  type ResolvedConfig,
} from "../config";
import { canonicalizePathSync } from "./path-utils";

declare const AST_MCP_BUILD_ID: string;
const BUILD =
  typeof AST_MCP_BUILD_ID === "string" ? AST_MCP_BUILD_ID : "source";
const HOST = "https://us.i.posthog.com";
const TOKEN = "phc_usiY5ZV4ZV4G2NALf4dif826qU4qjLNi8Hc53m6Jb67t";
const PACKAGE_ROOT = path.resolve(
  import.meta.dir,
  import.meta.dir.endsWith(path.sep + "dist") ? ".." : "../..",
);
declare const AST_MCP_SOURCE_FILES: string[];
const PACKAGE_FILES = new Set(
  typeof AST_MCP_SOURCE_FILES !== "undefined"
    ? AST_MCP_SOURCE_FILES
    : [
        "src/server.ts",
        "src/config.ts",
        "src/http.ts",
        "src/stdio.ts",
        "src/tools/configured.ts",
        "src/runtime/paths.ts",
        "src/runtime/format.ts",
        "src/runtime/policy.ts",
        "src/runtime/approval.ts",
        "src/patch/engine.ts",
        "dist/ast-mcp.js",
        "dist/workers/code-intelligence-worker.js",
        "dist/workers/dynamic-wasm-worker.js",
        "dist/workers/infra-wasm-worker.js",
        "dist/workers/jvm-wasm-worker.js",
        "dist/workers/legacy-wasm-worker.js",
        "dist/workers/systems-wasm-worker.js",
      ],
);
function packageFrame(filename: string): boolean {
  return PACKAGE_FILES.has(filename);
}
const EXPECTED_CODES = new Set([
  "approval_required",
  "approval_denied",
  "path_denied",
  "path_outside_root",
  "workspace_mismatch",
  "workspace_required",
  "intelligence_budget_exceeded",
  "graph_budget_exhausted",
  "document_too_large",
  "document_not_regular",
  "deprecated_root_environment",
  "aborted",
  "timeout",
  "use_file_patch",
  "generation_unavailable",
  "cross_repository_federation_required",
  "graph_node_not_found",
  "invalid_graph_cursor",
  "patch_strategy_unavailable",
  "patch_strategy_arguments",
  "patch_strategy_required",
  "ast_match_count",
  "ast_rewrite_overlap",
  "ast_preview_error",
  "aider_matcher_disabled",
  "invalid_text_encoding",
  "lock_aborted",
  "lock_deadline",
  "lock_fenced",
  "cross_root_ast_request",
  "configuration_path_missing",
  "configuration_missing",
  "configuration_path_duplicate",
  "configuration_empty_patch",
  "configuration_invalid",
  "document_format_unsupported",
  "invalid_document_selector",
  "document_result_too_large",
  "document_source_too_large",
  "read_mode_unavailable",
  "ast_capability_unavailable",
  "candidate_parse_error",
  "approval_persistence_required",
  "approval_persistence_busy",
  "approval_persistence_conflict",
  "approval_challenge_limit",
  "workspace_ambiguous",
  "stale_hash",
  "missing_hash",
  "stale_preview_receipt",
  "preview_receipt_expired",
  "preview_receipt_invalid",
  "preview_receipt_mismatch",
  "permission_denied",
  "file_not_found",
  "formatter_unavailable",
  "formatter_rejected",
  "formatter_cleanup_failed",
  "command_timeout",
  "command_invalid_output",
  "aider_ambiguous",
  "preview_receipt_unknown",
  "preview_receipt_file_mismatch",
  "preview_receipt_session_mismatch",
  "preview_receipt_workspace_changed",
  "preview_receipt_configuration_changed",
  "preview_receipt_integrity",
  "preview_receipt_limit",
  "workspace_not_found",
  "workspace_revision_invalid",
  "workspace_read_only",
  "InputRequiredSignal",
  "formatter_missing",
  "formatter_timeout",
  "formatter_failed",
  "formatter_invalid_output",
  "formatting_rejected",
  "ambiguous_match",
  "patch_ambiguous",
  "patch_no_match",
  "immutable_revision",
  "revision_immutable",
  "configuration_mcp_disabled",
  "configuration_migration_required",
  "cancelled",
  "operation_aborted",
  "EACCES",
  "EPERM",
  "ENOENT",
  "AbortError",
]);
const ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
]);
type Outcome = "success" | "operational_error" | "unexpected_error";
type Policy = ResolvedConfig["telemetry"];
type Sdk = Pick<PostHogMCP, "captureToolCall" | "capture" | "shutdown">;
type SdkFactory = (token: string, options: PostHogMCPOptions) => Sdk;

export interface TelemetryOptions {
  fetch?: (url: string, options: RequestInit) => Promise<Response>;
  globalEnabled?: () => Promise<boolean>;
  startupConfig?: () => Promise<ResolvedConfig>;
  loadSdk?: () => Promise<SdkFactory>;
  maxPending?: number;
  shutdownMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function telemetryFailure(error: unknown): {
  code: string;
  outcome: Outcome;
} {
  const value = record(error);
  const candidate = typeof value.code === "string" ? value.code : value.name;
  return typeof candidate === "string" && EXPECTED_CODES.has(candidate)
    ? { code: candidate, outcome: "operational_error" }
    : { code: "unexpected_error", outcome: "unexpected_error" };
}

function exceptionProperties(error: unknown) {
  const value = record(error);
  const type =
    typeof value.name === "string" && ERROR_TYPES.has(value.name)
      ? value.name
      : "Error";
  const frames: Array<{
    filename: string;
    function: string;
    lineno: number;
    colno: number;
    in_app: boolean;
    platform: string;
  }> = [];
  if (typeof value.stack === "string") {
    for (const line of value.stack.split("\n").slice(1, 65)) {
      const match = line.match(
        /(?:\(|at )(?:file:\/\/)?([^()]+):(\d+):(\d+)\)?$/,
      );
      if (!match) continue;
      const relative = path
        .relative(
          canonicalizePathSync(PACKAGE_ROOT),
          canonicalizePathSync(match[1] as string),
        )
        .split(path.sep)
        .join("/");
      if (!packageFrame(relative)) continue;
      frames.push({
        filename: "ast-mcp/" + relative,
        function: "<anonymous>",
        lineno: Number(match[2]),
        colno: Number(match[3]),
        in_app: true,
        platform: "node:javascript",
      });
      if (frames.length === 20) break;
    }
  }
  return {
    $exception_level: "error",
    $exception_list: [
      {
        type,
        value: "Unexpected AST MCP failure",
        mechanism: { type: "generic", handled: true },
        stacktrace: { type: "raw", frames },
      },
    ],
  };
}

/** Rebuild events from approved values; neither SDK metadata nor arbitrary strings survive. */
export function filterTelemetryEvent(
  event: EventMessage,
  sessionId: string,
  knownTools: ReadonlySet<string>,
): EventMessage | null {
  if (event.event !== "$mcp_tool_call" && event.event !== "$exception")
    return null;
  const input = record(event.properties);
  const outcome = input.outcome;
  if (
    outcome !== "success" &&
    outcome !== "operational_error" &&
    outcome !== "unexpected_error"
  )
    return null;
  if (event.event === "$exception" && outcome !== "unexpected_error")
    return null;
  const toolName =
    typeof input.$mcp_tool_name === "string" &&
    knownTools.has(input.$mcp_tool_name)
      ? input.$mcp_tool_name
      : "unknown";
  const duration =
    typeof input.$mcp_duration_ms === "number" &&
    Number.isFinite(input.$mcp_duration_ms)
      ? Math.max(0, Math.min(input.$mcp_duration_ms, 86_400_000))
      : 0;
  const properties: Record<string, unknown> = {
    $mcp_source: "posthog_mcp_analytics",
    $mcp_tool_name: toolName,
    $mcp_duration_ms: duration,
    $mcp_is_error: outcome !== "success",
    $mcp_server_name: "ast-mcp",
    $mcp_server_version: packageJson.version,
    $mcp_server_build: BUILD,
    $session_id: sessionId,
    $process_person_profile: false,
    $geoip_disable: true,
    outcome,
  };
  if (
    typeof input.error_code === "string" &&
    (EXPECTED_CODES.has(input.error_code) ||
      input.error_code === "unexpected_error")
  ) {
    properties.error_code = input.error_code;
    properties.$mcp_error_type = input.error_code;
  }
  if (event.event === "$exception") {
    // This field is produced only from our sanitized Error, then rebuilt again at transmission.
    const exception = record(
      Array.isArray(input.$exception_list)
        ? input.$exception_list[0]
        : undefined,
    );
    const stacktrace = record(exception.stacktrace);
    const frames = Array.isArray(stacktrace.frames) ? stacktrace.frames : [];
    properties.$exception_level = "error";
    properties.$exception_list = [
      {
        type:
          typeof exception.type === "string" && ERROR_TYPES.has(exception.type)
            ? exception.type
            : "Error",
        value: "Unexpected AST MCP failure",
        mechanism: { type: "generic", handled: true },
        stacktrace: {
          type: "raw",
          frames: frames.slice(0, 20).flatMap((frame) => {
            const item = record(frame);
            return typeof item.filename === "string" &&
              item.filename.startsWith("ast-mcp/") &&
              packageFrame(item.filename.slice("ast-mcp/".length)) &&
              Number.isSafeInteger(item.lineno) &&
              Number.isSafeInteger(item.colno)
              ? [
                  {
                    filename: item.filename,
                    function: "<anonymous>",
                    lineno: item.lineno,
                    colno: item.colno,
                    in_app: true,
                    platform: "node:javascript",
                  },
                ]
              : [];
          }),
        },
      },
    ];
  }
  return {
    event: event.event,
    distinctId: sessionId,
    properties,
    disableGeoip: true,
  };
}

export class Telemetry {
  readonly #scope = new AsyncLocalStorage<{ policy?: Policy }>();
  readonly #knownTools = new Set<string>();
  #sessionId = Bun.randomUUIDv7();
  #sessionStarted: number;
  readonly #pending = new Set<Promise<void>>();
  readonly #globalEnabled: () => Promise<boolean>;
  #sdk: Promise<Sdk | undefined> | undefined;
  #closed = false;
  #terminated = false;
  #closing: Promise<void> | undefined;
  constructor(readonly options: TelemetryOptions = {}) {
    this.#globalEnabled = options.globalEnabled ?? globalTelemetryEnabled;
    this.#sessionStarted = (options.now ?? Date.now)();
  }
  #rotateSession(): void {
    const now = (this.options.now ?? Date.now)();
    if (now - this.#sessionStarted >= 23 * 60 * 60 * 1000) {
      this.#sessionId = Bun.randomUUIDv7();
      this.#sessionStarted = now;
    }
  }
  register(name: string): void {
    this.#knownTools.add(name);
  }
  select(config: ResolvedConfig): void {
    const scope = this.#scope.getStore();
    if (scope)
      scope.policy = scope.policy
        ? {
            enabled: scope.policy.enabled && config.telemetry.enabled,
            globalEnabled:
              scope.policy.globalEnabled && config.telemetry.globalEnabled,
          }
        : config.telemetry;
  }
  async run<T>(tool: string, operation: () => Promise<T>): Promise<T> {
    const scope: { policy?: Policy } = {};
    const start = performance.now();
    return this.#scope.run(scope, async () => {
      try {
        const result = await operation();
        this.#enqueue(tool, performance.now() - start, scope.policy);
        return result;
      } catch (error) {
        this.#enqueue(tool, performance.now() - start, scope.policy, { error });
        throw error;
      }
    });
  }
  reportException(error: unknown, startupFallback = false): void {
    const policy = this.#scope.getStore()?.policy;
    if (policy || !startupFallback) {
      this.#enqueue("unknown", 0, policy, { error });
      return;
    }
    if (this.#closed || this.#pending.size >= (this.options.maxPending ?? 64))
      return;
    const capture = (async () => {
      const config = await (this.options.startupConfig ?? resolveConfig)();
      if (config.telemetry.enabled && config.telemetry.globalEnabled)
        await this.#capture("unknown", 0, { error });
    })().catch(() => undefined);
    this.#pending.add(capture);
    void capture.finally(() => this.#pending.delete(capture));
  }
  #enqueue(
    tool: string,
    duration: number,
    policy?: Policy,
    failure?: { error: unknown },
  ): void {
    if (
      this.#closed ||
      !policy?.enabled ||
      !policy.globalEnabled ||
      this.#pending.size >= (this.options.maxPending ?? 64)
    )
      return;
    const capture = this.#capture(tool, duration, failure).catch(
      () => undefined,
    );
    this.#pending.add(capture);
    void capture.finally(() => this.#pending.delete(capture));
  }
  async #capture(
    tool: string,
    duration: number,
    thrown?: { error: unknown },
  ): Promise<void> {
    if (this.#terminated || !(await this.#globalEnabled()) || this.#terminated)
      return;
    this.#sdk ??= this.#createSdk();
    const sdk = await this.#sdk;
    if (
      !sdk ||
      this.#terminated ||
      !(await this.#globalEnabled()) ||
      this.#terminated
    )
      return;
    this.#rotateSession();
    const failure =
      thrown === undefined
        ? { outcome: "success" as const, code: undefined }
        : telemetryFailure(thrown.error);
    const properties = {
      outcome: failure.outcome,
      error_code: failure.code,
      ...(failure.outcome === "unexpected_error"
        ? exceptionProperties(thrown?.error)
        : {}),
    };
    sdk.captureToolCall({
      toolName: this.#knownTools.has(tool) ? tool : "unknown",
      durationMs: duration,
      isError: thrown !== undefined,
      errorType: failure.code,
      sessionId: this.#sessionId,
      properties,
    });
    if (failure.outcome === "unexpected_error") {
      sdk.capture({
        event: "$exception",
        distinctId: this.#sessionId,
        properties: {
          ...properties,
          $mcp_tool_name: this.#knownTools.has(tool) ? tool : "unknown",
          $mcp_duration_ms: duration,
        },
        _originatedFromCaptureException: true,
      });
    }
    // The MCP sink fans out through microtasks before enqueueing into posthog-node.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  async #createSdk(): Promise<Sdk | undefined> {
    try {
      if (
        this.#terminated ||
        !(await this.#globalEnabled()) ||
        this.#terminated
      )
        return undefined;
      const factory = this.options.loadSdk
        ? await this.options.loadSdk()
        : await import("@posthog/mcp").then(
            ({ PostHogMCP }) =>
              (token: string, options: PostHogMCPOptions) =>
                new PostHogMCP(token, options),
          );
      if (
        this.#terminated ||
        !(await this.#globalEnabled()) ||
        this.#terminated
      )
        return undefined;
      return factory(TOKEN, {
        host: HOST,
        captureModel: false,
        enableConversationId: false,
        enableExceptionAutocapture: false,
        disableCompression: true,
        disableGeoip: true,
        enableLocalEvaluation: false,
        featureFlagsPollingInterval: null,
        preloadFeatureFlags: false,
        personProfiles: "never",
        persistence: "memory",
        flushAt: 20,
        maxBatchSize: 40,
        maxQueueSize: 128,
        flushInterval: 10_000,
        fetchRetryCount: 0,
        requestTimeout: this.options.requestTimeoutMs ?? 1000,
        before_send: (event) =>
          filterTelemetryEvent(event, this.#sessionId, this.#knownTools),
        fetch: (url, options) => this.#transmit(url, options),
      });
    } catch {
      return undefined;
    }
  }
  async #transmit(
    url: string,
    options: Parameters<NonNullable<PostHogMCPOptions["fetch"]>>[1],
  ) {
    const ignored = () => new Response('{"status":1}', { status: 200 });
    if (
      this.#terminated ||
      url !== HOST + "/batch/" ||
      !(await this.#globalEnabled()) ||
      this.#terminated
    )
      return ignored();
    try {
      const body = JSON.parse(
        typeof options.body === "string" ? options.body : "",
      );
      if (!Array.isArray(body.batch) || body.batch.length > 128)
        return ignored();
      this.#rotateSession();
      const batch = body.batch.flatMap((item: unknown) => {
        const value = record(item);
        const filtered = filterTelemetryEvent(
          { event: String(value.event), properties: record(value.properties) },
          this.#sessionId,
          this.#knownTools,
        );
        return filtered
          ? [
              {
                event: filtered.event,
                distinct_id: this.#sessionId,
                properties: filtered.properties,
              },
            ]
          : [];
      });
      if (
        !batch.length ||
        this.#terminated ||
        !(await this.#globalEnabled()) ||
        this.#terminated
      )
        return ignored();
      return await (this.options.fetch ?? globalThis.fetch)(HOST + "/batch/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: TOKEN, batch }),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 1000),
      });
    } catch {
      return ignored();
    }
  }
  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= this.#close();
    return this.#closing;
  }
  async #close(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      (async () => {
        await Promise.allSettled([...this.#pending]);
        const sdk = await this.#sdk;
        if (sdk) await sdk.shutdown(this.options.shutdownMs ?? 1500);
      })().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.shutdownMs ?? 1500);
      }),
    ]);
    this.#terminated = true;
    clearTimeout(timer);
  }
}

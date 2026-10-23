import { Worker } from "node:worker_threads";

import * as z from "zod/v4";

import type { SyntaxFacts } from "../../parser/index.ts";

export type WorkerErrorCode =
  | "aborted"
  | "closed"
  | "queue-full"
  | "timeout"
  | "worker-exit"
  | "protocol";

export interface WorkerSuccess {
  facts: SyntaxFacts;
  id: number;
  ok: true;
  type: "result";
}

export interface WorkerFailure {
  error: string;
  id: number;
  ok: false;
  type: "result";
}

export type WorkerResponse = WorkerSuccess | WorkerFailure;

const nonnegativeInteger = z.number().int().nonnegative();
const positiveId = z.number().int().positive().safe();
const coordinateSchema = z
  .object({
    byteOffset: nonnegativeInteger,
    characterOffset: nonnegativeInteger,
    column: nonnegativeInteger,
    line: nonnegativeInteger,
    utf16Column: nonnegativeInteger,
    utf16Offset: nonnegativeInteger,
  })
  .strict();
const positionSchema = z
  .object({ column: nonnegativeInteger, line: nonnegativeInteger })
  .strict();
const rangeSchema = z
  .object({
    end: positionSchema,
    endByte: nonnegativeInteger,
    endCoordinate: coordinateSchema,
    start: positionSchema,
    startByte: nonnegativeInteger,
    startCoordinate: coordinateSchema,
  })
  .strict();
const nullableString = z.string().nullable();
const nodeSchema = z
  .object({
    childIds: z.array(z.string()),
    id: z.string(),
    kind: z.string(),
    named: z.boolean(),
    parentId: nullableString,
    range: rangeSchema,
  })
  .strict();
const symbolSchema = z
  .object({
    declarationRange: rangeSchema,
    exported: z.boolean(),
    id: z.string(),
    kind: z.enum([
      "class",
      "interface",
      "function",
      "method",
      "variable",
      "type",
      "enum",
      "namespace",
      "unknown",
    ]),
    name: z.string(),
    qualifiedName: z.string(),
    range: rangeSchema,
  })
  .strict();
const importSchema = z
  .object({
    id: z.string(),
    importedName: z.string(),
    localName: z.string(),
    range: rangeSchema,
    source: z.string(),
    typeOnly: z.boolean(),
  })
  .strict();
const exportSchema = z
  .object({
    exportedName: z.string(),
    id: z.string(),
    localName: nullableString,
    range: rangeSchema,
    source: nullableString,
    typeOnly: z.boolean(),
  })
  .strict();
const callSchema = z
  .object({
    callee: z.string(),
    enclosingSymbolId: nullableString,
    id: z.string(),
    range: rangeSchema,
  })
  .strict();
const relationshipSchema = z
  .object({
    id: z.string(),
    range: rangeSchema,
    sourceSymbolId: nullableString,
    targetName: z.string(),
  })
  .strict();
const referenceSchema = z
  .object({
    enclosingSymbolId: nullableString,
    id: z.string(),
    name: z.string(),
    range: rangeSchema,
    role: z.enum(["read", "write", "type"]),
  })
  .strict();
const diagnosticSchema = z
  .object({
    code: z.enum(["parse-error", "missing-node", "truncated"]),
    message: z.string(),
    range: rangeSchema,
    severity: z.enum(["error", "warning"]),
  })
  .strict();
const syntaxFactsSchema = z
  .object({
    calls: z.array(callSchema),
    diagnostics: z.array(diagnosticSchema),
    exports: z.array(exportSchema),
    extractorFingerprint: z.string(),
    grammarFingerprint: z.string(),
    implementations: z.array(relationshipSchema),
    imports: z.array(importSchema),
    inheritance: z.array(relationshipSchema),
    languageId: z.string(),
    nodes: z.array(nodeSchema),
    parserFingerprint: z.string(),
    partial: z.boolean(),
    references: z.array(referenceSchema),
    rootNodeId: z.string(),
    schemaVersion: z.literal("ast-mcp.syntax-facts.v1"),
    sourceArtifactId: z.string(),
    sourceDigest: z.string(),
    symbols: z.array(symbolSchema),
    syntaxFactsArtifactId: z.string(),
  })
  .strict();
const workerResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      facts: syntaxFactsSchema,
      id: positiveId,
      ok: z.literal(true),
      type: z.literal("result"),
    })
    .strict(),
  z
    .object({
      error: z.string(),
      id: positiveId,
      ok: z.literal(false),
      type: z.literal("result"),
    })
    .strict(),
]);

export function validateWorkerEnvelope(value: unknown): WorkerResponse {
  return workerResponseSchema.parse(value) as WorkerResponse;
}

export interface WorkerAnalyzeRequest {
  languageId: string;
  signal?: AbortSignal;
  source: string;
  timeoutMs?: number;
}

export interface WorkerClientLimits {
  maxOutstandingBytes: number;
  maxPendingRequests: number;
  timeoutMs: number;
}

interface WorkerClientConfig {
  createError(code: WorkerErrorCode, message: string): Error;
  displayName: string;
  interruptViaErrorHandler?: boolean;
  limits: WorkerClientLimits;
  protocolName: string;
  validateResponse(
    value: unknown,
    expected?: { id: number; languageId: string; source: string },
  ): WorkerResponse;
  workerUrl: URL;
}

interface Pending {
  bytes: number;
  retiring: boolean;
  waiting: boolean;
  cleanup(): void;
  languageId: string;
  reject(error: Error): void;
  resolve(facts: SyntaxFacts): void;
  source: string;
}

// Retirement remains owned and close reports failures to its caller.
function observeRetirementFailure(): void {}

export function createWorkerClient(config: WorkerClientConfig) {
  let worker: Worker | undefined;
  let nextId = 1;
  let outstandingBytes = 0;
  let termination: Promise<void> | undefined;
  let retirementFailed = false;
  const waitingStarts = new Map<number, () => void>();
  const pending = new Map<number, Pending>();
  const drainWaiters = new Set<() => void>();

  function error(code: WorkerErrorCode, message: string): Error {
    return config.createError(code, message);
  }

  function notifyDrained(): void {
    if (pending.size !== 0 || termination) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  }

  function finish(id: number): Pending | undefined {
    const request = pending.get(id);
    if (!request) return undefined;
    pending.delete(id);
    waitingStarts.delete(id);
    outstandingBytes -= request.bytes;
    request.cleanup();
    notifyDrained();
    return request;
  }

  function rejectPending(value: unknown): void {
    const failure = value instanceof Error ? value : new Error(String(value));
    const requests = [...pending.entries()];
    for (const [id, request] of requests) {
      finish(id);
      request.reject(failure);
    }
    worker = undefined;
  }

  function handleError(active: Worker, failure: Error): void {
    if (worker === active)
      void terminateWorker(active, failure).catch(observeRetirementFailure);
  }

  async function terminateWorker(
    active: Worker | undefined,
    failure: Error,
    canceledId?: number,
  ): Promise<void> {
    if (canceledId !== undefined) {
      try {
        active?.postMessage({ id: canceledId, type: "cancel" });
      } catch {
        /* Termination remains authoritative after a failed cancellation message. */
      }
    }
    if (!termination) {
      const retiringRequests = [...pending.entries()];
      for (const [, request] of retiringRequests) request.retiring = true;
      worker = undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const retirement = Promise.resolve()
        .then(async () => {
          if (active) await active.terminate();
        })
        .then(() => {
          for (const [id] of retiringRequests) finish(id);
          termination = undefined;
          retirementFailed = false;
          const starts = [...waitingStarts.values()];
          waitingStarts.clear();
          for (const start of starts) queueMicrotask(start);
          notifyDrained();
        });
      termination = Promise.race([
        retirement,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(error("worker-exit", "worker retirement timed out")),
            config.limits.timeoutMs,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      void termination.catch(() => {
        retirementFailed = true;
        for (const id of [...waitingStarts.keys()]) {
          finish(id)?.reject(error("queue-full", "worker is retiring"));
        }
      });
      for (const [, request] of retiringRequests) {
        request.cleanup();
        request.reject(failure);
      }
    }
    await termination;
  }

  function handleResponse(active: Worker, value: unknown): void {
    if (worker !== active) return;
    try {
      const response = config.validateResponse(value);
      const pendingRequest = pending.get(response.id);
      if (!pendingRequest) return;
      const validated = config.validateResponse(value, {
        id: response.id,
        languageId: pendingRequest.languageId,
        source: pendingRequest.source,
      });
      const request = finish(validated.id);
      if (!request) return;
      if (validated.ok) request.resolve(validated.facts);
      else request.reject(new Error(validated.error));
    } catch {
      void terminateWorker(
        active,
        error(
          "protocol",
          `${config.protocolName} parser worker returned an invalid response`,
        ),
      ).catch(observeRetirementFailure);
    }
  }

  function handleExit(active: Worker, code: number): void {
    if (worker !== active) return;
    rejectPending(
      error(
        "worker-exit",
        `${config.displayName} parser worker exited with code ${code}`,
      ),
    );
  }

  function parserWorker(): Worker {
    if (worker) return worker;
    const active = new Worker(config.workerUrl);
    worker = active;
    active.unref();
    active.on("message", handleResponse.bind(undefined, active));
    active.on("error", handleError.bind(undefined, active));
    active.on("exit", handleExit.bind(undefined, active));
    return active;
  }

  function analyze(request: WorkerAnalyzeRequest): Promise<SyntaxFacts> {
    if (termination && retirementFailed)
      return Promise.reject(error("queue-full", "worker is retiring"));
    const bytes = Buffer.byteLength(request.source);
    if (
      pending.size >= config.limits.maxPendingRequests ||
      outstandingBytes + bytes > config.limits.maxOutstandingBytes
    ) {
      return Promise.reject(
        error("queue-full", `${config.displayName} parser capacity exceeded`),
      );
    }
    if (request.signal?.aborted) {
      return Promise.reject(
        error("aborted", `${config.displayName} parser request aborted`),
      );
    }
    const id = nextId++;
    const timeoutMs = request.timeoutMs ?? config.limits.timeoutMs;
    return new Promise<SyntaxFacts>((resolve, reject) => {
      const cancel = (code: "aborted" | "timeout", detail: string) => {
        if (pending.get(id)?.waiting) {
          finish(id)?.reject(error(code, detail));
          return;
        }
        void terminateWorker(worker, error(code, detail), id).catch(
          observeRetirementFailure,
        );
      };
      const abort = () => {
        cancel("aborted", `${config.displayName} parser request aborted`);
      };
      const timer = setTimeout(() => {
        cancel("timeout", `${config.displayName} parser request timed out`);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
      };
      pending.set(id, {
        bytes,
        retiring: false,
        waiting: termination !== undefined,
        cleanup,
        languageId: request.languageId,
        reject,
        resolve,
        source: request.source,
      });
      outstandingBytes += bytes;
      request.signal?.addEventListener("abort", abort, { once: true });
      const start = () => {
        const admitted = pending.get(id);
        if (!admitted || admitted.retiring) return;
        if (termination) {
          if (retirementFailed)
            finish(id)?.reject(error("queue-full", "worker is retiring"));
          else {
            admitted.waiting = true;
            waitingStarts.set(id, start);
          }
          return;
        }
        admitted.waiting = false;
        try {
          parserWorker().postMessage({
            id,
            languageId: request.languageId,
            source: request.source,
            type: "start",
          });
        } catch {
          void terminateWorker(
            worker,
            error(
              "worker-exit",
              `${config.displayName} parser worker could not start request`,
            ),
          ).catch(observeRetirementFailure);
        }
      };
      queueMicrotask(start);
    });
  }

  function stats(): {
    outstandingBytes: number;
    pendingRequests: number;
  } {
    return { outstandingBytes, pendingRequests: pending.size };
  }

  function drain(): Promise<void> {
    if (termination) return termination.then(() => drain());
    if (pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.add(resolve));
  }

  async function interrupt(): Promise<void> {
    const failure = error(
      "worker-exit",
      `${config.displayName} parser worker exited unexpectedly`,
    );
    if (!config.interruptViaErrorHandler) {
      await terminateWorker(worker, failure);
      return;
    }
    const active = worker;
    if (!active) {
      await terminateWorker(undefined, failure);
      return;
    }
    await terminateWorker(active, failure);
  }

  async function close(): Promise<void> {
    if (termination) await termination;
    await terminateWorker(
      worker,
      error("closed", `${config.displayName} parser worker closed`),
    );
  }

  async function restart(): Promise<void> {
    await close();
  }

  return {
    analyze,
    close,
    drain,
    handleError,
    handleExit,
    handleResponse,
    interrupt,
    rejectPending,
    restart,
    stats,
  };
}

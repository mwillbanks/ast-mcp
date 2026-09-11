import { Worker } from "node:worker_threads";
import { type SyntaxFacts, sha256 } from "../../parser/index.ts";
import {
  type DynamicWorkerExpectation,
  isDynamicWorkerResult,
} from "./protocol.ts";
import type { DynamicAnalyzeRequest, DynamicLanguageId } from "./types.ts";

export const dynamicExtractorFingerprint = sha256(
  "tree-sitter-wasm@1.1.8+web-tree-sitter@0.27.0",
);
export const DYNAMIC_WORKER_LIMITS = {
  maxOutstandingBytes: 8 * 1024 * 1024,
  maxPendingRequests: 64,
  timeoutMs: 10_000,
} as const;

export class DynamicLanguageUnavailableError extends Error {
  readonly code = "dynamic_grammar_unavailable";
  readonly retryable = false;
  constructor(readonly languageId: DynamicLanguageId) {
    super(
      `Dynamic language '${languageId}' has no validated bundled WASM grammar`,
    );
    this.name = "DynamicLanguageUnavailableError";
  }
}

export class DynamicWorkerError extends Error {
  constructor(
    readonly code:
      | "aborted"
      | "closed"
      | "queue-full"
      | "timeout"
      | "worker-exit"
      | "protocol",
    message: string,
  ) {
    super(message);
    this.name = "DynamicWorkerError";
  }
}

interface Pending extends DynamicWorkerExpectation {
  bytes: number;
  cleanup(): void;
  reject(error: Error): void;
  resolve(facts: SyntaxFacts): void;
}
let worker: Worker | undefined;
let nextId = 1;
let outstandingBytes = 0;
let termination: Promise<void> | undefined;
const pending = new Map<number, Pending>();
const drainWaiters = new Set<() => void>();

function notifyDrained(): void {
  if (pending.size !== 0) return;
  for (const resolve of drainWaiters) resolve();
  drainWaiters.clear();
}
function finish(id: number): Pending | undefined {
  const request = pending.get(id);
  if (!request) return undefined;
  pending.delete(id);
  outstandingBytes -= request.bytes;
  request.cleanup();
  notifyDrained();
  return request;
}
export function rejectPendingDynamicRequests(error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  const requests = [...pending.entries()];
  for (const [id, request] of requests) {
    finish(id);
    request.reject(failure);
  }
  worker = undefined;
}
async function cancelWorker(
  id: number,
  failure: DynamicWorkerError,
): Promise<void> {
  const active = worker;
  active?.postMessage({ id, type: "cancel" });
  if (!termination) {
    worker = undefined;
    termination = (async () => {
      if (active) await active.terminate();
      rejectPendingDynamicRequests(failure);
    })().finally(() => {
      termination = undefined;
    });
  }
  await termination;
}

function parserWorker(): Worker {
  if (worker) return worker;
  const active = new Worker(new URL("./wasm-worker.ts", import.meta.url));
  worker = active;
  active.unref();
  active.on("message", (response: unknown) => {
    const responseId =
      response && typeof response === "object"
        ? (response as Record<string, unknown>).id
        : undefined;
    const request =
      typeof responseId === "number" ? pending.get(responseId) : undefined;
    if (!request || !isDynamicWorkerResult(response, request)) {
      rejectPendingDynamicRequests(
        new DynamicWorkerError(
          "protocol",
          "Dynamic parser worker returned an invalid response",
        ),
      );
      return;
    }
    finish(response.id);
    if (response.ok) request.resolve(response.facts);
    else request.reject(new Error(response.error));
  });
  active.on("error", (error) => {
    if (worker === active) rejectPendingDynamicRequests(error);
  });
  active.on("exit", (code) => {
    if (worker !== active) return;
    rejectPendingDynamicRequests(
      new DynamicWorkerError(
        "worker-exit",
        `Dynamic parser worker exited with code ${code}`,
      ),
    );
  });
  return active;
}

export function analyzeDynamicLanguage(
  request: DynamicAnalyzeRequest,
): Promise<SyntaxFacts> {
  if (termination) {
    return termination.then(() => analyzeDynamicLanguage(request));
  }
  const bytes = Buffer.byteLength(request.source);
  if (
    pending.size >= DYNAMIC_WORKER_LIMITS.maxPendingRequests ||
    outstandingBytes + bytes > DYNAMIC_WORKER_LIMITS.maxOutstandingBytes
  ) {
    return Promise.reject(
      new DynamicWorkerError("queue-full", "Dynamic parser capacity exceeded"),
    );
  }
  if (request.signal?.aborted) {
    return Promise.reject(
      new DynamicWorkerError("aborted", "Dynamic parser request aborted"),
    );
  }
  const id = nextId++;
  const timeoutMs = request.timeoutMs ?? DYNAMIC_WORKER_LIMITS.timeoutMs;
  return new Promise<SyntaxFacts>((resolve, reject) => {
    const abort = () => {
      void cancelWorker(
        id,
        new DynamicWorkerError("aborted", "Dynamic parser request aborted"),
      );
    };
    const timer = setTimeout(() => {
      void cancelWorker(
        id,
        new DynamicWorkerError("timeout", "Dynamic parser request timed out"),
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
    };
    pending.set(id, {
      bytes,
      cleanup,
      languageId: request.languageId,
      reject,
      resolve,
      sourceDigest: sha256(request.source),
    });
    outstandingBytes += bytes;
    request.signal?.addEventListener("abort", abort, { once: true });
    queueMicrotask(() => {
      if (!pending.has(id)) return;
      parserWorker().postMessage({
        id,
        languageId: request.languageId,
        source: request.source,
        type: "start",
      });
    });
  });
}

export function dynamicWorkerStats(): {
  active: boolean;
  outstandingBytes: number;
  pendingRequests: number;
} {
  return {
    active: worker !== undefined,
    outstandingBytes,
    pendingRequests: pending.size,
  };
}
export function drainDynamicLanguageWorker(): Promise<void> {
  if (pending.size === 0) return Promise.resolve();
  return new Promise((resolve) => drainWaiters.add(resolve));
}
export async function closeDynamicLanguageWorker(): Promise<void> {
  if (termination) await termination;
  const active = worker;
  worker = undefined;
  rejectPendingDynamicRequests(
    new DynamicWorkerError("closed", "Dynamic parser worker closed"),
  );
  if (active) await active.terminate();
}
export async function restartDynamicLanguageWorker(): Promise<void> {
  await closeDynamicLanguageWorker();
}

export async function terminateDynamicLanguageWorker(): Promise<number> {
  return parserWorker().terminate();
}

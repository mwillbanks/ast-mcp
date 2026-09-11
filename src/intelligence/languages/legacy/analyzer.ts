import { Worker } from "node:worker_threads";
import { type SyntaxFacts, sha256 } from "../../parser/index.ts";
import {
  isLegacyWorkerResult,
  type LegacyWorkerExpectation,
} from "./protocol.ts";
import type { LegacyAnalyzeRequest, LegacyLanguageId } from "./types.ts";

export const legacyExtractorFingerprint = sha256(
  "legacy-tree-sitter-wasm@1.1.8+structured@1",
);
export const LEGACY_WORKER_LIMITS = {
  maxOutstandingBytes: 8 * 1024 * 1024,
  maxPendingRequests: 64,
  timeoutMs: 10_000,
} as const;

export class LegacyLanguageUnavailableError extends Error {
  readonly code = "legacy_grammar_unavailable";
  readonly retryable = false;
  constructor(readonly languageId: LegacyLanguageId) {
    super(
      `Legacy language '${languageId}' has no validated bundled WASM grammar`,
    );
    this.name = "LegacyLanguageUnavailableError";
  }
}

export class LegacyWorkerError extends Error {
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
    this.name = "LegacyWorkerError";
  }
}

interface Pending extends LegacyWorkerExpectation {
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
export function rejectPendingLegacyRequests(error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  const requests = [...pending.entries()];
  for (const [id, request] of requests) {
    finish(id);
    request.reject(failure);
  }
  worker = undefined;
}
async function terminateWorker(
  active: Worker | undefined,
  failure: Error,
): Promise<void> {
  if (!termination) {
    worker = undefined;
    termination = (async () => {
      if (active) await active.terminate();
      rejectPendingLegacyRequests(failure);
    })().finally(() => {
      termination = undefined;
      notifyDrained();
    });
  }
  await termination;
}

async function cancelWorker(
  id: number,
  failure: LegacyWorkerError,
): Promise<void> {
  const active = worker;
  active?.postMessage({ id, type: "cancel" });
  await terminateWorker(active, failure);
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
    if (!request || !isLegacyWorkerResult(response, request)) {
      void terminateWorker(
        active,
        new LegacyWorkerError(
          "protocol",
          "Legacy parser worker returned an invalid response",
        ),
      );
      return;
    }
    finish(response.id);
    if (response.ok) request.resolve(response.facts);
    else request.reject(new Error(response.error));
  });
  active.on("error", (error) => {
    if (worker === active) {
      const failure = error instanceof Error ? error : new Error(String(error));
      void terminateWorker(active, failure);
    }
  });
  active.on("exit", (code) => {
    if (worker !== active) return;
    rejectPendingLegacyRequests(
      new LegacyWorkerError(
        "worker-exit",
        `Legacy parser worker exited with code ${code}`,
      ),
    );
  });
  return active;
}

export function analyzeLegacyLanguage(
  request: LegacyAnalyzeRequest,
): Promise<SyntaxFacts> {
  if (termination) {
    return termination.then(() => analyzeLegacyLanguage(request));
  }
  const bytes = Buffer.byteLength(request.source);
  if (
    pending.size >= LEGACY_WORKER_LIMITS.maxPendingRequests ||
    outstandingBytes + bytes > LEGACY_WORKER_LIMITS.maxOutstandingBytes
  ) {
    return Promise.reject(
      new LegacyWorkerError("queue-full", "Legacy parser capacity exceeded"),
    );
  }
  if (request.signal?.aborted) {
    return Promise.reject(
      new LegacyWorkerError("aborted", "Legacy parser request aborted"),
    );
  }
  const id = nextId++;
  const timeoutMs = request.timeoutMs ?? LEGACY_WORKER_LIMITS.timeoutMs;
  return new Promise<SyntaxFacts>((resolve, reject) => {
    const abort = () => {
      void cancelWorker(
        id,
        new LegacyWorkerError("aborted", "Legacy parser request aborted"),
      );
    };
    const timer = setTimeout(() => {
      void cancelWorker(
        id,
        new LegacyWorkerError("timeout", "Legacy parser request timed out"),
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

export function legacyWorkerStats(): {
  outstandingBytes: number;
  pendingRequests: number;
} {
  return { outstandingBytes, pendingRequests: pending.size };
}
export function drainLegacyLanguageWorker(): Promise<void> {
  if (pending.size === 0) return Promise.resolve();
  return new Promise((resolve) => drainWaiters.add(resolve));
}
export async function closeLegacyLanguageWorker(): Promise<void> {
  if (termination) await termination;
  const active = worker;
  if (!active) {
    rejectPendingLegacyRequests(
      new LegacyWorkerError("closed", "Legacy parser worker closed"),
    );
    return;
  }
  await terminateWorker(
    active,
    new LegacyWorkerError("closed", "Legacy parser worker closed"),
  );
}
export async function restartLegacyLanguageWorker(): Promise<void> {
  await closeLegacyLanguageWorker();
}

export async function terminateLegacyLanguageWorker(): Promise<number> {
  return parserWorker().terminate();
}

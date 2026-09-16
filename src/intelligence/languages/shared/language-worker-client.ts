import { Worker } from "node:worker_threads";
import { type SyntaxFacts, sha256 } from "../../parser/index.ts";
import type {
  LanguageWorkerResult,
  WorkerExpectation,
} from "./worker-protocol-validator.ts";

export type LanguageWorkerErrorCode =
  | "aborted"
  | "closed"
  | "queue-full"
  | "timeout"
  | "worker-exit"
  | "protocol";

export interface LanguageAnalyzeRequest<LanguageId extends string> {
  languageId: LanguageId;
  signal?: AbortSignal;
  source: string;
  timeoutMs?: number;
}

export interface LanguageWorkerLimits {
  maxOutstandingBytes: number;
  maxPendingRequests: number;
  timeoutMs: number;
}

interface Pending<LanguageId extends string>
  extends WorkerExpectation<LanguageId> {
  bytes: number;
  cleanup(): void;
  reject(error: Error): void;
  resolve(facts: SyntaxFacts): void;
}

interface LanguageWorkerClientOptions<LanguageId extends string> {
  closeMode: "detach-first" | "terminate";
  createError(code: LanguageWorkerErrorCode, message: string): Error;
  label: string;
  limits: LanguageWorkerLimits;
  terminateOnProtocolError: boolean;
  terminateOnWorkerError: boolean;
  validateResult(
    value: unknown,
    expected?: WorkerExpectation<LanguageId>,
  ): value is LanguageWorkerResult;
  workerUrl: URL;
}

export class LanguageWorkerClient<LanguageId extends string> {
  private worker: Worker | undefined;
  private nextId = 1;
  private outstandingBytes = 0;
  private termination: Promise<void> | undefined;
  private readonly pending = new Map<number, Pending<LanguageId>>();
  private readonly drainWaiters = new Set<() => void>();

  constructor(
    private readonly options: LanguageWorkerClientOptions<LanguageId>,
  ) {}

  private error(code: LanguageWorkerErrorCode, detail: string): Error {
    return this.options.createError(
      code,
      `${this.options.label} parser ${detail}`,
    );
  }

  private notifyDrained(): void {
    if (this.pending.size !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private finish(id: number): Pending<LanguageId> | undefined {
    const request = this.pending.get(id);
    if (!request) return undefined;
    this.pending.delete(id);
    this.outstandingBytes -= request.bytes;
    request.cleanup();
    this.notifyDrained();
    return request;
  }

  rejectPending(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const [id, request] of [...this.pending.entries()]) {
      this.finish(id);
      request.reject(failure);
    }
    this.worker = undefined;
  }

  private async terminateWorker(
    active: Worker | undefined,
    failure: Error,
  ): Promise<void> {
    if (!this.termination) {
      this.worker = undefined;
      this.termination = (async () => {
        if (active) await active.terminate();
        this.rejectPending(failure);
      })().finally(() => {
        this.termination = undefined;
        this.notifyDrained();
      });
    }
    await this.termination;
  }

  private async cancel(id: number, failure: Error): Promise<void> {
    const active = this.worker;
    active?.postMessage({ id, type: "cancel" });
    await this.terminateWorker(active, failure);
  }

  private parserWorker(): Worker {
    if (this.worker) return this.worker;
    const active = new Worker(this.options.workerUrl);
    this.worker = active;
    active.unref();
    active.on("message", (response: unknown) => {
      if (this.worker !== active) return;
      const responseId =
        response && typeof response === "object"
          ? (response as Record<string, unknown>).id
          : undefined;
      const request =
        typeof responseId === "number"
          ? this.pending.get(responseId)
          : undefined;
      if (!request || !this.options.validateResult(response, request)) {
        const failure = this.error(
          "protocol",
          "worker returned an invalid response",
        );
        if (this.options.terminateOnProtocolError)
          void this.terminateWorker(active, failure);
        else this.rejectPending(failure);
        return;
      }
      this.finish(response.id);
      if (response.ok) request.resolve(response.facts);
      else request.reject(new Error(response.error));
    });
    active.on("error", (error) => {
      if (this.worker !== active) return;
      if (this.options.terminateOnWorkerError)
        void this.terminateWorker(
          active,
          error instanceof Error ? error : new Error(String(error)),
        );
      else this.rejectPending(error);
    });
    active.on("exit", (code) => {
      if (this.worker !== active) return;
      this.rejectPending(
        this.error("worker-exit", `worker exited with code ${code}`),
      );
    });
    return active;
  }

  analyze(request: LanguageAnalyzeRequest<LanguageId>): Promise<SyntaxFacts> {
    if (this.termination)
      return this.termination.then(() => this.analyze(request));
    const bytes = Buffer.byteLength(request.source);
    if (
      this.pending.size >= this.options.limits.maxPendingRequests ||
      this.outstandingBytes + bytes > this.options.limits.maxOutstandingBytes
    )
      return Promise.reject(this.error("queue-full", "capacity exceeded"));
    if (request.signal?.aborted)
      return Promise.reject(this.error("aborted", "request aborted"));
    const id = this.nextId++;
    const timeoutMs = request.timeoutMs ?? this.options.limits.timeoutMs;
    return new Promise<SyntaxFacts>((resolve, reject) => {
      const abort = () => {
        void this.cancel(id, this.error("aborted", "request aborted"));
      };
      const timer = setTimeout(() => {
        void this.cancel(id, this.error("timeout", "request timed out"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, {
        bytes,
        cleanup,
        languageId: request.languageId,
        reject,
        resolve,
        sourceDigest: sha256(request.source),
      });
      this.outstandingBytes += bytes;
      request.signal?.addEventListener("abort", abort, { once: true });
      queueMicrotask(() => {
        if (!this.pending.has(id)) return;
        this.parserWorker().postMessage({
          id,
          languageId: request.languageId,
          source: request.source,
          type: "start",
        });
      });
    });
  }

  stats(): {
    active: boolean;
    outstandingBytes: number;
    pendingRequests: number;
  } {
    return {
      active: this.worker !== undefined,
      outstandingBytes: this.outstandingBytes,
      pendingRequests: this.pending.size,
    };
  }

  drain(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.add(resolve));
  }

  async close(): Promise<void> {
    if (this.termination) await this.termination;
    const active = this.worker;
    const failure = this.error("closed", "worker closed");
    if (this.options.closeMode === "detach-first") {
      this.worker = undefined;
      this.rejectPending(failure);
      if (active) await active.terminate();
      return;
    }
    if (!active) {
      this.rejectPending(failure);
      return;
    }
    await this.terminateWorker(active, failure);
  }

  async restart(): Promise<void> {
    await this.close();
  }

  terminate(): Promise<number> {
    return this.parserWorker().terminate();
  }
}

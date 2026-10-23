import { Worker } from "node:worker_threads";

import { EmbeddingUnavailableError } from "./model-provider.ts";
import type { EmbeddingModelConfig } from "./types.ts";

export interface ModelWorkerRequest {
  allowDownload: boolean;
  config: EmbeddingModelConfig;
  id: number;
  kind: "transformers" | "potion";
  texts: readonly string[];
}

interface Pending {
  bytes: number;
  started: boolean;
  count: number;
  reject: (error: Error) => void;
  resolve: (vectors: readonly number[][]) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Recovery {
  bytes: number;
  texts: readonly string[];
  reject: (error: Error) => void;
  resolve: (vectors: readonly number[][]) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Owns one native model thread and quarantines it until termination completes. */
export class ManagedModelSession {
  private worker?: Worker;
  private retirement?: Promise<void>;
  private retirementFailed = false;
  private readonly recovery = new Set<Recovery>();
  private pendingBytes = 0;
  private recoveryBytes = 0;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly config: EmbeddingModelConfig,
    private readonly kind: ModelWorkerRequest["kind"],
    private readonly allowDownload = false,
    private readonly timeoutMs = 30_000,
    private readonly workerUrl = new URL("./model-worker.ts", import.meta.url),
    private readonly workerFactory: (url: URL) => Worker = (url) =>
      new Worker(url),
    private readonly queueTimeoutMs = 300_000,
  ) {}

  private fail(active: Worker, message: string): void {
    if (this.worker !== active) return;
    this.worker = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    this.pending.clear();
    this.pendingBytes = 0;
    // Do not replace a thread while its native runtime can still be running.
    const retirement = Promise.resolve()
      .then(() => active.terminate())
      .then(() => {
        if (this.retirement === retirement) {
          this.retirement = undefined;
          this.retirementFailed = false;
          this.resumeRecovery();
        }
      });
    this.retirement = retirement;
    void retirement.catch(() => {
      this.retirementFailed = true;
      this.resumeRecovery(new Error("embedding_worker_retiring"));
    });
  }

  private resumeRecovery(error?: Error): void {
    for (const waiting of [...this.recovery]) {
      this.recovery.delete(waiting);
      this.recoveryBytes -= waiting.bytes;
      clearTimeout(waiting.timer);
      if (error) waiting.reject(error);
      else void this.embed(waiting.texts).then(waiting.resolve, waiting.reject);
    }
  }

  private awaitRecovery(
    texts: readonly string[],
    bytes: number,
  ): Promise<readonly number[][]> {
    return new Promise((resolve, reject) => {
      const waiting: Recovery = {
        bytes,
        texts,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.recovery.delete(waiting);
          this.recoveryBytes -= bytes;
          reject(new Error("embedding_worker_retirement_timeout"));
        }, this.queueTimeoutMs),
      };
      this.recovery.add(waiting);
      this.recoveryBytes += bytes;
    });
  }

  private finish(id: number): Pending | undefined {
    const request = this.pending.get(id);
    if (!request) return undefined;
    clearTimeout(request.timer);
    this.pending.delete(id);
    this.pendingBytes -= request.bytes;
    return request;
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const active = this.workerFactory(this.workerUrl);
    this.worker = active;
    active.unref();
    active.on("error", () => this.fail(active, "embedding_worker_error"));
    active.on("exit", () => this.fail(active, "embedding_worker_exit"));
    active.on("message", (value: unknown) => {
      if (this.worker !== active) return;
      const response = value as {
        error?: unknown;
        errorName?: unknown;
        id?: unknown;
        vectors?: unknown;
        type?: unknown;
      } | null;
      if (!response || !Number.isSafeInteger(response.id)) {
        this.fail(active, "embedding_worker_protocol_error");
        return;
      }
      const id = response.id as number;
      const request = this.pending.get(id);
      if (!request) return;
      if (response.type === "started") {
        if (request.started) {
          this.fail(active, "embedding_worker_protocol_error");
          return;
        }
        request.started = true;
        clearTimeout(request.timer);
        request.timer = setTimeout(
          () => this.fail(active, "embedding_worker_timeout"),
          this.timeoutMs,
        );
        return;
      }
      if (typeof response.error === "string") {
        this.finish(id);
        request.reject(
          response.errorName === "EmbeddingUnavailableError"
            ? new EmbeddingUnavailableError(response.error)
            : response.errorName === "TypeError"
              ? new TypeError(response.error)
              : new Error(response.error),
        );
        return;
      }
      const vectors = response.vectors;
      if (
        !Array.isArray(vectors) ||
        vectors.length !== request.count ||
        vectors.some(
          (vector) =>
            !Array.isArray(vector) ||
            vector.length !== this.config.dimensions ||
            vector.some(
              (value: unknown) =>
                typeof value !== "number" || !Number.isFinite(value),
            ),
        )
      ) {
        this.fail(active, "embedding_worker_protocol_error");
        return;
      }
      this.finish(id);
      request.resolve(vectors);
    });
    return active;
  }

  embed(texts: readonly string[]): Promise<readonly number[][]> {
    if (this.closed)
      return Promise.reject(new Error("embedding_session_closed"));
    if (this.retirement && this.retirementFailed)
      return Promise.reject(new Error("embedding_worker_retiring"));
    const bytes = texts.reduce(
      (sum, text) =>
        sum + (typeof text === "string" ? Buffer.byteLength(text) : 0),
      0,
    );
    if (
      this.pending.size + this.recovery.size >= 128 ||
      this.pendingBytes + this.recoveryBytes + bytes > 128 * 1024 * 1024
    )
      return Promise.reject(
        new EmbeddingUnavailableError("embedding_queue_full"),
      );
    if (this.retirement) return this.awaitRecovery(texts, bytes);
    return new Promise((resolve, reject) => {
      let active: Worker;
      try {
        active = this.start();
      } catch (error) {
        reject(error);
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(
        () => this.fail(active, "embedding_worker_load_timeout"),
        this.queueTimeoutMs,
      );
      this.pending.set(id, {
        bytes,
        started: false,
        count: texts.length,
        reject,
        resolve,
        timer,
      });
      this.pendingBytes += bytes;
      try {
        active.postMessage({
          allowDownload: this.allowDownload,
          config: this.config,
          id,
          kind: this.kind,
          texts,
        } satisfies ModelWorkerRequest);
      } catch {
        this.fail(active, "embedding_worker_post_failed");
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.resumeRecovery(new Error("embedding_session_closed"));
    if (this.worker) this.fail(this.worker, "embedding_session_closed");
    if (!this.retirement) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.retirement,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new EmbeddingUnavailableError(
                  "embedding_worker_retirement_timeout",
                ),
              ),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

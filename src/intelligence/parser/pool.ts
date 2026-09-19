import { availableParallelism } from "node:os";

import { sha256 } from "./coordinates.ts";
import {
  type DynamicGrammarManifest,
  snapshotDynamicGrammarManifest,
} from "./registry.ts";
import {
  ParserError,
  type ParseSourceRequest,
  type SerializedParserError,
  type SyntaxFacts,
} from "./types.ts";

export type ParserWorkerFactory = (workerUrl: string) => Worker;

export interface ParserPoolOptions {
  defaultTimeoutMs?: number;
  dynamicGrammarManifest?: DynamicGrammarManifest;
  maxNodesPerJob?: number;
  maxOutstandingBytes?: number;
  maxParseCacheBytes?: number;
  maxParseCacheEntries?: number;
  maxSourceBytes?: number;
  maxWorkers?: number;
  minWorkers?: number;
  queueLimit?: number;
  workerFactory?: ParserWorkerFactory;
  workerUrl?: string;
}

export interface ParserJobOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface WorkerResultResponse {
  error?: SerializedParserError;
  facts?: SyntaxFacts;
  id: number;
  ok: boolean;
  type: "result";
}

interface WorkerReadyResponse {
  error?: SerializedParserError;
  ok: boolean;
  type: "ready";
}

type WorkerResponse = WorkerReadyResponse | WorkerResultResponse;

interface QueuedJob {
  abortHandler?: () => void;
  bytes: number;
  id: number;
  reject: (error: ParserError) => void;
  request: ParseSourceRequest;
  resolve: (facts: SyntaxFacts) => void;
  signal?: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerSlot {
  jobId: number | null;
  ready: boolean;
  worker: Worker;
}

interface ParseCacheEntry {
  bytes: number;
  facts: SyntaxFacts;
}

export interface ParserPoolStats {
  active: number;
  cache: {
    bytes: number;
    entries: number;
    evictions: number;
    hits: number;
    misses: number;
  };
  outstandingBytes: number;
  queued: number;
  state: "open" | "closing" | "closed";
  workers: number;
}

const parserError = (
  code: SerializedParserError["code"],
  message: string,
  retryable: boolean,
): ParserError => new ParserError({ code, message, retryable });

export class ParserWorkerPool {
  readonly #minWorkers: number;
  readonly #maxWorkers: number;
  readonly #queueLimit: number;
  readonly #maxNodesPerJob: number;
  readonly #maxSourceBytes: number;
  readonly #maxOutstandingBytes: number;
  readonly #maxParseCacheBytes: number;
  readonly #maxParseCacheEntries: number;
  readonly #defaultTimeoutMs: number;
  readonly #dynamicGrammarManifest?: DynamicGrammarManifest;
  readonly #workers: WorkerSlot[] = [];
  readonly #workerFactory: ParserWorkerFactory;
  readonly #workerUrl: string;
  readonly #pending: QueuedJob[] = [];
  readonly #jobs = new Map<number, QueuedJob>();
  readonly #drainWaiters: Array<() => void> = [];
  readonly #parseCache = new Map<string, ParseCacheEntry>();
  #cacheBytes = 0;
  #cacheEvictions = 0;
  #cacheHits = 0;
  #cacheMisses = 0;
  #nextJobId = 1;
  #outstandingBytes = 0;
  #state: "open" | "closing" | "closed" = "open";

  constructor(options: ParserPoolOptions = {}) {
    const adaptiveMaximum = Math.max(
      1,
      Math.min(4, availableParallelism() - 1),
    );
    this.#maxWorkers = options.maxWorkers ?? adaptiveMaximum;
    this.#minWorkers = options.minWorkers ?? 1;
    this.#queueLimit = options.queueLimit ?? 128;
    this.#maxNodesPerJob = options.maxNodesPerJob ?? 100_000;
    this.#maxSourceBytes = options.maxSourceBytes ?? 2 * 1024 * 1024;
    this.#maxOutstandingBytes = options.maxOutstandingBytes ?? 16 * 1024 * 1024;
    this.#maxParseCacheBytes = options.maxParseCacheBytes ?? 8 * 1024 * 1024;
    this.#maxParseCacheEntries = options.maxParseCacheEntries ?? 64;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#dynamicGrammarManifest = options.dynamicGrammarManifest
      ? snapshotDynamicGrammarManifest(options.dynamicGrammarManifest)
      : undefined;
    this.#workerFactory =
      options.workerFactory ??
      ((workerUrl) => new Worker(workerUrl, { type: "module" }));
    this.#workerUrl =
      options.workerUrl ?? new URL("./worker.ts", import.meta.url).href;
    if (
      !Number.isInteger(this.#minWorkers) ||
      !Number.isInteger(this.#maxWorkers) ||
      this.#minWorkers < 0 ||
      this.#maxWorkers < 1 ||
      this.#minWorkers > this.#maxWorkers
    ) {
      throw new TypeError("Parser worker bounds are invalid");
    }
    if (
      !Number.isInteger(this.#queueLimit) ||
      this.#queueLimit < 1 ||
      !Number.isInteger(this.#maxNodesPerJob) ||
      this.#maxNodesPerJob < 1 ||
      !Number.isInteger(this.#maxSourceBytes) ||
      this.#maxSourceBytes < 1 ||
      !Number.isInteger(this.#maxOutstandingBytes) ||
      this.#maxOutstandingBytes < this.#maxSourceBytes ||
      !Number.isInteger(this.#maxParseCacheBytes) ||
      this.#maxParseCacheBytes < 0 ||
      !Number.isInteger(this.#maxParseCacheEntries) ||
      this.#maxParseCacheEntries < 0 ||
      !Number.isInteger(this.#defaultTimeoutMs) ||
      this.#defaultTimeoutMs < 1
    ) {
      throw new TypeError(
        "Parser queue, memory, and timeout limits are invalid",
      );
    }
    while (this.#workers.length < this.#minWorkers) this.#spawnWorker();
  }

  get stats(): ParserPoolStats {
    return {
      active: this.#workers.filter((slot) => slot.jobId !== null).length,
      cache: {
        bytes: this.#cacheBytes,
        entries: this.#parseCache.size,
        evictions: this.#cacheEvictions,
        hits: this.#cacheHits,
        misses: this.#cacheMisses,
      },
      outstandingBytes: this.#outstandingBytes,
      queued: this.#pending.length,
      state: this.#state,
      workers: this.#workers.length,
    };
  }

  parse(
    request: ParseSourceRequest,
    options: ParserJobOptions = {},
  ): Promise<SyntaxFacts> {
    if (this.#state !== "open") {
      return Promise.reject(
        parserError("closed", "Parser worker pool is closed", false),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        parserError("aborted", "Parser request was aborted", true),
      );
    }
    if (
      request.maxNodes !== undefined &&
      (!Number.isFinite(request.maxNodes) ||
        !Number.isInteger(request.maxNodes) ||
        request.maxNodes < 1)
    ) {
      return Promise.reject(
        parserError(
          "invalid-request",
          "Parser maxNodes must be a finite positive integer",
          false,
        ),
      );
    }
    const bytes = new TextEncoder().encode(request.source).byteLength;
    if (bytes > this.#maxSourceBytes) {
      return Promise.reject(
        parserError(
          "source-too-large",
          "Parser source exceeds the configured byte limit",
          false,
        ),
      );
    }
    if (
      this.#jobs.size >= this.#queueLimit ||
      this.#outstandingBytes + bytes > this.#maxOutstandingBytes
    ) {
      return Promise.reject(
        parserError("queue-full", "Parser worker queue is full", true),
      );
    }
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(
        parserError(
          "timeout",
          "Parser timeout must be a positive integer",
          false,
        ),
      );
    }

    const cacheKey = this.#cacheKey(request);
    const cached = this.#parseCache.get(cacheKey);
    if (cached) {
      this.#parseCache.delete(cacheKey);
      this.#parseCache.set(cacheKey, cached);
      this.#cacheHits += 1;
      return Promise.resolve(structuredClone(cached.facts));
    }
    this.#cacheMisses += 1;

    return new Promise<SyntaxFacts>((resolve, reject) => {
      const id = this.#nextJobId;
      this.#nextJobId += 1;
      const job: QueuedJob = {
        bytes,
        id,
        reject,
        request,
        resolve,
        timer: setTimeout(() => {
          this.#cancel(
            id,
            parserError("timeout", "Parser request timed out", true),
          );
        }, timeoutMs),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (options.signal) {
        job.abortHandler = () => {
          this.#cancel(
            id,
            parserError("aborted", "Parser request was aborted", true),
          );
        };
        options.signal.addEventListener("abort", job.abortHandler, {
          once: true,
        });
      }
      this.#jobs.set(id, job);
      this.#pending.push(job);
      this.#outstandingBytes += bytes;
      this.#dispatch();
    });
  }

  async close(options: { drain?: boolean } = {}): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closing";
    if (!options.drain) {
      for (const id of [...this.#jobs.keys()]) {
        this.#cancel(
          id,
          parserError(
            "closed",
            "Parser worker pool closed before completion",
            true,
          ),
        );
      }
    }
    if (this.#jobs.size > 0) {
      await new Promise<void>((resolve) => this.#drainWaiters.push(resolve));
    }
    this.#terminateAll();
  }

  #spawnWorker(): WorkerSlot {
    const worker = this.#workerFactory(this.#workerUrl);
    const slot: WorkerSlot = { jobId: null, ready: false, worker };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      this.#handleMessage(slot, event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      this.#handleWorkerFailure(slot, event.message || "Parser worker failed");
    };
    this.#workers.push(slot);
    worker.postMessage({
      manifest: this.#dynamicGrammarManifest,
      type: "initialize",
    });
    return slot;
  }

  #dispatch(): void {
    if (this.#state === "closed") return;
    while (
      this.#pending.length >
        this.#workers.filter((slot) => slot.ready && slot.jobId === null)
          .length &&
      this.#workers.length < this.#maxWorkers
    ) {
      this.#spawnWorker();
    }
    for (const slot of this.#workers) {
      if (!slot.ready || slot.jobId !== null) continue;
      const job = this.#pending.shift();
      if (!job) break;
      slot.jobId = job.id;
      slot.worker.postMessage({
        id: job.id,
        request: {
          ...job.request,
          maxNodes: Math.min(
            job.request.maxNodes ?? this.#maxNodesPerJob,
            this.#maxNodesPerJob,
          ),
        },
        type: "parse",
      });
    }
  }

  #handleMessage(slot: WorkerSlot, response: WorkerResponse): void {
    if (response.type === "ready") {
      if (!response.ok) {
        this.#handleWorkerFailure(
          slot,
          response.error?.message ?? "Parser worker initialization failed",
        );
        return;
      }
      slot.ready = true;
      this.#dispatch();
      return;
    }
    if (slot.jobId !== response.id) return;
    const job = this.#jobs.get(response.id);
    slot.jobId = null;
    if (!job) {
      this.#dispatch();
      return;
    }
    this.#forget(job);
    if (response.ok && response.facts) {
      this.#cacheResult(this.#cacheKey(job.request), response.facts);
      job.resolve(structuredClone(response.facts));
    } else {
      job.reject(
        new ParserError(
          response.error ?? {
            code: "worker-error",
            message: "Parser worker returned an invalid response",
            retryable: false,
          },
        ),
      );
    }
    this.#afterSettlement();
  }

  #handleWorkerFailure(slot: WorkerSlot, message: string): void {
    const jobId = slot.jobId;
    const failedDuringInitialization = !slot.ready;
    this.#removeWorker(slot);
    if (failedDuringInitialization) {
      for (const job of [...this.#jobs.values()]) {
        this.#forget(job);
        job.reject(parserError("worker-error", message, false));
      }
      this.#pending.length = 0;
      this.#terminateAll();
      return;
    }
    if (jobId !== null) {
      const job = this.#jobs.get(jobId);
      if (job) {
        this.#forget(job);
        job.reject(parserError("worker-error", message, true));
      }
    }
    this.#afterSettlement();
  }

  #cancel(id: number, error: ParserError): void {
    const job = this.#jobs.get(id);
    if (!job) return;
    const pendingIndex = this.#pending.findIndex(
      (candidate) => candidate.id === id,
    );
    if (pendingIndex >= 0) this.#pending.splice(pendingIndex, 1);
    const slot = this.#workers.find((candidate) => candidate.jobId === id);
    if (slot) this.#removeWorker(slot);
    this.#forget(job);
    job.reject(error);
    this.#afterSettlement();
  }

  #forget(job: QueuedJob): void {
    clearTimeout(job.timer);
    if (job.signal && job.abortHandler) {
      job.signal.removeEventListener("abort", job.abortHandler);
    }
    this.#jobs.delete(job.id);
    this.#outstandingBytes -= job.bytes;
  }

  #removeWorker(slot: WorkerSlot): void {
    const index = this.#workers.indexOf(slot);
    if (index >= 0) this.#workers.splice(index, 1);
    slot.worker.terminate();
  }

  #afterSettlement(): void {
    if (
      this.#state !== "closed" &&
      (this.#pending.length > 0 ||
        (this.#state === "open" && this.#workers.length < this.#minWorkers))
    ) {
      while (
        this.#workers.length < this.#minWorkers &&
        this.#workers.length < this.#maxWorkers
      ) {
        this.#spawnWorker();
      }
      this.#dispatch();
    }
    if (this.#jobs.size === 0 && this.#state === "closing") {
      for (const resolve of this.#drainWaiters.splice(0)) resolve();
    }
  }

  #cacheKey(request: ParseSourceRequest): string {
    return sha256(
      JSON.stringify({
        extractorVersion: request.extractorVersion ?? null,
        grammarManifestFingerprint:
          this.#dynamicGrammarManifest?.fingerprint ?? "native",
        grammarVersion: request.grammarVersion ?? null,
        languageId: request.languageId,
        maxNodes: Math.min(
          request.maxNodes ?? this.#maxNodesPerJob,
          this.#maxNodesPerJob,
        ),
        sourceDigest: sha256(request.source),
      }),
    );
  }

  #cacheResult(key: string, facts: SyntaxFacts): void {
    if (this.#maxParseCacheEntries === 0 || this.#maxParseCacheBytes === 0)
      return;
    const snapshot = structuredClone(facts);
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    if (bytes > this.#maxParseCacheBytes) return;
    const existing = this.#parseCache.get(key);
    if (existing) {
      this.#cacheBytes -= existing.bytes;
      this.#parseCache.delete(key);
    }
    this.#parseCache.set(key, { bytes, facts: snapshot });
    this.#cacheBytes += bytes;
    while (
      this.#parseCache.size > this.#maxParseCacheEntries ||
      this.#cacheBytes > this.#maxParseCacheBytes
    ) {
      const oldestKey = this.#parseCache.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.#parseCache.get(oldestKey);
      this.#parseCache.delete(oldestKey);
      this.#cacheBytes -= evicted?.bytes ?? 0;
      this.#cacheEvictions += 1;
    }
  }

  #clearCache(): void {
    this.#parseCache.clear();
    this.#cacheBytes = 0;
  }

  #terminateAll(): void {
    for (const slot of this.#workers.splice(0)) slot.worker.terminate();
    this.#clearCache();
    this.#state = "closed";
    for (const resolve of this.#drainWaiters.splice(0)) resolve();
  }
}

import { Worker } from "node:worker_threads";

import type {
  SqlAdapter,
  SqlAdapterRequest,
  SqlAdapterResult,
} from "./sql-assistance";

interface PostgresAdapterOptions {
  maxPending?: number;
  maxOutstandingBytes?: number;
  maxSourceBytes?: number;
  timeoutMs?: number;
  workerFactory?: (url: URL) => Worker;
  workerUrl?: URL;
}

interface Task {
  bytes: number;
  request: SqlAdapterRequest;
  settled: boolean;
  released: boolean;
  cleanup(): void;
  resolve(result: SqlAdapterResult): void;
  reject(reason: unknown): void;
  worker?: Worker;
}

const unavailable = (): SqlAdapterResult => ({
  status: "unavailable",
  complete: false,
  scope: "sql",
});
const unsupported = (): SqlAdapterResult => ({
  status: "unsupported",
  complete: false,
  scope: "sql",
});

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function response(value: unknown): SqlAdapterResult {
  if (typeof value !== "object" || value === null) return unavailable();
  const raw = value as Partial<SqlAdapterResult>;
  if (
    !["valid", "invalid", "unsupported", "unavailable"].includes(
      raw.status ?? "",
    ) ||
    typeof raw.complete !== "boolean" ||
    !["sql", "sql-and-procedural"].includes(raw.scope ?? "") ||
    (raw.diagnostics !== undefined && !Array.isArray(raw.diagnostics)) ||
    ((raw.status === "valid" || raw.status === "invalid") && !raw.complete)
  )
    return unavailable();
  return {
    status: raw.status!,
    complete: raw.complete,
    scope: raw.scope!,
    diagnostics: raw.diagnostics?.slice(0, 20).map((diagnostic) => ({
      message: "SQL syntax rejected by the selected validator",
      ...(Number.isSafeInteger(diagnostic?.line) && diagnostic.line! >= 0
        ? { line: diagnostic.line }
        : {}),
      ...(Number.isSafeInteger(diagnostic?.column) && diagnostic.column! >= 0
        ? { column: diagnostic.column }
        : {}),
      ...(Number.isSafeInteger(diagnostic?.offset) && diagnostic.offset! >= 0
        ? { offset: diagnostic.offset }
        : {}),
    })),
  };
}

/**
 * Optional parse work uses fresh workers to reclaim each WASM heap.
 * Capacity remains reserved until worker termination is confirmed.
 */
export class PostgresSqlAdapter implements SqlAdapter {
  readonly id = "libpg-query";
  readonly version = "18.2.2";
  readonly #queue: Task[] = [];
  readonly #active = new Set<Task>();
  #pending = 0;
  #bytes = 0;
  readonly #limits;

  constructor(private readonly options: PostgresAdapterOptions = {}) {
    this.#limits = {
      maxPending: options.maxPending ?? 8,
      maxOutstandingBytes: options.maxOutstandingBytes ?? 2 * 1024 * 1024,
      maxSourceBytes: options.maxSourceBytes ?? 512 * 1024,
      timeoutMs: options.timeoutMs ?? 5000,
    };
    if (Object.values(this.#limits).some((value) => !positive(value)))
      throw new TypeError("Invalid PostgreSQL adapter resource limit");
  }

  stats(): { pending: number; active: number; outstandingBytes: number } {
    return {
      pending: this.#pending,
      active: this.#active.size,
      outstandingBytes: this.#bytes,
    };
  }

  async validate(request: SqlAdapterRequest): Promise<SqlAdapterResult> {
    request.signal.throwIfAborted();
    if (
      request.dialect !== "postgresql" ||
      (request.version !== undefined && request.version !== "18") ||
      (request.variant !== undefined && request.variant !== "sql")
    )
      return Promise.resolve(unsupported());
    const bytes = Buffer.byteLength(request.source);
    if (
      bytes > this.#limits.maxSourceBytes ||
      this.#pending >= this.#limits.maxPending ||
      this.#bytes + bytes > this.#limits.maxOutstandingBytes
    )
      return Promise.resolve(unavailable());

    return new Promise((resolve, reject) => {
      this.#pending++;
      this.#bytes += bytes;
      const snapshot = { ...request };
      let task: Task;
      const abort = () => {
        void this.#settle(task, unavailable(), snapshot.signal.reason);
      };
      const timer = setTimeout(() => {
        void this.#settle(task, unavailable());
      }, this.#limits.timeoutMs);
      task = {
        bytes,
        request: snapshot,
        settled: false,
        released: false,
        cleanup: () => {
          clearTimeout(timer);
          snapshot.signal.removeEventListener("abort", abort);
        },
        resolve,
        reject,
      };
      snapshot.signal.addEventListener("abort", abort, { once: true });
      this.#queue.push(task);
      if (snapshot.signal.aborted) abort();
      this.#dispatch();
    });
  }

  #release(task: Task): void {
    if (task.released) return;
    task.released = true;
    this.#active.delete(task);
    this.#pending--;
    this.#bytes -= task.bytes;
    this.#dispatch();
  }

  async #settle(
    task: Task,
    result: SqlAdapterResult,
    cancellation?: unknown,
  ): Promise<void> {
    if (task.settled) return;
    task.settled = true;
    task.cleanup();
    const queued = this.#queue.indexOf(task);
    if (queued >= 0) this.#queue.splice(queued, 1);
    if (task.worker && !task.released) {
      // Retirement has its own bounded budget. Unconfirmed threads retain their
      // capacity reservation even after the caller receives unavailable.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let termination: Promise<boolean>;
      try {
        termination = task.worker.terminate().then(
          () => {
            this.#release(task);
            return true;
          },
          () => false,
        );
      } catch {
        termination = Promise.resolve(false);
      }
      const retired = await Promise.race([
        termination,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.#limits.timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (!retired) result = unavailable();
    } else {
      this.#release(task);
    }
    if (cancellation !== undefined) task.reject(cancellation);
    else task.resolve(result);
  }

  #dispatch(): void {
    if (this.#active.size > 0) return;
    const task = this.#queue.shift();
    if (!task) return;
    if (task.settled) {
      this.#dispatch();
      return;
    }
    this.#active.add(task);
    try {
      const worker = (this.options.workerFactory ?? ((url) => new Worker(url)))(
        this.options.workerUrl ??
          new URL("./sql-postgres-worker.ts", import.meta.url),
      );
      task.worker = worker;
      worker.unref();
      worker.once("error", () => {
        void this.#settle(task, unavailable());
      });
      worker.once("exit", () => {
        // Exit and terminate confirmation are independent retirement proofs.
        this.#release(task);
        void this.#settle(task, unavailable());
      });
      worker.once("message", (value: unknown) => {
        void this.#settle(task, response(value));
      });
      worker.postMessage({
        source: task.request.source,
        variant: task.request.variant ?? "sql",
      });
    } catch {
      void this.#settle(task, unavailable());
    }
  }
}

const adapter = new PostgresSqlAdapter();

export async function loadPostgresSqlAdapter(): Promise<SqlAdapter> {
  return adapter;
}

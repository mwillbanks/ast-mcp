import { Worker } from "node:worker_threads";

import {
  defaultLanguageRegistry,
  type DynamicGrammarManifest,
} from "../../intelligence/parser/registry.ts";
import type { PatchStrategyName } from "../../runtime/file-capabilities.ts";
import type {
  PatchStrategyContext,
  PreparedStrategyPatch,
} from "../strategy.ts";

interface Task {
  bytes: number;
  cleanup(): void;
  context: PatchStrategyContext;
  manifest?: DynamicGrammarManifest;
  reject(error: Error): void;
  resolve(patch: PreparedStrategyPatch): void;
  settled: boolean;
  strategy: PatchStrategyName;
  worker?: Worker;
}

interface WorkerOptions {
  maxBytes?: number;
  maxPending?: number;
  maxWorkers?: number;
  timeoutMs?: number;
  workerFactory?: (url: URL) => Worker;
  workerUrl?: URL;
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: true });
}

/** Preparation is read-only; only the owning runtime can publish its result. */
export class PatchPreparationPool {
  private readonly queue: Task[] = [];
  private readonly active = new Set<Task>();
  private bytes = 0;
  private pending = 0;

  constructor(private readonly options: WorkerOptions = {}) {}

  prepare(
    strategy: PatchStrategyName,
    context: PatchStrategyContext,
  ): Promise<PreparedStrategyPatch> {
    if (context.signal?.aborted)
      return Promise.reject(failure("aborted", "Patch preparation aborted"));
    const bytes =
      Buffer.byteLength(context.original) +
      Buffer.byteLength(
        JSON.stringify([context.astRules, context.aiderBlocks]),
      );
    if (
      this.pending >= (this.options.maxPending ?? 128) ||
      this.bytes + bytes > (this.options.maxBytes ?? 128 * 1024 * 1024)
    )
      return Promise.reject(
        failure("patch_queue_full", "Patch preparation capacity exceeded"),
      );
    let snapshot: PatchStrategyContext;
    let manifest: DynamicGrammarManifest | undefined;
    try {
      const { signal: _signal, ...serializable } = context;
      snapshot = { ...structuredClone(serializable), signal: context.signal };
      manifest =
        strategy === "ast"
          ? defaultLanguageRegistry.dynamicManifest()
          : undefined;
    } catch {
      return Promise.reject(
        failure(
          "patch_worker_start",
          "Patch preparation request could not be cloned",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      this.bytes += bytes;
      this.pending++;
      let task: Task;
      const abort = () =>
        this.settle(task, failure("aborted", "Patch preparation aborted"));
      const timer = setTimeout(
        () =>
          this.settle(
            task,
            failure("patch_timeout", "Patch preparation timed out"),
          ),
        this.options.timeoutMs ?? 30_000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", abort);
      };
      task = {
        bytes,
        cleanup,
        context: snapshot,
        manifest,
        reject,
        resolve,
        settled: false,
        strategy,
      };
      context.signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(task);
      if (context.signal?.aborted) abort();
      this.dispatch();
    });
  }

  private release(task: Task): void {
    this.active.delete(task);
    this.bytes -= task.bytes;
    this.pending--;
    this.dispatch();
  }

  private settle(
    task: Task,
    error?: Error,
    patch?: PreparedStrategyPatch,
  ): void {
    if (task.settled) return;
    task.settled = true;
    task.cleanup();
    if (error) task.reject(error);
    else task.resolve(patch!);
    const queued = this.queue.indexOf(task);
    if (queued >= 0) this.queue.splice(queued, 1);
    if (task.worker) {
      // Quarantine native work until its thread is actually gone.
      void Promise.resolve()
        .then(() => task.worker!.terminate())
        .then(
          () => this.release(task),
          () => {},
        );
    } else this.release(task);
  }

  private dispatch(): void {
    while (
      this.queue.length &&
      this.active.size < (this.options.maxWorkers ?? 4)
    ) {
      const task = this.queue.shift()!;
      if (task.settled) continue;
      this.active.add(task);
      try {
        const worker = (
          this.options.workerFactory ?? ((url) => new Worker(url))
        )(this.options.workerUrl ?? new URL("./worker.ts", import.meta.url));
        task.worker = worker;
        worker.unref();
        worker.once("error", () =>
          this.settle(
            task,
            failure("patch_worker_error", "Patch preparation worker failed"),
          ),
        );
        worker.once("exit", () =>
          this.settle(
            task,
            failure("patch_worker_exit", "Patch preparation worker exited"),
          ),
        );
        worker.once("message", (value: unknown) => {
          const result = value as {
            ok?: unknown;
            patch?: PreparedStrategyPatch;
            error?: Record<string, unknown>;
          } | null;
          if (
            result?.ok === true &&
            typeof result.patch?.candidate === "string" &&
            result.patch.metadata?.strategy === task.strategy &&
            Number.isSafeInteger(result.patch.metadata.operations)
          ) {
            this.settle(task, undefined, result.patch);
          } else if (
            result?.ok === false &&
            typeof result.error?.message === "string"
          ) {
            const error =
              result.error.name === "TypeError"
                ? new TypeError(result.error.message)
                : new Error(result.error.message);
            this.settle(task, Object.assign(error, result.error));
          } else
            this.settle(
              task,
              failure(
                "patch_worker_protocol",
                "Patch preparation worker returned an invalid response",
              ),
            );
        });
        const { signal: _signal, ...context } = task.context;
        worker.postMessage({
          context,
          strategy: task.strategy,
          manifest: task.manifest,
        });
      } catch {
        this.settle(
          task,
          failure(
            "patch_worker_start",
            "Patch preparation worker could not start",
          ),
        );
      }
    }
  }
}

const pool = new PatchPreparationPool();

export function preparePatchIsolated(
  strategy: PatchStrategyName,
  context: PatchStrategyContext,
): Promise<PreparedStrategyPatch> {
  return pool.prepare(strategy, context);
}

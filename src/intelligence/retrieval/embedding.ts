import {
  InlineTransformersProvider,
  InlinePotionProvider,
  createPotionStaticSession,
  EmbeddingCancelledError,
  EmbeddingQueueFullError,
  EmbeddingUnavailableError,
  type EmbeddingProvider,
  type EmbeddingTaskOptions,
} from "./model-provider.ts";
import type { EmbeddingModelConfig } from "./types.ts";
import { ManagedModelSession } from "./worker-session.ts";

export * from "./model-provider.ts";

export class TransformersEmbeddingProvider extends InlineTransformersProvider {
  private managed?: ManagedModelSession;
  private managedClosed = false;
  private readonly isolated: boolean;
  private readonly downloadsAllowed: boolean;

  constructor(
    ...args: ConstructorParameters<typeof InlineTransformersProvider>
  ) {
    super(...args);
    this.isolated = !args[2];
    this.downloadsAllowed = args[1] ?? false;
  }

  override async embed(texts: readonly string[]): Promise<readonly number[][]> {
    if (!this.isolated) return await super.embed(texts);
    if (texts.length === 0) return [];
    if (this.managedClosed)
      throw new EmbeddingUnavailableError("embedding_session_closed");
    this.managed ??= new ManagedModelSession(
      this.config,
      "transformers",
      this.downloadsAllowed,
    );
    return await this.managed.embed(texts);
  }

  override async close(): Promise<void> {
    this.managedClosed = true;
    if (this.isolated) await this.managed?.close();
    else await super.close();
  }
}

export class PotionStaticEmbeddingProvider extends InlinePotionProvider {
  private managed?: ManagedModelSession;
  private managedClosed = false;
  private readonly isolated: boolean;

  constructor(...args: ConstructorParameters<typeof InlinePotionProvider>) {
    super(...args);
    this.isolated = !args[1] || args[1] === createPotionStaticSession;
  }

  override async embed(texts: readonly string[]): Promise<readonly number[][]> {
    if (!this.isolated) return await super.embed(texts);
    if (texts.length === 0) return [];
    if (this.managedClosed)
      throw new EmbeddingUnavailableError("embedding_session_closed");
    this.managed ??= new ManagedModelSession(this.config, "potion");
    return await this.managed.embed(texts);
  }

  override async close(): Promise<void> {
    this.managedClosed = true;
    if (this.isolated) await this.managed?.close();
    else await super.close();
  }
}

interface PendingTask {
  attempts: number;
  reject: (error: unknown) => void;
  resolve: (value: readonly number[]) => void;
  retries: number;
  signal?: AbortSignal;
  text: string;
}

export class EmbeddingWorkerPool {
  private readonly provider: EmbeddingProvider;
  private readonly queue: PendingTask[] = [];
  private readonly running: boolean[];
  private readonly drains = new Set<Promise<void>>();
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(
    private readonly config: EmbeddingModelConfig,
    providerFactory: (worker: number) => EmbeddingProvider,
  ) {
    this.provider = providerFactory(0);
    this.running = Array.from({ length: config.workers }, () => false);
  }

  get pending(): number {
    return this.queue.length + this.running.filter(Boolean).length;
  }

  embed(
    text: string,
    options: EmbeddingTaskOptions = {},
  ): Promise<readonly number[]> {
    if (this.closed)
      return Promise.reject(
        new EmbeddingUnavailableError("embedding_pool_closed"),
      );
    if (options.signal?.aborted)
      return Promise.reject(new EmbeddingCancelledError());
    if (this.queue.length >= this.config.maxQueue)
      return Promise.reject(new EmbeddingQueueFullError(this.config.maxQueue));
    return new Promise((resolve, reject) => {
      const task: PendingTask = {
        attempts: 0,
        reject: (error) => {
          options.signal?.removeEventListener("abort", aborted);
          reject(error);
        },
        resolve: (value) => {
          options.signal?.removeEventListener("abort", aborted);
          resolve(value);
        },
        retries: options.retries ?? 2,
        signal: options.signal,
        text,
      };
      const aborted = () => {
        const index = this.queue.indexOf(task);
        if (index >= 0) this.queue.splice(index, 1);
        task.reject(new EmbeddingCancelledError());
      };
      options.signal?.addEventListener("abort", aborted, { once: true });
      this.queue.push(task);
      if (options.signal?.aborted) aborted();
      this.schedule();
    });
  }

  private schedule(): void {
    this.running.forEach((_, worker) => {
      if (!this.running[worker] && this.queue.length > 0) {
        const drain = this.drain(worker);
        this.drains.add(drain);
        void drain.finally(() => this.drains.delete(drain));
      }
    });
  }

  private takeBatch(): PendingTask[] {
    const adaptive = Math.min(
      this.config.batchSize,
      Math.max(1, Math.ceil(this.queue.length / this.running.length)),
    );
    const batch: PendingTask[] = [];
    while (batch.length < adaptive && this.queue.length) {
      const task = this.queue.shift();
      if (!task) break;
      if (task.signal?.aborted) task.reject(new EmbeddingCancelledError());
      else batch.push(task);
    }
    return batch;
  }

  private async drain(worker: number): Promise<void> {
    this.running[worker] = true;
    try {
      while (!this.closed) {
        const batch = this.takeBatch();
        if (batch.length === 0) break;
        try {
          const vectors = await this.provider.embed(
            batch.map(({ text }) => text),
          );
          if (vectors.length !== batch.length)
            throw new TypeError("embedding_provider_batch_mismatch");
          batch.forEach((task, index) => {
            if (task.signal?.aborted)
              task.reject(new EmbeddingCancelledError());
            else task.resolve(vectors[index] ?? []);
          });
        } catch (error) {
          for (const task of batch) {
            task.attempts += 1;
            if (
              !this.closed &&
              !task.signal?.aborted &&
              task.attempts <= task.retries
            )
              this.queue.push(task);
            else
              task.reject(
                this.closed || task.signal?.aborted
                  ? new EmbeddingCancelledError()
                  : error,
              );
          }
        }
      }
    } finally {
      this.running[worker] = false;
      if (!this.closed && this.queue.length) this.schedule();
    }
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      for (const task of this.queue.splice(0))
        task.reject(new EmbeddingCancelledError());
      this.closePromise = (async () => {
        await Promise.all([...this.drains]);
        await this.provider.close();
      })();
    }
    await this.closePromise;
  }
}
export * from "./model-provider.ts";

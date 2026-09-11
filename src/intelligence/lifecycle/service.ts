import type { ResolvedConfig } from "../../config.ts";
import { currentConfig } from "../../config.ts";
import {
  ParserWorkerPool,
  type ParseSourceRequest,
  type SyntaxFacts,
} from "../parser/index.ts";
import {
  type EmbeddingModelConfig,
  type EmbeddingProvider,
  EmbeddingWorkerPool,
  modelSpaceId,
  POTION_CODE_BENCHMARK_MODEL,
  PotionStaticEmbeddingProvider,
  TransformersEmbeddingProvider,
} from "../retrieval/index.ts";
import type { WorkspaceHandle } from "../workspace/context.ts";
import {
  type IntelligenceAnalysis,
  type IntelligenceDispatchRequest,
  IntelligenceSourceDispatcher,
} from "./dispatcher.ts";

export interface EmbeddingRuntimeContext {
  revisionId?: string;
  selectorKind?: WorkspaceHandle["selectedRevision"]["selector"]["kind"];
}

export interface ParserPoolLifecycle {
  close(options?: { drain?: boolean }): Promise<void>;
  parse(
    request: ParseSourceRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SyntaxFacts>;
}

export interface IntelligenceDispatcherLifecycle {
  analyze(
    request: IntelligenceDispatchRequest,
  ): Promise<IntelligenceAnalysis | null>;
  close(): Promise<void>;
}

export interface IntelligenceRuntimeOptions {
  allowEmbeddingDownload?: boolean;
  config?: () => Promise<ResolvedConfig>;
  dispatcher?: IntelligenceDispatcherLifecycle;
  embeddingProviderFactory?: (
    config: EmbeddingModelConfig,
    context: EmbeddingRuntimeContext,
  ) => EmbeddingProvider;
  parserPool?: ParserPoolLifecycle;
}

export interface IndexRuntimeResources {
  analyze: IntelligenceDispatcherLifecycle["analyze"];
  embedding?: {
    config: EmbeddingModelConfig;
    pool: EmbeddingWorkerPool;
  };
  parse: (
    request: ParseSourceRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<SyntaxFacts>;
}

export class IntelligenceRuntime {
  readonly #config: () => Promise<ResolvedConfig>;
  readonly #embeddingProviderFactory: (
    config: EmbeddingModelConfig,
    context: EmbeddingRuntimeContext,
  ) => EmbeddingProvider;
  readonly #parserPool: ParserPoolLifecycle;
  readonly #dispatcher: IntelligenceDispatcherLifecycle;
  readonly #embeddingPools = new Map<string, EmbeddingWorkerPool>();
  readonly #retiredPools = new Set<Promise<void>>();
  #closePromise?: Promise<void>;
  #closed = false;

  constructor(options: IntelligenceRuntimeOptions = {}) {
    this.#config = options.config ?? currentConfig;
    this.#parserPool =
      options.parserPool ??
      new ParserWorkerPool({
        minWorkers: 0,
      });
    this.#dispatcher =
      options.dispatcher ??
      new IntelligenceSourceDispatcher({
        parse: this.#parserPool.parse.bind(this.#parserPool),
      });
    const allowDownload = options.allowEmbeddingDownload ?? true;
    this.#embeddingProviderFactory =
      options.embeddingProviderFactory ??
      ((config) =>
        config.modelId === POTION_CODE_BENCHMARK_MODEL.modelId
          ? new PotionStaticEmbeddingProvider(config)
          : new TransformersEmbeddingProvider(config, allowDownload));
  }

  async indexResources(
    workspace?: WorkspaceHandle,
  ): Promise<IndexRuntimeResources> {
    this.#assertOpen();
    const config = await this.#config();
    return {
      analyze: this.#dispatcher.analyze.bind(this.#dispatcher),
      ...(config.intelligence.retrieval.semantic
        ? {
            embedding: this.#embedding(
              config.intelligence.retrieval.embedding,
              workspace,
            ),
          }
        : {}),
      parse: this.#parserPool.parse.bind(this.#parserPool),
    };
  }

  async queryVector(
    text: string,
    semantic: boolean,
    workspace?: WorkspaceHandle,
  ): Promise<{
    config: EmbeddingModelConfig;
    vector?: readonly number[];
  }> {
    this.#assertOpen();
    const config = await this.#config();
    const model = config.intelligence.retrieval.embedding;
    if (!semantic) return { config: model };
    return {
      config: model,
      vector: await this.#embedding(model, workspace).pool.embed(text),
    };
  }

  async close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closed = true;
      this.#closePromise = (async () => {
        await this.#dispatcher.close();
        await this.#parserPool.close({ drain: true });
        await Promise.all([
          ...[...this.#embeddingPools.values()].map((pool) => pool.close()),
          ...this.#retiredPools,
        ]);
        this.#embeddingPools.clear();
      })();
    }
    await this.#closePromise;
  }

  #embedding(
    config: EmbeddingModelConfig,
    workspace?: WorkspaceHandle,
  ): {
    config: EmbeddingModelConfig;
    pool: EmbeddingWorkerPool;
  } {
    const key = modelSpaceId(config);
    let pool = this.#embeddingPools.get(key);
    if (pool) {
      this.#embeddingPools.delete(key);
      this.#embeddingPools.set(key, pool);
    } else {
      pool = new EmbeddingWorkerPool(config, () =>
        this.#embeddingProviderFactory(config, {
          revisionId: workspace?.selectedRevision.revisionId,
          selectorKind: workspace?.selectedRevision.selector.kind,
        }),
      );
      this.#embeddingPools.set(key, pool);
      if (this.#embeddingPools.size > 2) {
        const oldest = this.#embeddingPools.entries().next().value as
          | [string, EmbeddingWorkerPool]
          | undefined;
        if (oldest) {
          this.#embeddingPools.delete(oldest[0]);
          const retirement = oldest[1].close();
          this.#retiredPools.add(retirement);
          void retirement.then(
            () => this.#retiredPools.delete(retirement),
            () => this.#retiredPools.delete(retirement),
          );
        }
      }
    }
    return { config, pool };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("intelligence_runtime_closed");
  }
}

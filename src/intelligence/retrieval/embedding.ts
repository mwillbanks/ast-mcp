import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type EmbeddingModelConfig,
  EmbeddingModelConfigSchema,
  POTION_CODE_BENCHMARK_MODEL,
} from "./types.ts";

export type EmbeddingProviderRuntime = "onnx-transformer" | "static-retrieval";

export interface EmbeddingProvider {
  close(): Promise<void>;
  readonly config: EmbeddingModelConfig;
  embed(texts: readonly string[]): Promise<readonly number[][]>;
  readonly runtime?: EmbeddingProviderRuntime;
}

export interface EmbeddingTaskOptions {
  retries?: number;
  signal?: AbortSignal;
}

export class EmbeddingQueueFullError extends Error {
  constructor(readonly maxQueue: number) {
    super("embedding_queue_full");
    this.name = "EmbeddingQueueFullError";
  }
}

export class EmbeddingCancelledError extends Error {
  constructor() {
    super("embedding_cancelled");
    this.name = "EmbeddingCancelledError";
  }
}

export class EmbeddingUnavailableError extends Error {
  constructor(message = "embedding_model_not_configured") {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

export function normalizeEmbedding(
  values: ArrayLike<number>,
  dimensions?: number,
): number[] {
  const vector = Array.from(values, Number);
  if (dimensions !== undefined && vector.length !== dimensions)
    throw new TypeError(
      `embedding_dimension_mismatch:${vector.length}:${dimensions}`,
    );
  if (vector.some((value) => !Number.isFinite(value)))
    throw new TypeError("embedding_non_finite");
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  if (!Number.isFinite(magnitude) || magnitude === 0)
    throw new TypeError("embedding_zero_norm");
  return vector.map((value) => value / magnitude);
}

export function artifactManifestFingerprint(
  configInput: EmbeddingModelConfig,
): string {
  const config = EmbeddingModelConfigSchema.parse(configInput);
  const manifest = Object.entries(config.artifacts).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export function modelSpaceId(configInput: EmbeddingModelConfig): string {
  const config = EmbeddingModelConfigSchema.parse(configInput);
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.modelId,
        config.revision,
        config.dimensions,
        config.dtype,
        config.pooling,
        artifactManifestFingerprint(config),
      ]),
    )
    .digest("hex");
}

function artifactDigest(kind: string, bytes: Uint8Array): string {
  if (kind === "sha256")
    return createHash("sha256").update(bytes).digest("hex");
  if (kind === "git-sha1") {
    const prefix = Buffer.from(`blob ${bytes.byteLength}\0`);
    return createHash("sha1").update(prefix).update(bytes).digest("hex");
  }
  throw new TypeError(`unsupported_checksum:${kind}`);
}

export async function verifyLocalModelArtifacts(
  configInput: EmbeddingModelConfig,
): Promise<void> {
  const config = EmbeddingModelConfigSchema.parse(configInput);
  if (!config.localPath) throw new EmbeddingUnavailableError();
  for (const [name, encoded] of Object.entries(config.artifacts)) {
    if (
      isAbsolute(name) ||
      name.length === 0 ||
      name.split(/[\\/]/u).some((part) => part === ".." || part.length === 0)
    )
      throw new TypeError(`invalid_artifact_name:${name}`);
    const separator = encoded.indexOf(":");
    if (separator < 1) throw new TypeError(`invalid_checksum:${name}`);
    const kind = encoded.slice(0, separator);
    const expected = encoded.slice(separator + 1);
    let bytes: Uint8Array;
    try {
      const root = await realpath(config.localPath);
      const artifactPath = await realpath(resolve(root, name));
      const fromRoot = relative(root, artifactPath);
      if (
        fromRoot === ".." ||
        fromRoot.startsWith(`..${sep}`) ||
        isAbsolute(fromRoot)
      )
        throw new EmbeddingUnavailableError(
          `embedding_artifact_outside_model_path:${name}`,
        );
      bytes = await Bun.file(artifactPath).bytes();
    } catch (error) {
      if (
        error instanceof EmbeddingUnavailableError &&
        error.message.startsWith("embedding_artifact_outside_model_path:")
      )
        throw error;
      throw new EmbeddingUnavailableError(`embedding_artifact_missing:${name}`);
    }
    if (artifactDigest(kind, bytes) !== expected)
      throw new EmbeddingUnavailableError(`embedding_artifact_corrupt:${name}`);
  }
}

type Pipeline = (
  texts: string | readonly string[],
  options: { normalize: boolean; pooling: "mean" | "cls" },
) => Promise<{ data: ArrayLike<number>; dims?: readonly number[] }>;

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly config: EmbeddingModelConfig;
  readonly runtime = "onnx-transformer" as const;
  private session: Promise<Pipeline> | null = null;

  constructor(
    config: Partial<EmbeddingModelConfig> = {},
    private readonly allowDownload = false,
    private readonly pipelineFactory?: (
      task: "feature-extraction",
      model: string,
      options: Record<string, unknown>,
    ) => Promise<Pipeline>,
  ) {
    this.config = EmbeddingModelConfigSchema.parse(config);
  }

  private load(): Promise<Pipeline> {
    if (!this.session) {
      this.session = (async () => {
        if (!this.config.localPath && !this.allowDownload)
          throw new EmbeddingUnavailableError();
        if (this.config.localPath) await verifyLocalModelArtifacts(this.config);
        const factory =
          this.pipelineFactory ??
          ((await import("@huggingface/transformers")).pipeline as unknown as (
            task: "feature-extraction",
            model: string,
            options: Record<string, unknown>,
          ) => Promise<Pipeline>);
        return factory(
          "feature-extraction",
          this.config.localPath ?? this.config.modelId,
          {
            device: this.config.device,
            dtype: this.config.dtype,
            revision: this.config.revision,
          },
        );
      })();
    }
    return this.session;
  }

  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    if (texts.length === 0) return [];
    const session = await this.load();
    const output = await session(texts, {
      normalize: true,
      pooling: this.config.pooling,
    });
    const dimensions = this.config.dimensions;
    const flat = Array.from(output.data, Number);
    if (flat.length !== texts.length * dimensions)
      throw new TypeError(
        `embedding_batch_dimension_mismatch:${flat.length}:${texts.length * dimensions}`,
      );
    return texts.map((_, index) =>
      normalizeEmbedding(
        flat.slice(index * dimensions, (index + 1) * dimensions),
        dimensions,
      ),
    );
  }

  async close(): Promise<void> {
    this.session = null;
  }
}

interface StaticTokenizerOutput {
  attention_mask?: { data: ArrayLike<bigint | number> };
  input_ids: {
    data: ArrayLike<bigint | number>;
    dims: readonly number[];
  };
}

type StaticTokenizer = (
  texts: readonly string[],
  options: {
    padding: boolean;
    truncation: boolean;
  },
) => Promise<StaticTokenizerOutput> | StaticTokenizerOutput;

export interface PotionStaticSession {
  close?(): Promise<void>;
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}

export interface PotionStaticLoaderOptions {
  readModel?: (path: string) => Promise<Uint8Array>;
  tokenizerFactory?: (
    modelPath: string,
    options: { local_files_only: boolean; revision: string },
  ) => Promise<StaticTokenizer>;
  verifyArtifacts?: (config: EmbeddingModelConfig) => Promise<void>;
}

export type PotionStaticFactory = (
  config: EmbeddingModelConfig,
) => Promise<PotionStaticSession>;

export async function createPotionStaticSession(
  config: EmbeddingModelConfig,
  options: PotionStaticLoaderOptions = {},
): Promise<PotionStaticSession> {
  if (!config.localPath) throw new EmbeddingUnavailableError();
  await (options.verifyArtifacts ?? verifyLocalModelArtifacts)(config);
  const tokenizerFactory =
    options.tokenizerFactory ??
    (async (modelPath, tokenizerOptions) => {
      const transformers = await import("@huggingface/transformers");
      return (await transformers.AutoTokenizer.from_pretrained(
        modelPath,
        tokenizerOptions,
      )) as unknown as StaticTokenizer;
    });
  const tokenizer = await tokenizerFactory(config.localPath, {
    local_files_only: true,
    revision: config.revision,
  });
  const bytes = Buffer.from(
    await (
      options.readModel ?? ((filePath: string) => Bun.file(filePath).bytes())
    )(resolve(config.localPath, "model.safetensors")),
  );
  if (bytes.byteLength < 9)
    throw new EmbeddingUnavailableError("potion_static_tensor_invalid");
  const headerLength = Number(bytes.readBigUInt64LE(0));
  if (
    !Number.isSafeInteger(headerLength) ||
    headerLength < 2 ||
    8 + headerLength > bytes.byteLength
  )
    throw new EmbeddingUnavailableError("potion_static_tensor_invalid");
  const header = JSON.parse(
    bytes.subarray(8, 8 + headerLength).toString("utf8"),
  ) as Record<
    string,
    {
      data_offsets?: readonly [number, number];
      dtype?: string;
      shape?: readonly number[];
    }
  >;
  let tensor:
    | {
        data_offsets: readonly [number, number];
        shape: readonly number[];
      }
    | undefined;
  for (const [name, candidate] of Object.entries(header)) {
    if (
      name !== "__metadata__" &&
      candidate.dtype === "F32" &&
      candidate.shape?.length === 2 &&
      candidate.shape[1] === config.dimensions &&
      candidate.data_offsets?.length === 2
    ) {
      tensor = {
        data_offsets: candidate.data_offsets,
        shape: candidate.shape,
      };
      break;
    }
  }
  if (!tensor)
    throw new EmbeddingUnavailableError("potion_static_tensor_missing");
  const [relativeStart, relativeEnd] = tensor.data_offsets;
  const dataStart = 8 + headerLength + relativeStart;
  const dataEnd = 8 + headerLength + relativeEnd;
  const vocabularySize = tensor.shape[0] ?? 0;
  if (
    vocabularySize < 1 ||
    dataStart < 8 + headerLength ||
    dataEnd > bytes.byteLength ||
    dataEnd - dataStart !== vocabularySize * config.dimensions * 4
  )
    throw new EmbeddingUnavailableError("potion_static_tensor_invalid");
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + dataStart,
    dataEnd - dataStart,
  );
  return {
    async embed(texts) {
      const encoded = await tokenizer(texts, {
        padding: true,
        truncation: true,
      });
      const width = encoded.input_ids.dims.at(-1) ?? 0;
      if (width < 1 || encoded.input_ids.data.length !== texts.length * width)
        throw new EmbeddingUnavailableError("potion_tokenizer_shape_invalid");
      const vectors: number[][] = [];
      for (let row = 0; row < texts.length; row += 1) {
        const vector = Array.from({ length: config.dimensions }, () => 0);
        let count = 0;
        for (let column = 0; column < width; column += 1) {
          const offset = row * width + column;
          if (
            encoded.attention_mask &&
            Number(encoded.attention_mask.data[offset]) === 0
          )
            continue;
          const tokenId = Number(encoded.input_ids.data[offset]);
          if (
            !Number.isSafeInteger(tokenId) ||
            tokenId < 0 ||
            tokenId >= vocabularySize
          )
            throw new EmbeddingUnavailableError("potion_token_id_invalid");
          const tensorOffset = tokenId * config.dimensions;
          for (let dimension = 0; dimension < config.dimensions; dimension += 1)
            vector[dimension] =
              (vector[dimension] ?? 0) +
              view.getFloat32((tensorOffset + dimension) * 4, true);
          count += 1;
        }
        if (count < 1)
          throw new EmbeddingUnavailableError("potion_tokenization_empty");
        vectors.push(vector.map((value) => value / count));
      }
      return vectors;
    },
  };
}

export class PotionStaticEmbeddingProvider implements EmbeddingProvider {
  readonly config: EmbeddingModelConfig;
  readonly runtime = "static-retrieval" as const;
  private session: Promise<PotionStaticSession> | null = null;

  constructor(
    config: Partial<EmbeddingModelConfig>,
    private readonly factory: PotionStaticFactory = createPotionStaticSession,
  ) {
    this.config = EmbeddingModelConfigSchema.parse(config);
    if (
      this.config.modelId !== POTION_CODE_BENCHMARK_MODEL.modelId ||
      this.config.revision !== POTION_CODE_BENCHMARK_MODEL.revision ||
      this.config.dimensions !== POTION_CODE_BENCHMARK_MODEL.dimensions ||
      this.config.dtype !== POTION_CODE_BENCHMARK_MODEL.dtype ||
      this.config.pooling !== POTION_CODE_BENCHMARK_MODEL.pooling ||
      Object.keys(this.config.artifacts).length === 0 ||
      artifactManifestFingerprint(this.config) !==
        artifactManifestFingerprint({
          ...this.config,
          artifacts: POTION_CODE_BENCHMARK_MODEL.artifacts,
          dimensions: POTION_CODE_BENCHMARK_MODEL.dimensions,
          dtype: POTION_CODE_BENCHMARK_MODEL.dtype,
          modelId: POTION_CODE_BENCHMARK_MODEL.modelId,
          pooling: POTION_CODE_BENCHMARK_MODEL.pooling,
          revision: POTION_CODE_BENCHMARK_MODEL.revision,
        })
    )
      throw new TypeError("potion_static_model_required");
  }

  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    if (texts.length === 0) return [];
    this.session ??= this.factory(this.config);
    const session = await this.session;
    const vectors = await session.embed(texts);
    if (vectors.length !== texts.length)
      throw new TypeError("embedding_batch_count_mismatch");
    return vectors.map((vector) =>
      normalizeEmbedding(vector, this.config.dimensions),
    );
  }

  async close(): Promise<void> {
    if (this.session) await (await this.session).close?.();
    this.session = null;
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
        reject,
        resolve,
        retries: options.retries ?? 2,
        signal: options.signal,
        text,
      };
      this.queue.push(task);
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
            if (!task.signal?.aborted && task.attempts <= task.retries)
              this.queue.push(task);
            else
              task.reject(
                task.signal?.aborted ? new EmbeddingCancelledError() : error,
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

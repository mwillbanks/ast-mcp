import {
  artifactManifestFingerprint,
  type EmbeddingProvider,
  normalizeEmbedding,
  verifyLocalModelArtifacts,
} from "./embedding.ts";
import {
  DEFAULT_EMBEDDING_MODEL,
  type EmbeddingModelConfig,
  EmbeddingModelConfigSchema,
  POTION_CODE_BENCHMARK_MODEL,
} from "./types.ts";

export type BenchmarkRuntime = "onnx-transformer" | "static-retrieval";

export interface OfflineBenchmarkDocument {
  id: string;
  text: string;
}

export interface OfflineBenchmarkCase {
  documents: readonly OfflineBenchmarkDocument[];
  id: string;
  query: string;
  relevantDocumentIds: readonly string[];
}

export interface BenchmarkModelInput {
  config: EmbeddingModelConfig;
  provider: EmbeddingProvider;
  runtime: BenchmarkRuntime;
}

export interface OfflineEmbeddingBenchmarkInput {
  artifactVerifier?: (
    config: EmbeddingModelConfig,
  ) => Promise<Readonly<Record<string, string>>>;
  clock?: () => number;
  corpus: readonly OfflineBenchmarkCase[];
  granite: BenchmarkModelInput;
  potion: BenchmarkModelInput;
}

export interface BenchmarkModelResult {
  artifactChecksums: Readonly<Record<string, string>>;
  dimensions: number;
  elapsedMs: number;
  meanReciprocalRank: number;
  modelId: string;
  recallAtThree: number;
  revision: string;
  runtime: BenchmarkRuntime;
  vectorBytes: number;
  vectorCount: number;
}

export interface OfflineEmbeddingBenchmarkResult {
  corpusCaseCount: number;
  granite: BenchmarkModelResult;
  potion: BenchmarkModelResult;
}

interface PinnedBenchmarkProfile {
  artifacts: Readonly<Record<string, string>>;
  dimensions: number;
  dtype: EmbeddingModelConfig["dtype"];
  modelId: string;
  pooling: EmbeddingModelConfig["pooling"];
  revision: string;
  runtime: BenchmarkRuntime;
}

function validateCorpus(corpus: readonly OfflineBenchmarkCase[]): void {
  if (corpus.length === 0) throw new TypeError("benchmark_corpus_empty");
  const caseIds = new Set<string>();
  for (const item of corpus) {
    if (!item.id || !item.query || item.documents.length === 0)
      throw new TypeError("benchmark_case_invalid");
    if (caseIds.has(item.id)) throw new TypeError("benchmark_case_duplicate");
    caseIds.add(item.id);
    const documentIds = new Set<string>();
    for (const document of item.documents) {
      if (!document.id || !document.text || documentIds.has(document.id))
        throw new TypeError("benchmark_document_invalid");
      documentIds.add(document.id);
    }
    if (item.relevantDocumentIds.length === 0)
      throw new TypeError("benchmark_relevance_empty");
    for (const relevant of item.relevantDocumentIds)
      if (!documentIds.has(relevant))
        throw new TypeError("benchmark_relevance_unknown");
  }
}

function assertPinnedProfile(
  input: BenchmarkModelInput,
  expected: PinnedBenchmarkProfile,
): EmbeddingModelConfig {
  const config = EmbeddingModelConfigSchema.parse(input.config);
  if (
    input.runtime !== expected.runtime ||
    config.modelId !== expected.modelId ||
    config.revision !== expected.revision ||
    config.dimensions !== expected.dimensions ||
    config.dtype !== expected.dtype ||
    config.pooling !== expected.pooling
  )
    throw new TypeError(`benchmark_model_substitution:${expected.modelId}`);
  const actualNames = Object.keys(config.artifacts).sort();
  const expectedNames = Object.keys(expected.artifacts).sort();
  if (actualNames.length !== expectedNames.length)
    throw new TypeError(`benchmark_artifact_substitution:${expected.modelId}`);
  for (let index = 0; index < expectedNames.length; index += 1) {
    const name = expectedNames[index];
    if (
      !name ||
      actualNames[index] !== name ||
      config.artifacts[name] !== expected.artifacts[name]
    )
      throw new TypeError(
        `benchmark_artifact_substitution:${expected.modelId}`,
      );
  }
  if (!config.localPath)
    throw new TypeError(
      `benchmark_local_artifacts_required:${expected.modelId}`,
    );
  const provider = EmbeddingModelConfigSchema.parse(input.provider.config);
  if (input.provider.runtime !== expected.runtime)
    throw new TypeError(
      `benchmark_provider_runtime_substitution:${expected.modelId}`,
    );
  if (
    provider.modelId !== config.modelId ||
    provider.revision !== config.revision ||
    provider.dimensions !== config.dimensions ||
    provider.dtype !== config.dtype ||
    provider.pooling !== config.pooling ||
    provider.localPath !== config.localPath ||
    Object.keys(provider.artifacts).length === 0 ||
    artifactManifestFingerprint(provider) !==
      artifactManifestFingerprint(config)
  )
    throw new TypeError(`benchmark_provider_substitution:${expected.modelId}`);
  return config;
}

function insertRanking(
  ranking: Array<{ id: string; score: number }>,
  item: { id: string; score: number },
): void {
  let index = 0;
  while (
    index < ranking.length &&
    ((ranking[index]?.score ?? Number.NEGATIVE_INFINITY) > item.score ||
      (ranking[index]?.score === item.score &&
        (ranking[index]?.id ?? "").localeCompare(item.id) < 0))
  )
    index += 1;
  ranking.splice(index, 0, item);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1)
    score += (left[index] ?? 0) * (right[index] ?? 0);
  return score;
}

async function benchmarkModel(
  input: BenchmarkModelInput,
  config: EmbeddingModelConfig,
  corpus: readonly OfflineBenchmarkCase[],
  clock: () => number,
): Promise<BenchmarkModelResult> {
  const started = clock();
  let reciprocalRank = 0;
  let recallAtThree = 0;
  let vectorCount = 0;
  for (const item of corpus) {
    const texts = [item.query];
    for (const document of item.documents) texts.push(document.text);
    const vectors = await input.provider.embed(texts);
    if (vectors.length !== texts.length)
      throw new TypeError("benchmark_vector_count_mismatch");
    const query = normalizeEmbedding(vectors[0] ?? [], config.dimensions);
    vectorCount += 1;
    const ranking: Array<{ id: string; score: number }> = [];
    for (let index = 0; index < item.documents.length; index += 1) {
      const document = item.documents[index];
      if (!document) continue;
      const vector = normalizeEmbedding(
        vectors[index + 1] ?? [],
        config.dimensions,
      );
      vectorCount += 1;
      insertRanking(ranking, {
        id: document.id,
        score: cosine(query, vector),
      });
    }
    const relevant = new Set(item.relevantDocumentIds);
    let firstRelevantRank = 0;
    let recalled = 0;
    for (let rank = 0; rank < ranking.length; rank += 1) {
      const candidate = ranking[rank];
      if (!candidate || !relevant.has(candidate.id)) continue;
      if (firstRelevantRank === 0) firstRelevantRank = rank + 1;
      if (rank < 3) recalled += 1;
    }
    if (firstRelevantRank > 0) reciprocalRank += 1 / firstRelevantRank;
    recallAtThree += recalled / relevant.size;
  }
  return {
    artifactChecksums: Object.freeze({ ...config.artifacts }),
    dimensions: config.dimensions,
    elapsedMs: Math.max(0, clock() - started),
    meanReciprocalRank: reciprocalRank / corpus.length,
    modelId: config.modelId,
    recallAtThree: recallAtThree / corpus.length,
    revision: config.revision,
    runtime: input.runtime,
    vectorBytes:
      vectorCount * config.dimensions * Float32Array.BYTES_PER_ELEMENT,
    vectorCount,
  };
}

export async function runOfflineEmbeddingBenchmark(
  input: OfflineEmbeddingBenchmarkInput,
): Promise<OfflineEmbeddingBenchmarkResult> {
  validateCorpus(input.corpus);
  const granite = assertPinnedProfile(input.granite, {
    ...DEFAULT_EMBEDDING_MODEL,
    runtime: "onnx-transformer",
  });
  const potion = assertPinnedProfile(input.potion, POTION_CODE_BENCHMARK_MODEL);
  const verifier =
    input.artifactVerifier ??
    (async (config: EmbeddingModelConfig) => {
      await verifyLocalModelArtifacts(config);
      return config.artifacts;
    });
  for (const config of [granite, potion]) {
    const evidence = await verifier(config);
    for (const [name, checksum] of Object.entries(config.artifacts))
      if (evidence[name] !== checksum)
        throw new TypeError(`benchmark_artifact_unverified:${config.modelId}`);
  }
  const clock = input.clock ?? performance.now.bind(performance);
  return {
    corpusCaseCount: input.corpus.length,
    granite: await benchmarkModel(input.granite, granite, input.corpus, clock),
    potion: await benchmarkModel(input.potion, potion, input.corpus, clock),
  };
}

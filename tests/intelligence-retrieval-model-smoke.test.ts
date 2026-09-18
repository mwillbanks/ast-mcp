import { expect, test } from "bun:test";

import {
  DEFAULT_EMBEDDING_MODEL,
  EmbeddingModelConfigSchema,
  type OfflineBenchmarkCase,
  POTION_CODE_BENCHMARK_MODEL,
  PotionStaticEmbeddingProvider,
  runOfflineEmbeddingBenchmark,
  TransformersEmbeddingProvider,
} from "../src/intelligence/retrieval/index.ts";

const granitePath = process.env.AST_MCP_EMBEDDING_MODEL_PATH;
const potionPath = process.env.AST_MCP_POTION_MODEL_PATH;

if (granitePath && potionPath) {
  test("real pinned Granite and Potion benchmark smoke", async () => {
    const fixture = (await Bun.file(
      new URL(
        "./fixtures/intelligence/retrieval/model-profiles.json",
        import.meta.url,
      ),
    ).json()) as { offlineCorpus: { cases: OfflineBenchmarkCase[] } };
    const graniteConfig = EmbeddingModelConfigSchema.parse({
      ...DEFAULT_EMBEDDING_MODEL,
      localPath: granitePath,
    });
    const potionConfig = EmbeddingModelConfigSchema.parse({
      artifacts: { ...POTION_CODE_BENCHMARK_MODEL.artifacts },
      dimensions: POTION_CODE_BENCHMARK_MODEL.dimensions,
      dtype: POTION_CODE_BENCHMARK_MODEL.dtype,
      localPath: potionPath,
      modelId: POTION_CODE_BENCHMARK_MODEL.modelId,
      pooling: POTION_CODE_BENCHMARK_MODEL.pooling,
      revision: POTION_CODE_BENCHMARK_MODEL.revision,
    });
    const granite = new TransformersEmbeddingProvider(graniteConfig);
    const potion = new PotionStaticEmbeddingProvider(potionConfig);
    try {
      const result = await runOfflineEmbeddingBenchmark({
        corpus: fixture.offlineCorpus.cases,
        granite: {
          config: graniteConfig,
          provider: granite,
          runtime: "onnx-transformer",
        },
        potion: {
          config: potionConfig,
          provider: potion,
          runtime: "static-retrieval",
        },
      });
      expect(result.granite.vectorCount).toBeGreaterThan(0);
      expect(result.potion.vectorCount).toBe(result.granite.vectorCount);
      expect(result.granite.meanReciprocalRank).toBeGreaterThanOrEqual(0);
      expect(result.potion.meanReciprocalRank).toBeGreaterThanOrEqual(0);
    } finally {
      await granite.close();
      await potion.close();
    }
  });
} else {
  test.skip("real benchmark requires AST_MCP_EMBEDDING_MODEL_PATH and AST_MCP_POTION_MODEL_PATH", () => {});
}

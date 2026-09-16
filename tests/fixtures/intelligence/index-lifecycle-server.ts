import type {
  EmbeddingModelConfig,
  EmbeddingProvider,
} from "../../../src/intelligence/retrieval/index.ts";
import { createServer } from "../../../src/server.ts";
import { BatchingStdioServerTransport } from "../../../src/stdio.ts";

class FixtureEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly config: EmbeddingModelConfig) {}

  async close(): Promise<void> {}

  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    if (process.env.AST_MCP_FAIL_EMBEDDINGS === "1")
      throw new Error("fixture_embedding_failure");
    return texts.map((text) => {
      const lower = text.toLowerCase();
      return lower.includes("historical")
        ? [1, 0, 0, 0]
        : lower.includes("working")
          ? [0, 1, 0, 0]
          : lower.includes("untracked")
            ? [0, 0, 1, 0]
            : [0, 0, 0, 1];
    });
  }
}

const server = createServer({
  allowEmbeddingDownload: false,
  embeddingProviderFactory: (config, context) => {
    if (
      config.modelId !== "fixture/embedding" ||
      config.revision !== "fixture-revision"
    )
      throw new Error("fixture_model_override_missing");
    if (!context.revisionId || context.selectorKind !== "commit")
      throw new Error("fixture_revision_context_missing");
    return new FixtureEmbeddingProvider(config);
  },
});
await server.connect(new BatchingStdioServerTransport());

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../src/intelligence/contracts/common.ts";
import {
  graphEdgeIdentity,
  graphEvidenceIdentity,
  graphNodeIdentity,
  graphOccurrenceIdentity,
  revisionMembershipIdentity,
} from "../src/intelligence/contracts/graph.ts";
import {
  createStorageDomainId,
  type StorageDomain,
} from "../src/intelligence/contracts/storage.ts";
import {
  createRepositoryId,
  createRevisionId,
  createWorkspaceId,
} from "../src/intelligence/contracts/workspace.ts";
import { GraphSnapshotSchema } from "../src/intelligence/graph/types.ts";
import {
  artifactManifestFingerprint,
  assembleContext,
  createPotionStaticSession,
  DEFAULT_EMBEDDING_MODEL,
  EmbeddingCancelledError,
  EmbeddingModelConfigSchema,
  type EmbeddingProvider,
  EmbeddingQueueFullError,
  EmbeddingUnavailableError,
  EmbeddingWorkerPool,
  modelSpaceId,
  normalizeEmbedding,
  type OfflineBenchmarkCase,
  type OfflineEmbeddingBenchmarkInput,
  POTION_CODE_BENCHMARK_MODEL,
  PotionStaticEmbeddingProvider,
  publishChunkEmbeddings,
  publishRetrievalChunks,
  type RetrievalChunk,
  type RetrievalScope,
  retrieve,
  runOfflineEmbeddingBenchmark,
  syntheticChunkArtifactId,
  TransformersEmbeddingProvider,
  verifyLocalModelArtifacts,
} from "../src/intelligence/retrieval/index.ts";
import {
  LanceIntelligenceStore,
  type PinnedGenerationReader,
} from "../src/intelligence/storage/store.ts";
import type { WorkspaceHandle } from "../src/intelligence/workspace/context.ts";

const HASH = "a".repeat(64);
const RANGE = {
  end: { column: 20, line: 0 },
  endByte: 20,
  start: { column: 0, line: 0 },
  startByte: 0,
};

async function harness(suffix = "main") {
  const storagePath = await mkdtemp(join(tmpdir(), "ast-mcp-retrieval-"));
  const domain: StorageDomain = {
    domainId: createStorageDomainId({
      engine: "lancedb",
      placement: { kind: "explicit", path: storagePath },
      pool: "shared",
      storagePath,
    }),
    engine: "lancedb",
    placement: { kind: "explicit", path: storagePath },
    pool: "shared",
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    storagePath,
  };
  const repositoryRoot = `/repos/${suffix}`;
  const repositoryId = createRepositoryId({
    canonicalGitCommonDirectory: `${repositoryRoot}/.git`,
  });
  const selectedRevision = {
    readOnly: false,
    resolvedCommitOid: null,
    revisionId: createRevisionId({
      repositoryId,
      resolvedCommitOid: null,
      selector: { kind: "working" },
    }),
    selector: { kind: "working" as const },
  };
  const workspaceId = createWorkspaceId({
    canonicalCheckoutRoot: repositoryRoot,
    configurationGeneration: 1,
    dirtyOverlayId: null,
    repositoryId,
    revisionId: selectedRevision.revisionId,
    storageDomainId: domain.domainId,
  });
  const workspace: WorkspaceHandle = {
    canonicalRootAnchor: repositoryRoot,
    checkoutRoot: repositoryRoot,
    configurationGeneration: 1,
    dirtyOverlayId: null,
    git: {
      branch: "feature",
      checkoutRoot: repositoryRoot,
      commonGitDirectory: `${repositoryRoot}/.git`,
      gitDirectory: `${repositoryRoot}/.git`,
      headOid: null,
      isGit: true,
      isLinkedWorktree: suffix !== "main",
      repositoryRoot,
    },
    openedAt: "2026-09-10T00:00:00.000Z",
    repositoryId,
    repositoryRoot,
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    selectedRevision,
    storageDomain: domain,
    workspaceId,
    writeEligibility: { eligible: true },
  };
  const scope: RetrievalScope = {
    generationId: createIdentity("generation", { suffix }),
    repositoryId,
    revisionId: selectedRevision.revisionId,
    workspaceId,
  };
  return {
    scope,
    store: await LanceIntelligenceStore.open(domain),
    workspace,
  };
}

function graphFor(scope: RetrievalScope, chunks: readonly RetrievalChunk[]) {
  const nodes = chunks.map((chunk, index) => {
    const symbolName = chunk.symbols[0] ?? chunk.path;
    const canonicalName = `${symbolName}:${chunk.path}`;
    return {
      canonicalName,
      contentFingerprint: HASH,
      kind: "function" as const,
      nodeId: graphNodeIdentity({ canonicalName, kind: "function" }),
      properties: [
        {
          key: "name",
          value: index === 1 ? [symbolName] : symbolName,
        },
      ],
    };
  });
  const occurrences = chunks.map((chunk, index) => {
    const node = nodes[index];
    if (!node) throw new Error("missing_test_node");
    return {
      nodeId: node.nodeId,
      occurrenceId: graphOccurrenceIdentity({
        nodeId: node.nodeId,
        path: chunk.path,
        range: chunk.range,
        role: "declaration",
        sourceArtifactId: chunk.sourceArtifactId,
      }),
      path: chunk.path,
      range: chunk.range,
      role: "declaration" as const,
      sourceArtifactId: chunk.sourceArtifactId,
    };
  });
  const sourceNode = nodes[0];
  const targetNode = nodes[1];
  const sourceOccurrence = occurrences[0];
  if (!sourceNode || !targetNode || !sourceOccurrence)
    throw new Error("missing_test_relationship");
  const edgeInput = {
    discriminator: "test-call",
    kind: "calls" as const,
    sourceNodeId: sourceNode.nodeId,
    targetNodeId: targetNode.nodeId,
  };
  const edge = {
    ...edgeInput,
    contentFingerprint: HASH,
    direction: "directed" as const,
    edgeId: graphEdgeIdentity(edgeInput),
    environmentFingerprint: null,
    properties: [],
    resolutionStatus: "resolved" as const,
  };
  const evidenceInput = {
    edgeId: edge.edgeId,
    extractionMethod: "ast" as const,
    extractionVersion: "test-v1",
    extractorFingerprint: HASH,
    occurrenceId: sourceOccurrence.occurrenceId,
    path: sourceOccurrence.path,
    range: sourceOccurrence.range,
    sourceArtifactId: sourceOccurrence.sourceArtifactId,
  };
  const evidence = {
    ...evidenceInput,
    confidence: 1,
    evidenceId: graphEvidenceIdentity(evidenceInput),
  };
  const entities = [
    ...nodes.map(({ nodeId: entityId }) => ({
      entityId,
      entityKind: "node" as const,
    })),
    ...occurrences.map(({ occurrenceId: entityId }) => ({
      entityId,
      entityKind: "occurrence" as const,
    })),
    { entityId: edge.edgeId, entityKind: "edge" as const },
    { entityId: evidence.evidenceId, entityKind: "evidence" as const },
  ];
  return GraphSnapshotSchema.parse({
    edges: [edge],
    evidence: [evidence],
    memberships: entities.map((item) => ({
      ...item,
      generationId: scope.generationId,
      membershipId: revisionMembershipIdentity({
        ...item,
        generationId: scope.generationId,
        revisionId: scope.revisionId,
      }),
      revisionId: scope.revisionId,
    })),
    nodes,
    occurrences,
    scope,
  });
}

function chunks(): RetrievalChunk[] {
  const sourceOne = createIdentity("source", { contentDigest: "one" });
  const sourceTwo = createIdentity("source", { contentDigest: "two" });
  const sourceThree = createIdentity("source", { contentDigest: "three" });
  return [
    {
      artifactId: syntheticChunkArtifactId({
        documentKind: "code",
        language: "typescript",
        path: "src/publish.ts",
        range: RANGE,
        sourceArtifactId: sourceOne,
        symbols: ["publishOrder"],
        text: "export function publishOrder() { return 'stable generation'; }",
      }),
      documentKind: "code",
      language: "typescript",
      path: "src/publish.ts",
      range: RANGE,
      sourceArtifactId: sourceOne,
      symbols: ["publishOrder"],
      text: "export function publishOrder() { return 'stable generation'; }",
    },
    {
      artifactId: syntheticChunkArtifactId({
        documentKind: "markdown",
        language: "markdown",
        path: "docs/search.md",
        range: RANGE,
        sourceArtifactId: sourceTwo,
        symbols: ["SearchGuide"],
        text: "Behavioral search uses semantic evidence and bounded context.",
      }),
      documentKind: "markdown",
      language: "markdown",
      path: "docs/search.md",
      range: RANGE,
      sourceArtifactId: sourceTwo,
      symbols: ["SearchGuide"],
      text: "Behavioral search uses semantic evidence and bounded context.",
    },
    {
      artifactId: syntheticChunkArtifactId({
        documentKind: "code",
        language: "typescript",
        path: "secret/token.ts",
        range: RANGE,
        sourceArtifactId: sourceThree,
        symbols: ["publishOrder"],
        text: "publishOrder secret token",
      }),
      documentKind: "code",
      language: "typescript",
      path: "secret/token.ts",
      range: RANGE,
      sourceArtifactId: sourceThree,
      symbols: ["publishOrder"],
      text: "publishOrder secret token",
    },
  ];
}

async function fakeReader(
  store: LanceIntelligenceStore,
  scope: RetrievalScope,
): Promise<PinnedGenerationReader> {
  const connection = await lancedb.connect(store.storagePath);
  const tableVersions = await Promise.all(
    ["chunks", "embeddings"].map(async (name) => {
      const table = await connection.openTable(name);
      const version = await table.version();
      table.close();
      return { table: name, version };
    }),
  );
  connection.close();
  return {
    pin: {
      createdAt: "2026-09-10T00:00:00.000Z",
      generationId: scope.generationId,
      revisionId: scope.revisionId,
      tableVersions,
      workspaceId: scope.workspaceId,
    },
    rows: (table: Parameters<LanceIntelligenceStore["rows"]>[0]) =>
      store.rows(table),
  } as unknown as PinnedGenerationReader;
}

class BenchmarkProvider implements EmbeddingProvider {
  constructor(
    readonly config: ReturnType<typeof EmbeddingModelConfigSchema.parse>,
    readonly runtime: "onnx-transformer" | "static-retrieval",
  ) {}

  async close() {}

  async embed(texts: readonly string[]) {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      const index =
        lower.includes("reserve") ||
        lower.includes("finalize") ||
        lower.includes("publish")
          ? 0
          : lower.includes("parse") || lower.includes("typescript")
            ? 1
            : 2;
      const vector = Array.from({ length: this.config.dimensions }, () => 0);
      vector[index] = 1;
      return vector;
    });
  }
}

class MockProvider implements EmbeddingProvider {
  calls = 0;
  closed = false;
  failOnce = false;

  constructor(
    readonly config: ReturnType<typeof EmbeddingModelConfigSchema.parse>,
  ) {}

  async close() {
    this.closed = true;
  }

  async embed(texts: readonly string[]) {
    this.calls += 1;
    if (this.failOnce && this.calls === 1) throw new Error("retry");
    return texts.map((text) =>
      normalizeEmbedding(
        Array.from(
          { length: this.config.dimensions },
          (_, index) => ((text.length + index) % 7) + 1,
        ),
      ),
    );
  }
}

describe("retrieval chunk identity", () => {
  test("covers every immutable storage coordinate", () => {
    const base = {
      documentKind: "code" as const,
      language: "typescript",
      path: "src/value.ts",
      range: RANGE,
      sourceArtifactId: createIdentity("source", { contentDigest: "base" }),
      symbols: ["value"],
      text: "export const value = 1;",
    };
    const identities = [
      syntheticChunkArtifactId(base),
      syntheticChunkArtifactId({ ...base, documentKind: "structured" }),
      syntheticChunkArtifactId({ ...base, language: "tsx" }),
      syntheticChunkArtifactId({ ...base, path: "src/other.ts" }),
      syntheticChunkArtifactId({
        ...base,
        range: { ...RANGE, endByte: RANGE.endByte + 1 },
      }),
      syntheticChunkArtifactId({
        ...base,
        sourceArtifactId: createIdentity("source", { contentDigest: "other" }),
      }),
      syntheticChunkArtifactId({ ...base, symbols: ["other"] }),
      syntheticChunkArtifactId({ ...base, text: "export const value = 2;" }),
    ];
    expect(new Set(identities)).toHaveLength(identities.length);
  });
});

describe("retrieval embedding provider", () => {
  test("pins model artifacts and isolates model spaces", () => {
    expect(DEFAULT_EMBEDDING_MODEL.dimensions).toBe(384);
    expect(DEFAULT_EMBEDDING_MODEL.revision).toHaveLength(40);
    expect(
      DEFAULT_EMBEDDING_MODEL.artifacts["onnx/model_quantized.onnx"],
    ).toStartWith("sha256:");
    expect(POTION_CODE_BENCHMARK_MODEL.runtime).toBe("static-retrieval");
    const first = EmbeddingModelConfigSchema.parse({ dimensions: 2 });
    const second = EmbeddingModelConfigSchema.parse({
      dimensions: 3,
      modelId: POTION_CODE_BENCHMARK_MODEL.modelId,
      revision: POTION_CODE_BENCHMARK_MODEL.revision,
    });
    expect(modelSpaceId(first)).not.toBe(modelSpaceId(second));
    const manifestA = EmbeddingModelConfigSchema.parse({
      ...first,
      artifacts: { "model.bin": "sha256:aaaa" },
    });
    const manifestB = EmbeddingModelConfigSchema.parse({
      ...first,
      artifacts: { "model.bin": "sha256:bbbb" },
    });
    expect(artifactManifestFingerprint(manifestA)).not.toBe(
      artifactManifestFingerprint(manifestB),
    );
    expect(modelSpaceId(manifestA)).not.toBe(modelSpaceId(manifestB));
    expect(normalizeEmbedding([3, 4])).toEqual([0.6, 0.8]);
    expect(() => normalizeEmbedding([0, 0])).toThrow("embedding_zero_norm");
    expect(() => normalizeEmbedding([1, Number.NaN])).toThrow(
      "embedding_non_finite",
    );
    expect(() => normalizeEmbedding([1], 2)).toThrow(
      "embedding_dimension_mismatch",
    );
  });

  test("requires explicit model setup and reuses one inference session", async () => {
    const offline = new TransformersEmbeddingProvider({ dimensions: 2 });
    await expect(offline.embed(["query"])).rejects.toBeInstanceOf(
      EmbeddingUnavailableError,
    );
    let loads = 0;
    let transformerFactoryOptions: Record<string, unknown> | undefined;
    let transformerInferenceOptions: Record<string, unknown> | undefined;
    const provider = new TransformersEmbeddingProvider(
      {
        artifacts: {},
        dimensions: 2,
        localPath: "/models/granite",
      },
      false,
      async (task, model, options) => {
        expect(task).toBe("feature-extraction");
        expect(model).toBe("/models/granite");
        transformerFactoryOptions = options;
        loads += 1;
        return async (texts, inferenceOptions) => {
          transformerInferenceOptions = inferenceOptions;
          const values = typeof texts === "string" ? [texts] : texts;
          return { data: values.flatMap(() => [3, 4]) };
        };
      },
    );
    const verified = new TransformersEmbeddingProvider(
      { artifacts: {}, dimensions: 2, localPath: "/models/granite" },
      false,
      async () => async () => ({ data: [3, 4] }),
    );
    expect(await provider.embed(["a", "b"])).toEqual([
      [0.6, 0.8],
      [0.6, 0.8],
    ]);
    expect(await provider.embed(["c"])).toEqual([[0.6, 0.8]]);
    expect(loads).toBe(1);
    expect(transformerFactoryOptions).toEqual({
      device: "cpu",
      dtype: "q8",
      revision: DEFAULT_EMBEDDING_MODEL.revision,
    });
    expect(transformerInferenceOptions).toEqual({
      normalize: true,
      pooling: "mean",
    });
    const pinnedPath = process.env.AST_MCP_GRANITE_MODEL_PATH;
    if (pinnedPath) {
      const pinned = new TransformersEmbeddingProvider({
        ...DEFAULT_EMBEDDING_MODEL,
        localPath: pinnedPath,
      });
      const [reference] = await pinned.embed([
        "export function reference() {}",
      ]);
      expect(reference).toHaveLength(DEFAULT_EMBEDDING_MODEL.dimensions);
      expect(
        reference?.reduce((sum, value) => sum + value * value, 0),
      ).toBeCloseTo(1);
      await expect(
        pinned.embed(["export function reference() {}"]),
      ).resolves.toEqual([reference]);
      await pinned.close();
    }
    await provider.close();
    await verified.close();
  });

  test("uses distinct pinned factory options and reference outputs", async () => {
    const potionConfig = EmbeddingModelConfigSchema.parse({
      artifacts: { ...POTION_CODE_BENCHMARK_MODEL.artifacts },
      dimensions: POTION_CODE_BENCHMARK_MODEL.dimensions,
      dtype: POTION_CODE_BENCHMARK_MODEL.dtype,
      localPath: "/models/potion",
      modelId: POTION_CODE_BENCHMARK_MODEL.modelId,
      pooling: POTION_CODE_BENCHMARK_MODEL.pooling,
      revision: POTION_CODE_BENCHMARK_MODEL.revision,
    });
    let staticLoads = 0;
    let receivedConfig: typeof potionConfig | undefined;
    const potion = new PotionStaticEmbeddingProvider(
      potionConfig,
      async (config) => {
        staticLoads += 1;
        receivedConfig = config;
        return {
          embed: async (texts) =>
            texts.map(() =>
              Array.from({ length: config.dimensions }, (_, index) =>
                index === 0 ? 3 : index === 1 ? 4 : 0,
              ),
            ),
        };
      },
    );
    const expected = Array.from(
      { length: potionConfig.dimensions },
      (_, index) => (index === 0 ? 0.6 : index === 1 ? 0.8 : 0),
    );
    expect(await potion.embed(["reference"])).toEqual([expected]);
    expect(await potion.embed(["second"])).toEqual([expected]);
    expect(staticLoads).toBe(1);
    expect(receivedConfig).toEqual(potionConfig);
    expect(potion.runtime).toBe("static-retrieval");
    for (const incompatible of [
      { ...potionConfig, modelId: "substituted/model" },
      { ...potionConfig, revision: "substituted-revision" },
      { ...potionConfig, dimensions: potionConfig.dimensions + 1 },
      { ...potionConfig, dtype: "q8" as const },
      { ...potionConfig, pooling: "cls" as const },
      { ...potionConfig, artifacts: {} },
      {
        ...potionConfig,
        artifacts: {
          ...potionConfig.artifacts,
          "model.safetensors": `sha256:${"f".repeat(64)}`,
        },
      },
    ])
      expect(() => new PotionStaticEmbeddingProvider(incompatible)).toThrow(
        "potion_static_model_required",
      );
    await potion.close();
  });

  test("loads Potion static tensors with pinned tokenizer options", async () => {
    const config = EmbeddingModelConfigSchema.parse({
      artifacts: { ...POTION_CODE_BENCHMARK_MODEL.artifacts },
      dimensions: POTION_CODE_BENCHMARK_MODEL.dimensions,
      dtype: POTION_CODE_BENCHMARK_MODEL.dtype,
      localPath: "/models/potion",
      modelId: POTION_CODE_BENCHMARK_MODEL.modelId,
      pooling: POTION_CODE_BENCHMARK_MODEL.pooling,
      revision: POTION_CODE_BENCHMARK_MODEL.revision,
    });
    const tensorBytes = 2 * config.dimensions * Float32Array.BYTES_PER_ELEMENT;
    const header = Buffer.from(
      JSON.stringify({
        embeddings: {
          data_offsets: [0, tensorBytes],
          dtype: "F32",
          shape: [2, config.dimensions],
        },
      }),
    );
    const model = Buffer.alloc(8 + header.length + tensorBytes);
    model.writeBigUInt64LE(BigInt(header.length), 0);
    header.copy(model, 8);
    const view = new DataView(
      model.buffer,
      model.byteOffset + 8 + header.length,
      tensorBytes,
    );
    view.setFloat32(0, 3, true);
    view.setFloat32((config.dimensions + 1) * 4, 4, true);
    let tokenizerOptions: unknown;
    const provider = new PotionStaticEmbeddingProvider(config, (input) =>
      createPotionStaticSession(input, {
        readModel: async (path) => {
          expect(path).toBe("/models/potion/model.safetensors");
          return model;
        },
        tokenizerFactory: async (modelPath, options) => {
          expect(modelPath).toBe("/models/potion");
          tokenizerOptions = options;
          return async () => ({
            attention_mask: { data: [1, 1] },
            input_ids: { data: [0, 1], dims: [1, 2] },
          });
        },
        verifyArtifacts: async (verified) => {
          expect(verified).toEqual(config);
        },
      }),
    );
    const expected = Array.from({ length: config.dimensions }, (_, index) =>
      index === 0 ? 0.6 : index === 1 ? 0.8 : 0,
    );
    expect(await provider.embed(["reference"])).toEqual([expected]);
    expect(tokenizerOptions).toEqual({
      local_files_only: true,
      revision: POTION_CODE_BENCHMARK_MODEL.revision,
    });
    await provider.close();
  });

  test("verifies local checksums and confines model artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "ast-mcp-model-"));
    await mkdir(join(root, "onnx"));
    await writeFile(join(root, "config.json"), "{}");
    const sha = new Bun.CryptoHasher("sha256").update("{}").digest("hex");
    const config = EmbeddingModelConfigSchema.parse({
      artifacts: { "config.json": `sha256:${sha}` },
      dimensions: 2,
      localPath: root,
    });
    await expect(verifyLocalModelArtifacts(config)).resolves.toBeUndefined();
    await expect(
      verifyLocalModelArtifacts({
        ...config,
        artifacts: { "/absolute": `sha256:${sha}` },
      }),
    ).rejects.toThrow("invalid_artifact_name");
    await expect(
      verifyLocalModelArtifacts({
        ...config,
        artifacts: { "../traversal": `sha256:${sha}` },
      }),
    ).rejects.toThrow("invalid_artifact_name");
    await expect(
      verifyLocalModelArtifacts({
        ...config,
        artifacts: { "onnx//model.onnx": `sha256:${sha}` },
      }),
    ).rejects.toThrow("invalid_artifact_name");

    const outsideRoot = await mkdtemp(join(tmpdir(), "ast-mcp-model-outside-"));
    const outsideArtifact = join(outsideRoot, "outside.json");
    await writeFile(outsideArtifact, "{}");
    await symlink(outsideArtifact, join(root, "link.json"));
    await expect(
      verifyLocalModelArtifacts({
        ...config,
        artifacts: { "link.json": `sha256:${sha}` },
      }),
    ).rejects.toThrow("embedding_artifact_outside_model_path");

    await writeFile(join(root, "config.json"), "bad");
    await expect(verifyLocalModelArtifacts(config)).rejects.toThrow(
      "embedding_artifact_corrupt",
    );
    await expect(
      verifyLocalModelArtifacts({ ...config, artifacts: { gone: "sha256:a" } }),
    ).rejects.toThrow("embedding_artifact_missing");
  });

  test("bounds, retries, cancels, and closes worker pools", async () => {
    const config = EmbeddingModelConfigSchema.parse({
      artifacts: {},
      batchSize: 2,
      dimensions: 2,
      maxQueue: 1,
      workers: 1,
    });
    const retrying = new MockProvider(config);
    retrying.failOnce = true;
    const pool = new EmbeddingWorkerPool(config, () => retrying);
    expect(await pool.embed("retry")).toHaveLength(2);
    expect(retrying.calls).toBe(2);

    let release!: () => void;
    const blockedGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blockedCalls = 0;
    let blockedClosed = false;
    const blocked: EmbeddingProvider = {
      close: async () => {
        blockedClosed = true;
      },
      config,
      embed: async (texts) => {
        blockedCalls += 1;
        if (blockedCalls === 1) await blockedGate;
        return texts.map(() => [1, 0]);
      },
    };
    const bounded = new EmbeddingWorkerPool(config, () => blocked);
    const first = bounded.embed("first");
    await Bun.sleep(5);
    const second = bounded.embed("second");
    let queuedCancellation: unknown;
    const secondSettled = second.catch((error: unknown) => {
      queuedCancellation = error;
    });
    await expect(bounded.embed("third")).rejects.toBeInstanceOf(
      EmbeddingQueueFullError,
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      bounded.embed("cancel", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(EmbeddingCancelledError);
    const closing = bounded.close();
    await Bun.sleep(5);
    expect(blockedClosed).toBeFalse();
    release();
    await expect(first).resolves.toEqual([1, 0]);
    await secondSettled;
    expect(queuedCancellation).toBeInstanceOf(EmbeddingCancelledError);
    await closing;
    expect(blockedClosed).toBeTrue();
    await bounded.close();
    await bounded.close();
    await expect(bounded.embed("closed")).rejects.toBeInstanceOf(
      EmbeddingUnavailableError,
    );
    await pool.close();
    expect(retrying.closed).toBeTrue();

    let providerCreations = 0;
    const sharedConfig = EmbeddingModelConfigSchema.parse({
      artifacts: {},
      dimensions: 2,
      workers: 2,
    });
    const sharedPool = new EmbeddingWorkerPool(sharedConfig, () => {
      providerCreations += 1;
      return new MockProvider(sharedConfig);
    });
    expect(providerCreations).toBe(1);
    await expect(sharedPool.embed("shared session")).resolves.toHaveLength(2);
    await sharedPool.close();
  });
});

describe("LanceDB hybrid retrieval", () => {
  test("publishes FTS and filters paths, languages, revisions, and worktrees", async () => {
    const { scope, store, workspace } = await harness();
    const corpus = chunks();
    await publishRetrievalChunks(store, scope, corpus, workspace);
    await publishRetrievalChunks(store, scope, corpus, workspace);
    expect(await store.rows("chunks")).toHaveLength(3);
    const reader = await fakeReader(store, scope);
    const response = await retrieve(
      store,
      reader,
      {
        budget: {
          maxBytes: 10_000,
          maxCandidates: 20,
          maxDepth: 1,
          maxItems: 10,
          maxNodes: 20,
          maxVectorCandidates: 20,
          timeoutMs: 5_000,
        },
        deniedPaths: ["secret"],
        exactSymbols: ["publishOrder"],
        includedPaths: [],
        intent: "implementation",
        languages: ["typescript"],
        query: "stable generation publishOrder",
        scope,
        semantic: false,
      },
      { graph: graphFor(scope, corpus), workspace },
    );
    expect(response.results.map(({ path }) => path)).toEqual([
      "src/publish.ts",
    ]);
    expect(response.results[0]?.reasons.map(({ signal }) => signal)).toContain(
      "exact-symbol",
    );
    expect(response.results[0]?.reasons.map(({ signal }) => signal)).toContain(
      "lexical",
    );
    expect(response.coverage.totalChunks).toBe(3);
    expect(response.coverage.eligibleChunks).toBe(1);
    expect(response.coverage.graphNodesVisited).toBe(2);
    expect(response.results[0]?.reasons.map(({ signal }) => signal)).toContain(
      "graph-proximity",
    );
    expect(response.freshness.stale).toBeFalse();
    expect(response.freshness.indexedAt).toBe("2026-09-10T00:00:00.000Z");

    const other = await harness("linked");
    await expect(
      retrieve(
        store,
        reader,
        {
          deniedPaths: [],
          exactSymbols: [],
          includedPaths: [],
          query: "publish",
          scope,
        },
        { graph: graphFor(scope, corpus), workspace: other.workspace },
      ),
    ).rejects.toThrow("retrieval_scope_unauthorized");
    await other.store.shutdownCoordinator();
    await store.shutdownCoordinator();
  });

  test("prioritizes exact eligible chunks and associates only overlapping occurrences", async () => {
    const { scope, store, workspace } = await harness("candidate-priority");
    const range = (startByte: number, endByte: number) => ({
      end: { column: endByte, line: 0 },
      endByte,
      start: { column: startByte, line: 0 },
      startByte,
    });
    const createChunk = (
      input: Omit<RetrievalChunk, "artifactId">,
    ): RetrievalChunk => ({
      ...input,
      artifactId: syntheticChunkArtifactId(input),
    });
    const sharedSource = createIdentity("source", { shared: true });
    const unrelated = createChunk({
      documentKind: "code",
      language: "typescript",
      path: "src/shared.ts",
      range: range(0, 10),
      sourceArtifactId: sharedSource,
      symbols: ["UnrelatedSymbol"],
      text: "export const unrelated = true;",
    });
    const target = createChunk({
      documentKind: "code",
      language: "typescript",
      path: "src/shared.ts",
      range: range(20, 30),
      sourceArtifactId: sharedSource,
      symbols: ["TargetSymbol"],
      text: "export const TargetSymbol = true;",
    });
    let denied: RetrievalChunk | undefined;
    for (let index = 0; index < 256; index += 1) {
      const candidate = createChunk({
        documentKind: "code",
        language: "typescript",
        path: `secret/${index}.ts`,
        range: range(40, 50),
        sourceArtifactId: createIdentity("source", { denied: index }),
        symbols: ["TargetSymbol"],
        text: "export const TargetSymbol = false;",
      });
      if (candidate.artifactId.localeCompare(target.artifactId) < 0) {
        denied = candidate;
        break;
      }
    }
    if (!denied) throw new Error("missing_lower_priority_fixture");
    const corpus = [unrelated, target, denied];
    await publishRetrievalChunks(store, scope, corpus, workspace);
    const graph = graphFor(scope, corpus);
    const targetNode = graph.nodes[1];
    if (!targetNode) throw new Error("missing_target_node");
    const response = await retrieve(
      store,
      await fakeReader(store, scope),
      {
        budget: {
          maxBytes: 1_000,
          maxCandidates: 1,
          maxDepth: 1,
          maxItems: 1,
          maxNodes: 10,
          maxVectorCandidates: 1,
          timeoutMs: 5_000,
        },
        deniedPaths: ["secret"],
        exactSymbols: ["TargetSymbol"],
        includedPaths: ["src"],
        languages: ["typescript"],
        query: "TargetSymbol",
        scope,
        semantic: false,
      },
      { graph, textSearch: "local", workspace },
    );
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      entityId: targetNode.nodeId,
      path: "src/shared.ts",
      range: range(20, 30),
    });
    expect(response.results[0]?.reasons.map(({ signal }) => signal)).toContain(
      "exact-symbol",
    );
    await store.shutdownCoordinator();
  });

  test("survives restart and falls back to local BM25 without an FTS index", async () => {
    const {
      scope,
      store: initialStore,
      workspace,
    } = await harness("bm25-fallback");
    const corpus = chunks().slice(0, 2);
    await publishRetrievalChunks(initialStore, scope, corpus, workspace);
    await initialStore.shutdownCoordinator();
    const store = await LanceIntelligenceStore.open(workspace.storageDomain);
    const connection = await lancedb.connect(store.storagePath);
    const table = await connection.openTable("chunks");
    for (const index of await table.listIndices())
      await table.dropIndex(index.name);
    table.close();
    connection.close();

    const response = await retrieve(
      store,
      await fakeReader(store, scope),
      {
        deniedPaths: [],
        exactSymbols: [],
        includedPaths: ["src"],
        query: "stable generation",
        scope,
      },
      { graph: graphFor(scope, corpus), workspace },
    );
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.reasons.map(({ signal }) => signal)).toContain(
      "lexical",
    );
    await store.shutdownCoordinator();
  });

  test("publishes chunks and vectors through one reserved generation", async () => {
    const { scope, store, workspace } = await harness("reserved");
    const reservation = await store.reservePublication({
      manifestArtifactId: createIdentity("revision-manifest", {
        test: "retrieval",
      }),
      requiredTables: ["chunks", "embeddings"],
      reservationKey: "retrieval-test",
      revisionId: scope.revisionId,
      workspaceId: scope.workspaceId,
    });
    const reservedScope = {
      ...scope,
      generationId: reservation.generationId,
    };
    const corpus = chunks().slice(0, 1);
    await expect(
      publishRetrievalChunks(store, scope, corpus, workspace, reservation),
    ).rejects.toThrow("retrieval_reservation_scope_mismatch");
    await publishRetrievalChunks(
      store,
      reservedScope,
      corpus,
      workspace,
      reservation,
    );

    const config = EmbeddingModelConfigSchema.parse({
      artifacts: {},
      dimensions: 2,
      modelId: "test/reserved",
      revision: "reserved-revision",
    });
    const pool = new EmbeddingWorkerPool(
      config,
      () => new MockProvider(config),
    );
    await publishChunkEmbeddings(store, reservedScope, corpus, config, pool, {
      reservation,
      workspace,
    });
    const generation = await store.finalizePublication(reservation);
    expect(generation.publicationProtocol).toBe("reservation-v2");
    expect(generation.generationId).toBe(reservation.generationId);
    expect(generation.requiredTables).toEqual(["chunks", "embeddings"]);
    const finalizedTables = generation.tableVersions.map(({ table }) => table);
    expect(finalizedTables).toContain("chunks");
    expect(finalizedTables).toContain("embeddings");
    expect(
      (await store.rows("chunks"))[0]?.publication_generation_id,
    ).toBeNull();
    expect(
      (await store.rows("embeddings"))[0]?.publication_generation_id,
    ).toBeNull();
    const generationLinks = await store.rows("generation_artifacts");
    expect(
      generationLinks.some(
        (row) =>
          row.generation_id === reservation.generationId &&
          row.table_name === "chunks",
      ),
    ).toBe(true);
    expect(
      generationLinks.some(
        (row) =>
          row.generation_id === reservation.generationId &&
          row.table_name === "embeddings",
      ),
    ).toBe(true);
    await expect(
      publishChunkEmbeddings(store, reservedScope, corpus, config, pool, {
        reservation,
        workspace,
      }),
    ).rejects.toMatchObject({ code: "publication_finalized" });

    const incomplete = await store.reservePublication({
      manifestArtifactId: createIdentity("revision-manifest", {
        test: "retrieval-incomplete",
      }),
      requiredTables: ["chunks"],
      reservationKey: "retrieval-incomplete-test",
      revisionId: scope.revisionId,
      workspaceId: scope.workspaceId,
    });
    await expect(
      publishRetrievalChunks(
        store,
        { ...scope, generationId: incomplete.generationId },
        corpus,
        workspace,
        incomplete,
      ),
    ).rejects.toThrow("retrieval_reservation_tables_mismatch");
    await store.abandonPublication(incomplete, "expected_test_rejection");
    await pool.close();
    await store.shutdownCoordinator();
  });

  test("publishes normalized vectors and fuses exact eligible fallback", async () => {
    const { scope, store, workspace } = await harness("vectors");
    const corpus = chunks().slice(0, 2);
    await publishRetrievalChunks(store, scope, corpus, workspace);
    const config = EmbeddingModelConfigSchema.parse({
      artifacts: {},
      batchSize: 2,
      dimensions: 2,
      modelId: "test/model",
      revision: "test-revision",
      workers: 1,
    });
    const provider = new MockProvider(config);
    const pool = new EmbeddingWorkerPool(config, () => provider);
    const publication = await publishChunkEmbeddings(
      store,
      scope,
      corpus,
      config,
      pool,
      {
        workspace,
      },
    );
    expect(publication).toMatchObject({ failed: 0, published: 2 });
    const rows = await store.rows("embeddings");
    expect(rows).toHaveLength(2);
    expect(
      Array.from(rows[0]?.vector as Iterable<number>).reduce(
        (sum, value) => sum + value * value,
        0,
      ),
    ).toBeCloseTo(1);

    expect(rows.every(({ dtype }) => dtype === "int8")).toBeTrue();
    expect(
      rows.every(
        (row) => JSON.parse(String(row.payload_json)).inferenceDtype === "q8",
      ),
    ).toBeTrue();

    const fp32Config = EmbeddingModelConfigSchema.parse({
      ...config,
      dtype: "fp32",
    });
    const fp32Pool = new EmbeddingWorkerPool(
      fp32Config,
      () => new MockProvider(fp32Config),
    );
    const fp32Publication = await publishChunkEmbeddings(
      store,
      scope,
      corpus,
      fp32Config,
      fp32Pool,
      {
        workspace,
      },
    );
    const allRows = await store.rows("embeddings");
    expect(allRows).toHaveLength(4);
    expect(new Set(allRows.map(({ dtype }) => dtype))).toEqual(
      new Set(["float32", "int8"]),
    );
    expect(
      new Set(
        allRows.map(
          (row) => JSON.parse(String(row.payload_json)).modelSpaceId as string,
        ),
      ).size,
    ).toBe(2);
    expect(
      fp32Publication.artifactIds.some((id) =>
        publication.artifactIds.includes(id),
      ),
    ).toBeFalse();
    const jobs = await store.rows("jobs");
    expect(jobs.every(({ state }) => state === "succeeded")).toBeTrue();

    const staleGeneration = createIdentity("generation", { stale: true });
    const storedChunks = await store.rows("chunks");
    await store.putRows("chunks", [
      {
        ...storedChunks[0],
        artifact_id: createIdentity("chunks", { stale: true }),
        payload_json: "{",
        publication_generation_id: staleGeneration,
        text: "behavioral semantic context repeated repeated repeated",
      },
    ]);
    await store.putRows("chunks", [
      {
        ...storedChunks[0],
        artifact_id: createIdentity("chunks", { corrupt: true }),
        payload_json: "{",
        publication_generation_id: scope.generationId,
      },
    ]);
    const eligibleEmbedding = allRows.find(
      ({ chunk_artifact_id }) => chunk_artifact_id === corpus[1]?.artifactId,
    );
    if (!eligibleEmbedding) throw new Error("missing_eligible_embedding");
    await store.putRows("embeddings", [
      {
        ...allRows[0],
        artifact_id: createIdentity("embedding", { stale: true }),
        payload_json: "{",
        publication_generation_id: staleGeneration,
        vector: Array.from(allRows[0]?.vector as Iterable<number>),
      },
      {
        ...eligibleEmbedding,
        artifact_id: createIdentity("embedding", { corrupt: true }),
        payload_json: "{",
        publication_generation_id: scope.generationId,
        vector: Array.from(allRows[0]?.vector as Iterable<number>),
      },
    ]);

    const reader = await fakeReader(store, scope);
    const response = await retrieve(
      store,
      reader,
      {
        deniedPaths: [],
        exactSymbols: [],
        includedPaths: ["docs"],
        intent: "documentation",
        languages: [],
        query: "behavioral semantic context",
        scope,
        semantic: true,
      },
      {
        graph: graphFor(scope, corpus),
        model: config,
        queryVector: [1, 1],
        workspace,
      },
    );
    expect(response.coverage.semanticState).toBe("ready");
    expect(response.coverage.totalChunks).toBe(3);
    expect(response.coverage.corruptChunks).toBe(1);
    expect(response.coverage.corruptEmbeddings).toBe(1);
    expect(response.coverage.degraded).toBeTrue();
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.path).toBe("docs/search.md");
    expect(
      response.results[0]?.reasons.some(({ explanation }) =>
        explanation.includes("vector"),
      ),
    ).toBeTrue();

    const boundedVector = await retrieve(
      store,
      reader,
      {
        budget: {
          maxBytes: 10_000,
          maxCandidates: 20,
          maxDepth: 1,
          maxItems: 10,
          maxNodes: 20,
          maxVectorCandidates: 1,
          maxVectorScan: 1,
          timeoutMs: 5_000,
        },
        deniedPaths: [],
        exactSymbols: [],
        includedPaths: [],
        query: "behavioral semantic context",
        scope,
        semantic: true,
      },
      {
        graph: graphFor(scope, corpus),
        model: config,
        queryVector: [1, 1],
        workspace,
      },
    );
    expect(boundedVector.truncated.vector).toBeTrue();
    expect(
      boundedVector.results.flatMap(({ reasons }) =>
        reasons.filter(({ signal }) => signal === "semantic"),
      ),
    ).toHaveLength(1);
    await fp32Pool.close();
    await pool.close();
    await store.shutdownCoordinator();
  });

  test("exact vector fallback scans its budget before selecting top-k", async () => {
    const { scope, store, workspace } = await harness("exact-vector");
    const corpus = chunks();
    await publishRetrievalChunks(store, scope, corpus, workspace);
    const config = EmbeddingModelConfigSchema.parse({
      artifacts: {},
      dimensions: 3,
      modelId: "test/exact-vector",
      revision: "exact-vector-revision",
    });
    const provider: EmbeddingProvider = {
      close: async () => {},
      config,
      embed: async (texts) =>
        texts.map((text) => {
          if (text.includes("secret token")) return [0, 0, 1];
          if (text.includes("Behavioral search")) return [0, 1, 0];
          return [1, 0, 0];
        }),
    };
    const pool = new EmbeddingWorkerPool(config, () => provider);
    await publishChunkEmbeddings(store, scope, corpus, config, pool, {
      workspace,
    });
    const stored = (await store.rows("embeddings")).filter(
      ({ model_id }) => model_id === config.modelId,
    );
    expect(stored).toHaveLength(3);
    const last = stored[2];
    const lastArtifactId = String(last?.chunk_artifact_id);
    const expected = corpus.find(
      ({ artifactId }) => artifactId === lastArtifactId,
    );
    if (!expected) throw new Error("missing_expected_vector_chunk");
    const queryVector = Array.from(last?.vector as Iterable<number>);
    const reader = await fakeReader(store, scope);
    const baseRequest = {
      budget: {
        maxBytes: 10_000,
        maxCandidates: 20,
        maxDepth: 1,
        maxItems: 10,
        maxNodes: 20,
        maxVectorCandidates: 1,
        maxVectorScan: 3,
        timeoutMs: 5_000,
      },
      deniedPaths: [],
      exactSymbols: [],
      includedPaths: [],
      query: "zzzzzz",
      scope,
      semantic: true,
    };
    const complete = await retrieve(store, reader, baseRequest, {
      graph: graphFor(scope, corpus),
      model: config,
      queryVector,
      vectorSearch: "exact",
      workspace,
    });
    expect(complete.results[0]?.artifactId).toBe(lastArtifactId);
    expect(complete.results[0]?.path).toBe(expected.path);
    expect(complete.truncated.vector).toBeFalse();
    expect(complete.results[0]?.reasons[0]?.explanation).toContain(
      "Exact eligible-vector",
    );

    const bounded = await retrieve(
      store,
      reader,
      {
        ...baseRequest,
        budget: { ...baseRequest.budget, maxVectorScan: 2 },
      },
      {
        graph: graphFor(scope, corpus),
        model: config,
        queryVector,
        vectorSearch: "exact",
        workspace,
      },
    );
    expect(bounded.truncated.vector).toBeTrue();
    expect(bounded.results[0]?.artifactId).not.toBe(lastArtifactId);
    await pool.close();
    await store.shutdownCoordinator();
  });

  test("keeps core retrieval available without vectors and reports truncation", async () => {
    const { scope, store, workspace } = await harness("offline");
    const corpus = chunks();
    await publishRetrievalChunks(store, scope, corpus, workspace);
    const reader = await fakeReader(store, scope);
    const response = await retrieve(
      store,
      reader,
      {
        budget: {
          maxBytes: 20,
          maxCandidates: 1,
          maxDepth: 0,
          maxItems: 1,
          maxNodes: 1,
          maxVectorCandidates: 1,
          timeoutMs: 5_000,
        },
        deniedPaths: [],
        exactSymbols: ["publishOrder"],
        includedPaths: [],
        query: "publishOrder",
        scope,
        semantic: true,
      },
      { graph: graphFor(scope, corpus), workspace },
    );
    expect(response.coverage.semanticState).toBe("unavailable");
    expect(
      response.truncated.bytes || response.truncated.candidates,
    ).toBeTrue();
    expect(response.coverage.evaluatedCandidates).toBeLessThanOrEqual(1);
    expect(response.coverage.graphNodesVisited).toBeLessThanOrEqual(1);
    expect(response.coverage.graphEdgesVisited).toBeLessThanOrEqual(1);
    await store.shutdownCoordinator();
  });

  test("reports deterministic truncation across retrieval phases", async () => {
    const { scope, store, workspace } = await harness("deadlines");
    const corpus = chunks();
    await publishRetrievalChunks(store, scope, corpus, workspace);
    const config = EmbeddingModelConfigSchema.parse({
      artifacts: {},
      dimensions: 2,
      modelId: "test/deadlines",
      revision: "deadline-revision",
    });
    const pool = new EmbeddingWorkerPool(
      config,
      () => new MockProvider(config),
    );
    await publishChunkEmbeddings(store, scope, corpus, config, pool, {
      workspace,
    });
    const reader = await fakeReader(store, scope);
    const cachedRows = {
      chunks: await reader.rows("chunks"),
      embeddings: await reader.rows("embeddings"),
    };
    const boundedReader = {
      ...reader,
      rows: async (table: "chunks" | "embeddings") => cachedRows[table],
    } as PinnedGenerationReader;
    const boundedStore = {
      rows: async () => [],
      storagePath: store.storagePath,
    } as unknown as LanceIntelligenceStore;
    const graph = graphFor(scope, corpus);
    const signatures = new Set<string>();
    const allowances = Array.from({ length: 600 }, (_, index) => index + 1);
    for (const timeoutMs of allowances) {
      let tick = 0;
      const response = await retrieve(
        boundedStore,
        boundedReader,
        {
          budget: {
            maxBytes: 10_000,
            maxCandidates: 20,
            maxDepth: 2,
            maxItems: 10,
            maxNodes: 20,
            maxVectorCandidates: 10,
            maxVectorScan: 20,
            timeoutMs,
          },
          deniedPaths: [],
          exactSymbols: ["publishOrder"],
          includedPaths: [],
          query: "publishOrder stable generation",
          scope,
          semantic: true,
        },
        {
          clock: () => tick++,
          graph,
          model: config,
          queryVector: [1, 1],
          textSearch: "local",
          vectorSearch: "exact",
          workspace,
        },
      );
      if (!response.truncated.time) continue;
      expect(response.truncated.reason).toBe("time-limit");
      expect(response.coverage.scannedChunkRows).toBeLessThanOrEqual(3);
      expect(response.coverage.scannedEmbeddingRows).toBeLessThanOrEqual(3);
      expect(response.coverage.scannedGraphMemberships).toBeLessThanOrEqual(
        graph.memberships.length,
      );
      expect(response.coverage.scannedGraphOccurrences).toBeLessThanOrEqual(3);
      signatures.add(
        [
          response.coverage.scannedChunkRows,
          response.coverage.scannedGraphMemberships,
          response.coverage.scannedGraphOccurrences,
          response.coverage.eligibleChunks,
          response.coverage.evaluatedCandidates,
          response.coverage.scannedEmbeddingRows,
          response.coverage.graphNodesVisited,
          response.coverage.scannedJobRows,
        ].join(":"),
      );
    }
    expect(signatures.size).toBeGreaterThanOrEqual(5);

    let tick = 0;
    const complete = await retrieve(
      boundedStore,
      boundedReader,
      {
        budget: {
          maxBytes: 10_000,
          maxCandidates: 20,
          maxDepth: 2,
          maxItems: 10,
          maxNodes: 20,
          maxVectorCandidates: 10,
          maxVectorScan: 20,
          timeoutMs: 2_000,
        },
        deniedPaths: [],
        exactSymbols: ["publishOrder"],
        includedPaths: [],
        query: "publishOrder stable generation",
        scope,
        semantic: true,
      },
      {
        clock: () => tick++,
        graph,
        model: config,
        queryVector: [1, 1],
        textSearch: "local",
        vectorSearch: "exact",
        workspace,
      },
    );
    expect(complete.truncated.time).toBeFalse();
    expect(complete.coverage.scannedChunkRows).toBe(3);
    expect(complete.coverage.scannedEmbeddingRows).toBe(3);
    expect(complete.coverage.scannedGraphOccurrences).toBe(3);
    await pool.close();
    await store.shutdownCoordinator();
  });

  test("isolates colliding model metadata by artifact manifest", async () => {
    const { scope, store, workspace } = await harness("manifest-collision");
    const corpus = chunks().slice(0, 2);
    await publishRetrievalChunks(store, scope, corpus, workspace);
    const base = {
      dimensions: 2,
      modelId: "test/collision",
      revision: "collision-revision",
      workers: 1,
    };
    const configA = EmbeddingModelConfigSchema.parse({
      ...base,
      artifacts: { "model.bin": `sha256:${"a".repeat(64)}` },
    });
    const configB = EmbeddingModelConfigSchema.parse({
      ...base,
      artifacts: { "model.bin": `sha256:${"b".repeat(64)}` },
    });
    const provider = (
      config: typeof configA,
      first: readonly number[],
      second: readonly number[],
    ): EmbeddingProvider => ({
      close: async () => {},
      config,
      embed: async (texts) =>
        texts.map((text) =>
          text.includes("publishOrder") ? [...first] : [...second],
        ),
    });
    const poolB = new EmbeddingWorkerPool(configB, () =>
      provider(configB, [0, 1], [1, 0]),
    );
    const poolA = new EmbeddingWorkerPool(configA, () =>
      provider(configA, [1, 0], [0, 1]),
    );
    const publicationB = await publishChunkEmbeddings(
      store,
      scope,
      corpus,
      configB,
      poolB,
      { workspace },
    );
    const publicationA = await publishChunkEmbeddings(
      store,
      scope,
      corpus,
      configA,
      poolA,
      { workspace },
    );
    expect(modelSpaceId(configA)).not.toBe(modelSpaceId(configB));
    expect(artifactManifestFingerprint(configA)).not.toBe(
      artifactManifestFingerprint(configB),
    );
    expect(
      publicationA.artifactIds.some((id) =>
        publicationB.artifactIds.includes(id),
      ),
    ).toBeFalse();

    const reader = await fakeReader(store, scope);
    const request = {
      budget: {
        maxBytes: 10_000,
        maxCandidates: 2,
        maxDepth: 1,
        maxGraphBytes: 10_000,
        maxItems: 1,
        maxNodes: 10,
        maxVectorCandidates: 1,
        maxVectorScan: 2,
        timeoutMs: 5_000,
      },
      deniedPaths: [],
      exactSymbols: [],
      includedPaths: [],
      query: "zzzzzz",
      scope,
      semantic: true,
    };
    const options = {
      graph: graphFor(scope, corpus),
      queryVector: [1, 0],
      textSearch: "local" as const,
      vectorSearch: "exact" as const,
      workspace,
    };
    const resultA = await retrieve(store, reader, request, {
      ...options,
      model: configA,
    });
    const resultB = await retrieve(store, reader, request, {
      ...options,
      model: configB,
    });
    expect(resultA.results).toHaveLength(1);
    expect(resultB.results).toHaveLength(1);
    expect(resultA.results[0]?.artifactId).toBe(corpus[0]?.artifactId);
    expect(resultB.results[0]?.artifactId).toBe(corpus[1]?.artifactId);
    expect(resultA.results[0]?.artifactId).not.toBe(
      resultB.results[0]?.artifactId,
    );
    expect(resultA.truncated.vector).toBeFalse();
    expect(resultB.truncated.vector).toBeFalse();
    await poolA.close();
    await poolB.close();
    await store.shutdownCoordinator();
  });

  test("reports loader timeouts before scanning any rows", async () => {
    const { scope, store, workspace } = await harness("loader-timeout");
    let chunkLoads = 0;
    let jobLoads = 0;
    const reader = {
      pin: {
        createdAt: "2026-09-10T00:00:00.000Z",
        generationId: scope.generationId,
        revisionId: scope.revisionId,
        tableVersions: [],
        workspaceId: scope.workspaceId,
      },
      rows: async () => {
        chunkLoads += 1;
        throw new Error("query timeout");
      },
    } as unknown as PinnedGenerationReader;
    const timedStore = {
      rows: async () => {
        jobLoads += 1;
        throw new Error("query timeout");
      },
      storagePath: store.storagePath,
    } as unknown as LanceIntelligenceStore;
    const response = await retrieve(
      timedStore,
      reader,
      {
        deniedPaths: [],
        exactSymbols: [],
        includedPaths: [],
        query: "anything",
        scope,
        semantic: false,
      },
      {
        graph: GraphSnapshotSchema.parse({
          edges: [],
          evidence: [],
          memberships: [],
          nodes: [],
          occurrences: [],
          scope,
        }),
        workspace,
      },
    );
    expect(chunkLoads).toBe(1);
    expect(jobLoads).toBe(1);
    expect(response.results).toEqual([]);
    expect(response.coverage.scannedChunkRows).toBe(0);
    expect(response.coverage.scannedEmbeddingRows).toBe(0);
    expect(response.coverage.scannedGraphMemberships).toBe(0);
    expect(response.coverage.scannedGraphOccurrences).toBe(0);
    expect(response.coverage.scannedJobRows).toBe(0);
    expect(response.truncated.time).toBeTrue();
    expect(response.truncated.reason).toBe("time-limit");
    await store.shutdownCoordinator();
  });

  test("enforces the graph byte budget", async () => {
    const { scope, store, workspace } = await harness("graph-bytes");
    const corpus = chunks();
    await publishRetrievalChunks(store, scope, corpus, workspace);
    const response = await retrieve(
      store,
      await fakeReader(store, scope),
      {
        budget: {
          maxBytes: 10_000,
          maxCandidates: 20,
          maxDepth: 2,
          maxGraphBytes: 1,
          maxItems: 10,
          maxNodes: 20,
          maxVectorCandidates: 10,
          maxVectorScan: 20,
          timeoutMs: 5_000,
        },
        deniedPaths: [],
        exactSymbols: ["publishOrder"],
        includedPaths: [],
        query: "publishOrder",
        scope,
        semantic: false,
      },
      { graph: graphFor(scope, corpus), workspace },
    );
    expect(response.truncated.graph).toBeTrue();
    expect(response.coverage.graphBytesVisited).toBeLessThanOrEqual(1);
    await store.shutdownCoordinator();
  });

  test("publishes every embedding beyond the worker queue capacity", async () => {
    const { scope, store, workspace } = await harness("bounded-publication");
    const config = EmbeddingModelConfigSchema.parse({
      artifacts: {},
      dimensions: 2,
      maxQueue: 1,
      modelId: "test/slow-model",
      revision: "test-revision",
      workers: 1,
    });
    const provider: EmbeddingProvider = {
      close: async () => {},
      config,
      async embed(texts) {
        await Bun.sleep(5);
        return texts.map(() => [1, 0]);
      },
    };
    const template = chunks()[0];
    if (!template) throw new Error("missing_test_chunk");
    const corpus = Array.from({ length: 8 }, (_, index) => ({
      ...template,
      artifactId: createIdentity("chunks", { index }),
      path: `bounded-${index}.ts`,
      text: `bounded publication ${index}`,
    }));
    const pool = new EmbeddingWorkerPool(config, () => provider);
    const result = await publishChunkEmbeddings(
      store,
      scope,
      corpus,
      config,
      pool,
      { workspace },
    );
    expect(result).toMatchObject({ failed: 0, published: corpus.length });
    expect(await store.rows("embeddings")).toHaveLength(corpus.length);
    expect(
      (await store.rows("jobs")).every(({ state }) => state === "succeeded"),
    ).toBeTrue();
    await pool.close();
    await store.shutdownCoordinator();
  });

  test("stops embedding publication at cancellation boundaries", async () => {
    const { scope, store, workspace } = await harness("cancel");
    const corpus = chunks().slice(0, 1);
    const config = EmbeddingModelConfigSchema.parse({
      artifacts: {},
      dimensions: 2,
      modelId: "test/model",
      revision: "test-revision",
    });
    let providerCalls = 0;
    const provider: EmbeddingProvider = {
      close: async () => {},
      config,
      async embed(texts) {
        providerCalls += 1;
        return texts.map(() => [1, 0]);
      },
    };
    const pool = new EmbeddingWorkerPool(config, () => provider);
    const controller = new AbortController();
    controller.abort();
    await expect(
      publishChunkEmbeddings(store, scope, corpus, config, pool, {
        signal: controller.signal,
        workspace,
      }),
    ).rejects.toThrow("embedding_cancelled");
    expect(providerCalls).toBe(0);
    expect(await store.rows("jobs")).toHaveLength(0);
    expect(await store.rows("embeddings")).toHaveLength(0);

    const failedConfig = EmbeddingModelConfigSchema.parse({
      ...config,
      modelId: "test/failing",
      revision: "failed-revision",
    });
    const failedProvider: EmbeddingProvider = {
      close: async () => {},
      config: failedConfig,
      embed: async () => {
        throw new Error("inference_failed");
      },
    };
    const failedPool = new EmbeddingWorkerPool(
      failedConfig,
      () => failedProvider,
    );
    const failed = await publishChunkEmbeddings(
      store,
      scope,
      corpus,
      failedConfig,
      failedPool,
      {
        workspace,
      },
    );
    expect(failed.failed).toBe(1);
    expect((await store.rows("jobs")).map(({ state }) => state).sort()).toEqual(
      ["failed"],
    );

    const template = corpus[0];
    if (!template) throw new Error("missing_test_chunk");
    const midCorpus = Array.from({ length: 4 }, (_, index) => ({
      ...template,
      artifactId: createIdentity("chunks", { cancellation: index }),
      text: `cancelled chunk ${index}`,
    }));
    const midConfig = EmbeddingModelConfigSchema.parse({
      ...config,
      maxQueue: 1,
      workers: 1,
    });
    const midAbort = new AbortController();
    let midProviderCalls = 0;
    const midPool = {
      async embed() {
        midProviderCalls += 1;
        midAbort.abort();
        return [1, 0];
      },
    } as unknown as EmbeddingWorkerPool;
    await expect(
      publishChunkEmbeddings(store, scope, midCorpus, midConfig, midPool, {
        signal: midAbort.signal,
        workspace,
      }),
    ).rejects.toThrow("embedding_cancelled");
    expect(midProviderCalls).toBe(1);
    expect(await store.rows("embeddings")).toHaveLength(0);
    expect(await store.rows("jobs")).toHaveLength(2);
    await failedPool.close();
    await pool.close();
    await store.shutdownCoordinator();
  });
});

describe("offline embedding benchmark", () => {
  async function fixture() {
    return (await Bun.file(
      new URL(
        "./fixtures/intelligence/retrieval/model-profiles.json",
        import.meta.url,
      ),
    ).json()) as {
      default: {
        artifactBytes: number;
        dimensions: number;
        model: string;
        residentVectorBytes: number;
        revision: string;
        runtime: string;
        source: string;
      };
      offlineCorpus: {
        cases: OfflineBenchmarkCase[];
        kind: string;
        metric: string;
        provenance: { granite: string; potion: string };
        version: number;
      };
      potionBenchmark: {
        artifactBytes: number;
        dimensions: number;
        model: string;
        residentVectorBytes: number;
        revision: string;
        runtime: string;
        runtimeEvidence: string;
        source: string;
      };
    };
  }

  function inputFor(
    corpus: readonly OfflineBenchmarkCase[],
  ): OfflineEmbeddingBenchmarkInput {
    const graniteConfig = EmbeddingModelConfigSchema.parse({
      ...DEFAULT_EMBEDDING_MODEL,
      localPath: "/models/granite",
    });
    const potionConfig = EmbeddingModelConfigSchema.parse({
      artifacts: { ...POTION_CODE_BENCHMARK_MODEL.artifacts },
      dimensions: POTION_CODE_BENCHMARK_MODEL.dimensions,
      dtype: POTION_CODE_BENCHMARK_MODEL.dtype,
      localPath: "/models/potion",
      modelId: POTION_CODE_BENCHMARK_MODEL.modelId,
      pooling: POTION_CODE_BENCHMARK_MODEL.pooling,
      revision: POTION_CODE_BENCHMARK_MODEL.revision,
    });
    let tick = 0;
    return {
      artifactVerifier: async (config) => config.artifacts,
      clock: () => tick++,
      corpus,
      granite: {
        config: graniteConfig,
        provider: new BenchmarkProvider(graniteConfig, "onnx-transformer"),
        runtime: "onnx-transformer",
      },
      potion: {
        config: potionConfig,
        provider: new BenchmarkProvider(potionConfig, "static-retrieval"),
        runtime: "static-retrieval",
      },
    };
  }

  test("executes pinned models over explicit corpus and relevance data", async () => {
    const profiles = await fixture();
    expect(profiles.offlineCorpus).toMatchObject({
      kind: "executable-embedding-corpus",
      metric: "MRR and Recall@3",
      version: 2,
    });
    expect(profiles.offlineCorpus.provenance).toEqual({
      granite: profiles.default.source,
      potion: profiles.potionBenchmark.source,
    });
    expect(profiles.default.model).toBe(DEFAULT_EMBEDDING_MODEL.modelId);
    expect(profiles.default.revision).toBe(DEFAULT_EMBEDDING_MODEL.revision);
    expect(profiles.default.runtime).toBe("onnx-transformer");
    expect(profiles.potionBenchmark.model).toBe(
      POTION_CODE_BENCHMARK_MODEL.modelId,
    );
    expect(profiles.potionBenchmark.revision).toBe(
      POTION_CODE_BENCHMARK_MODEL.revision,
    );
    expect(profiles.potionBenchmark.runtime).toBe("static-retrieval");
    expect(profiles.potionBenchmark.runtimeEvidence).toContain(
      "avoid transformer inference",
    );

    const result = await runOfflineEmbeddingBenchmark(
      inputFor(profiles.offlineCorpus.cases),
    );
    expect(result.corpusCaseCount).toBe(3);
    expect(result.granite).toMatchObject({
      dimensions: 384,
      elapsedMs: 1,
      meanReciprocalRank: 1,
      modelId: DEFAULT_EMBEDDING_MODEL.modelId,
      recallAtThree: 1,
      revision: DEFAULT_EMBEDDING_MODEL.revision,
      runtime: "onnx-transformer",
      vectorBytes: 18_432,
      vectorCount: 12,
    });
    expect(result.potion).toMatchObject({
      dimensions: 256,
      elapsedMs: 1,
      meanReciprocalRank: 1,
      modelId: POTION_CODE_BENCHMARK_MODEL.modelId,
      recallAtThree: 1,
      revision: POTION_CODE_BENCHMARK_MODEL.revision,
      runtime: "static-retrieval",
      vectorBytes: 12_288,
      vectorCount: 12,
    });
    expect(result.potion.vectorBytes).toBeLessThan(result.granite.vectorBytes);
    expect(result.granite.artifactChecksums).toEqual(
      DEFAULT_EMBEDDING_MODEL.artifacts,
    );
    expect(result.potion.artifactChecksums).toEqual(
      POTION_CODE_BENCHMARK_MODEL.artifacts,
    );
  });

  test("rejects invalid corpus, substitutions, and unverifiable artifacts", async () => {
    const profiles = await fixture();
    const corpus = profiles.offlineCorpus.cases;
    const firstCase = corpus[0];
    const firstDocument = firstCase?.documents[0];
    if (!firstCase || !firstDocument)
      throw new Error("benchmark_fixture_incomplete");
    const base = inputFor(corpus);
    await expect(
      runOfflineEmbeddingBenchmark({ ...base, corpus: [] }),
    ).rejects.toThrow("benchmark_corpus_empty");
    await expect(
      runOfflineEmbeddingBenchmark({
        ...base,
        corpus: [{ documents: [], id: "", query: "", relevantDocumentIds: [] }],
      }),
    ).rejects.toThrow("benchmark_case_invalid");
    await expect(
      runOfflineEmbeddingBenchmark({
        ...base,
        corpus: [firstCase, { ...firstCase }],
      }),
    ).rejects.toThrow("benchmark_case_duplicate");
    await expect(
      runOfflineEmbeddingBenchmark({
        ...base,
        corpus: [
          {
            ...firstCase,
            documents: [firstDocument, firstDocument],
          },
        ],
      }),
    ).rejects.toThrow("benchmark_document_invalid");
    await expect(
      runOfflineEmbeddingBenchmark({
        ...base,
        corpus: [{ ...firstCase, relevantDocumentIds: [] }],
      }),
    ).rejects.toThrow("benchmark_relevance_empty");
    await expect(
      runOfflineEmbeddingBenchmark({
        ...base,
        corpus: [{ ...firstCase, relevantDocumentIds: ["unknown"] }],
      }),
    ).rejects.toThrow("benchmark_relevance_unknown");

    const substitutedConfig = EmbeddingModelConfigSchema.parse({
      ...base.potion.config,
      modelId: "substituted/model",
    });
    await expect(
      runOfflineEmbeddingBenchmark({
        ...base,
        potion: {
          ...base.potion,
          config: substitutedConfig,
          provider: new BenchmarkProvider(
            substitutedConfig,
            "static-retrieval",
          ),
        },
      }),
    ).rejects.toThrow("benchmark_model_substitution");
    const artifactConfig = EmbeddingModelConfigSchema.parse({
      ...base.potion.config,
      artifacts: {},
    });
    await expect(
      runOfflineEmbeddingBenchmark({
        ...base,
        potion: {
          ...base.potion,
          config: artifactConfig,
          provider: new BenchmarkProvider(artifactConfig, "static-retrieval"),
        },
      }),
    ).rejects.toThrow("benchmark_artifact_substitution");
    await expect(
      runOfflineEmbeddingBenchmark({
        ...base,
        potion: {
          ...base.potion,
          provider: new BenchmarkProvider(
            EmbeddingModelConfigSchema.parse({
              ...base.potion.config,
              localPath: "/models/other",
            }),
            "static-retrieval",
          ),
        },
      }),
    ).rejects.toThrow("benchmark_provider_substitution");
    for (const providerArtifacts of [
      {},
      {
        ...base.potion.config.artifacts,
        "model.safetensors": `sha256:${"e".repeat(64)}`,
      },
    ]) {
      const providerConfig = EmbeddingModelConfigSchema.parse({
        ...base.potion.config,
        artifacts: providerArtifacts,
      });
      await expect(
        runOfflineEmbeddingBenchmark({
          ...base,
          potion: {
            ...base.potion,
            provider: new BenchmarkProvider(providerConfig, "static-retrieval"),
          },
        }),
      ).rejects.toThrow("benchmark_provider_substitution");
    }
    await expect(
      runOfflineEmbeddingBenchmark({
        ...base,
        potion: {
          ...base.potion,
          provider: new TransformersEmbeddingProvider(base.potion.config),
        },
      }),
    ).rejects.toThrow("benchmark_provider_runtime_substitution");
    await expect(
      runOfflineEmbeddingBenchmark({
        ...base,
        artifactVerifier: async () => ({}),
      }),
    ).rejects.toThrow("benchmark_artifact_unverified");

    const shortProvider: EmbeddingProvider = {
      close: async () => {},
      config: base.granite.config,
      embed: async () => [],
      runtime: "onnx-transformer",
    };
    await expect(
      runOfflineEmbeddingBenchmark({
        ...base,
        granite: { ...base.granite, provider: shortProvider },
      }),
    ).rejects.toThrow("benchmark_vector_count_mismatch");
  });

  test("uses deterministic tie ordering and the default artifact verifier", async () => {
    const profiles = await fixture();
    const firstCase = profiles.offlineCorpus.cases[0];
    if (!firstCase) throw new Error("benchmark_fixture_incomplete");
    const corpus: OfflineBenchmarkCase[] = [
      {
        ...firstCase,
        documents: [
          { id: "z-last", text: "same" },
          { id: "a-first", text: "same" },
        ],
        relevantDocumentIds: ["a-first"],
      },
    ];
    const tied = inputFor(corpus);
    const equalProvider = (
      config: typeof tied.granite.config,
      runtime: "onnx-transformer" | "static-retrieval",
    ): EmbeddingProvider => ({
      close: async () => {},
      config,
      embed: async (texts) =>
        texts.map(() => [
          1,
          ...Array.from({ length: config.dimensions - 1 }, () => 0),
        ]),
      runtime,
    });
    const result = await runOfflineEmbeddingBenchmark({
      ...tied,
      granite: {
        ...tied.granite,
        provider: equalProvider(tied.granite.config, "onnx-transformer"),
      },
      potion: {
        ...tied.potion,
        provider: equalProvider(tied.potion.config, "static-retrieval"),
      },
    });
    expect(result.granite.meanReciprocalRank).toBe(1);
    expect(result.potion.meanReciprocalRank).toBe(1);

    const missingLocal = EmbeddingModelConfigSchema.parse({
      ...tied.granite.config,
      localPath: null,
    });
    await expect(
      runOfflineEmbeddingBenchmark({
        ...tied,
        granite: {
          ...tied.granite,
          config: missingLocal,
          provider: equalProvider(missingLocal, "onnx-transformer"),
        },
      }),
    ).rejects.toThrow("benchmark_local_artifacts_required");
    await expect(
      runOfflineEmbeddingBenchmark({
        ...tied,
        artifactVerifier: undefined,
      }),
    ).rejects.toThrow("embedding_artifact_missing");
  });
});

test("context assembly is deterministic, occurrence-aware, and byte-bounded", () => {
  const candidate = {
    artifactId: createIdentity("chunks", { a: 1 }),
    entityId: graphNodeIdentity({ canonicalName: "a", kind: "function" }),
    language: "typescript",
    path: "src/a.ts",
    range: RANGE,
    reasons: [
      {
        explanation: "Exact symbol evidence",
        rank: 1,
        signal: "exact-symbol" as const,
      },
    ],
    score: 1,
    sourceArtifactId: createIdentity("source", { a: 1 }),
    text: "export const a = 1;",
  };
  const second = {
    ...candidate,
    entityId: graphNodeIdentity({ canonicalName: "b", kind: "function" }),
    path: "src/b.ts",
    score: 0.5,
  };
  const first = assembleContext([second, candidate, candidate], {
    maxBytes: 1_000,
    maxItems: 10,
  });
  const reordered = assembleContext([candidate, second], {
    maxBytes: 1_000,
    maxItems: 10,
  });
  expect(first).toEqual(reordered);
  expect(first.consumedBytes).toBe(Buffer.byteLength(first.rendered));
  expect(Buffer.byteLength(first.rendered)).toBeLessThanOrEqual(1_000);
  expect(first.items).toHaveLength(2);
  expect(
    assembleContext([candidate, second], { maxBytes: 60, maxItems: 1 })
      .truncated,
  ).toBeTrue();
  expect(() => assembleContext([], { maxBytes: 0, maxItems: 1 })).toThrow(
    "context_max_bytes_invalid",
  );
  expect(() => assembleContext([], { maxBytes: 1, maxItems: 0 })).toThrow(
    "context_max_items_invalid",
  );
});

test("accounts for separators at the context byte boundary", () => {
  const firstCandidate = {
    artifactId: createIdentity("chunks", { boundary: 1 }),
    entityId: graphNodeIdentity({
      canonicalName: "firstOnly",
      kind: "function",
    }),
    language: "typescript",
    path: "src/first.ts",
    range: RANGE,
    reasons: [
      {
        explanation: "Exact symbol evidence",
        rank: 1,
        signal: "exact-symbol" as const,
      },
    ],
    score: 1,
    sourceArtifactId: createIdentity("source", { boundary: 1 }),
    text: "firstOnly",
  };
  const secondCandidate = {
    ...firstCandidate,
    artifactId: createIdentity("chunks", { boundary: 2 }),
    entityId: graphNodeIdentity({
      canonicalName: "secondOnly",
      kind: "function",
    }),
    path: "src/second.ts",
    score: 0.5,
    sourceArtifactId: createIdentity("source", { boundary: 2 }),
    text: "secondOnly",
  };
  const firstOnly = assembleContext([firstCandidate], {
    maxBytes: 1_000,
    maxItems: 2,
  });
  const secondOnly = assembleContext([secondCandidate], {
    maxBytes: 1_000,
    maxItems: 2,
  });
  const boundary = assembleContext([firstCandidate, secondCandidate], {
    maxBytes: firstOnly.consumedBytes + secondOnly.consumedBytes,
    maxItems: 2,
  });
  expect(boundary.items.map(({ text }) => text)).toEqual(["firstOnly"]);
  expect(boundary.consumedBytes).toBe(firstOnly.consumedBytes);
  expect(boundary.truncated).toBeTrue();
});

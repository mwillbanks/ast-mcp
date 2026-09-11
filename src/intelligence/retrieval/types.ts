import { z } from "zod";
import {
  EvidenceRangeSchema,
  GenerationIdSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  RepositoryRelativePathSchema,
  RevisionIdSchema,
  SourceArtifactIdSchema,
  WorkspaceIdSchema,
} from "../contracts/common.ts";
import type { GraphEntityIdSchema } from "../contracts/graph.ts";

export const DEFAULT_EMBEDDING_MODEL = Object.freeze({
  artifacts: Object.freeze({
    "config.json": "git-sha1:695e7d72e8e8ecbed7a2c1e3defb7d615e810766",
    "onnx/model_quantized.onnx":
      "sha256:6f479f3970cfec8d7bea633057a29730f4c6c33c02751e2bb89e40ed1fd34677",
    "onnx/model_quantized.onnx_data":
      "sha256:bbd61688b25370a6accfe12fb023bc16ebb643150316e3a90ee5b5de2369d589",
    "tokenizer_config.json":
      "git-sha1:b8255a5d143c116b70899fbe8c24683caebdb638",
    "tokenizer.json": "git-sha1:29ef95af87b26310f30fc2b03f7840848cf85385",
  }),
  dimensions: 384,
  dtype: "q8",
  modelId: "onnx-community/granite-embedding-30m-english-ONNX",
  pooling: "mean",
  revision: "a141ffafe5810d8ee499de14086b5259527ed6ff",
} as const);

export const POTION_CODE_BENCHMARK_MODEL = Object.freeze({
  artifacts: Object.freeze({
    "config.json": "git-sha1:b0d9b9b58c62914f00b7ab0cf1816d08f380b40e",
    "model.safetensors":
      "sha256:75cf7a6c2171b230ad19b1e7d8e0b1aee86da5a02af8e7cacedd9921d227623c",
    "modules.json": "git-sha1:87267c74884fa9da7667436a871449167532bca2",
    "tokenizer.json": "git-sha1:132f9beed4e010dcf53fa53bc23d9b0ff722f3df",
  }),
  dimensions: 256,
  dtype: "fp32",
  modelId: "minishlab/potion-code-16M-v2",
  pooling: "mean",
  revision: "e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
  runtime: "static-retrieval",
} as const);

export const EmbeddingModelConfigSchema = z
  .object({
    artifacts: z.record(z.string(), z.string()).optional(),
    batchSize: z.number().int().positive().max(256).default(8),
    device: z.enum(["auto", "cpu", "gpu", "wasm", "webgpu"]).default("cpu"),
    dimensions: z.number().int().positive().max(65_536).default(384),
    dtype: z.enum(["fp32", "fp16", "q8", "q4"]).default("q8"),
    localPath: z.string().min(1).nullable().default(null),
    maxQueue: z.number().int().positive().max(100_000).default(256),
    modelId: NonEmptyStringSchema.default(DEFAULT_EMBEDDING_MODEL.modelId),
    pooling: z.enum(["mean", "cls"]).default("mean"),
    revision: NonEmptyStringSchema.default(DEFAULT_EMBEDDING_MODEL.revision),
    workers: z.number().int().positive().max(32).default(1),
  })
  .strict()
  .transform((config) => ({
    ...config,
    artifacts:
      config.artifacts ??
      (config.modelId === DEFAULT_EMBEDDING_MODEL.modelId
        ? { ...DEFAULT_EMBEDDING_MODEL.artifacts }
        : {}),
  }));
export type EmbeddingModelConfig = z.infer<typeof EmbeddingModelConfigSchema>;

export const RetrievalScopeSchema = z
  .object({
    generationId: GenerationIdSchema,
    repositoryId: RepositoryIdSchema,
    revisionId: RevisionIdSchema,
    workspaceId: WorkspaceIdSchema,
  })
  .strict();
export type RetrievalScope = z.infer<typeof RetrievalScopeSchema>;

export const RetrievalChunkSchema = z
  .object({
    artifactId: z.string().min(1),
    documentKind: z.enum(["code", "markdown", "text", "rtf", "structured"]),
    language: NonEmptyStringSchema,
    path: RepositoryRelativePathSchema,
    range: EvidenceRangeSchema,
    sourceArtifactId: SourceArtifactIdSchema,
    symbols: z.array(NonEmptyStringSchema).default([]),
    text: z.string(),
  })
  .strict();
export type RetrievalChunk = z.infer<typeof RetrievalChunkSchema>;

export const RetrievalIntentSchema = z.enum([
  "implementation",
  "behavior",
  "documentation",
]);
export type RetrievalIntent = z.infer<typeof RetrievalIntentSchema>;

export const RetrievalBudgetSchema = z
  .object({
    maxBytes: z.number().int().positive().max(100_000_000).default(128_000),
    maxCandidates: z.number().int().positive().max(100_000).default(500),
    maxDepth: z.number().int().nonnegative().max(32).default(2),
    maxGraphBytes: z
      .number()
      .int()
      .positive()
      .max(100_000_000)
      .default(2_000_000),
    maxItems: z.number().int().positive().max(10_000).default(50),
    maxNodes: z.number().int().positive().max(100_000).default(500),
    maxVectorCandidates: z.number().int().positive().max(100_000).default(200),
    maxVectorScan: z.number().int().positive().max(1_000_000).default(5_000),
    timeoutMs: z.number().int().positive().max(120_000).default(5_000),
  })
  .strict();
export type RetrievalBudget = z.infer<typeof RetrievalBudgetSchema>;

export const RetrievalRequestSchema = z
  .object({
    budget: RetrievalBudgetSchema.default({
      maxBytes: 128_000,
      maxCandidates: 500,
      maxDepth: 2,
      maxGraphBytes: 2_000_000,
      maxItems: 50,
      maxNodes: 500,
      maxVectorCandidates: 200,
      maxVectorScan: 5_000,
      timeoutMs: 5_000,
    }),
    deniedPaths: z.array(RepositoryRelativePathSchema).default([]),
    exactSymbols: z.array(NonEmptyStringSchema).default([]),
    includedPaths: z.array(RepositoryRelativePathSchema).default([]),
    intent: RetrievalIntentSchema.default("implementation"),
    languages: z.array(NonEmptyStringSchema).default([]),
    query: NonEmptyStringSchema,
    scope: RetrievalScopeSchema,
    semantic: z.boolean().default(false),
  })
  .strict();
export type RetrievalRequest = z.input<typeof RetrievalRequestSchema>;
export type ResolvedRetrievalRequest = z.output<typeof RetrievalRequestSchema>;

export type RetrievalSignal =
  | "exact-symbol"
  | "lexical"
  | "semantic"
  | "graph-proximity";

export interface RetrievalCandidate {
  artifactId: string;
  entityId: z.infer<typeof GraphEntityIdSchema>;
  language: string;
  path: string;
  range: z.infer<typeof EvidenceRangeSchema>;
  reasons: ReadonlyArray<{
    explanation: string;
    rank: number;
    signal: RetrievalSignal;
  }>;
  score: number;
  sourceArtifactId: string;
  text: string;
}

export interface RetrievalCoverage {
  corruptChunks: number;
  corruptEmbeddings: number;
  degraded: boolean;
  eligibleChunks: number;
  evaluatedCandidates: number;
  graphBytesVisited: number;
  graphEdgesVisited: number;
  graphNodesVisited: number;
  scannedChunkRows: number;
  scannedEmbeddingRows: number;
  scannedGraphMemberships: number;
  scannedGraphOccurrences: number;
  scannedJobRows: number;
  semanticState: "disabled" | "ready" | "pending" | "unavailable";
  totalChunks: number;
}

export interface RetrievalResponse {
  coverage: RetrievalCoverage;
  freshness: {
    indexedAt: string;
    pendingJobCount: number;
    reason: string | null;
    sourceObservedAt: string;
    stale: boolean;
  };
  results: RetrievalCandidate[];
  scope: RetrievalScope;
  truncated: {
    bytes: boolean;
    candidates: boolean;
    graph: boolean;
    items: boolean;
    reason:
      | "none"
      | "byte-limit"
      | "candidate-limit"
      | "item-limit"
      | "time-limit";
    time: boolean;
    vector: boolean;
  };
}

export interface ContextAssembly {
  consumedBytes: number;
  items: ReadonlyArray<{
    entityId: string;
    path: string;
    range: z.infer<typeof EvidenceRangeSchema>;
    score: number;
    text: string;
  }>;
  rendered: string;
  truncated: boolean;
}

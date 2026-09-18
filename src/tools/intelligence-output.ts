import * as z from "zod/v4";

import { toolOutputSchema } from "../helpers/mcp-schema.ts";
import {
  DirtyOverlayArtifactIdSchema,
  GenerationIdSchema,
  GraphEdgeIdSchema,
  GraphEdgeSchema,
  GraphEntityIdSchema,
  GraphEvidenceIdSchema,
  GraphEvidenceSchema,
  GraphNodeIdSchema,
  GraphNodeSchema,
  GraphOccurrenceIdSchema,
  GraphRelationshipSchema,
  LanceTableNameSchema,
  RepositoryIdSchema,
  RevisionIdSchema,
  SourceArtifactIdSchema,
  StorageDomainSchema,
  WorkspaceIdSchema,
} from "../intelligence/contracts/index.ts";
import { GenerationCitationSchema } from "../intelligence/generation/types.ts";
import { RetrievalScopeSchema } from "../intelligence/retrieval/types.ts";

const NonNegativeIntegerSchema = z.number().int().nonnegative();
const CommonIntelligenceDataSchema = z
  .object({
    freshness: z
      .object({
        dirtyOverlayId: DirtyOverlayArtifactIdSchema.nullable(),
        revisionId: RevisionIdSchema,
      })
      .strict(),
    generation: GenerationIdSchema.nullable(),
    repository: RepositoryIdSchema,
    revision: RevisionIdSchema,
    storage: StorageDomainSchema,
    workspace: WorkspaceIdSchema,
  })
  .strict();

const AlgorithmCoverageSchema = z
  .object({
    consideredEdges: NonNegativeIntegerSchema,
    discoveredNodes: NonNegativeIntegerSchema,
    exhaustedReasons: z.array(
      z.enum(["bytes", "depth", "edges", "milliseconds", "nodes", "page"]),
    ),
    generationId: GenerationIdSchema,
    revisionId: RevisionIdSchema,
  })
  .strict();

const StringPageSchema = z
  .object({
    cursor: z.string().nullable(),
    exhaustive: z.boolean(),
    truncated: z.boolean(),
  })
  .strict();

const TraversalResultSchema = z
  .object({
    coverage: AlgorithmCoverageSchema,
    nodes: z.array(GraphNodeSchema),
    page: StringPageSchema,
    relationships: z.array(GraphRelationshipSchema),
  })
  .strict();

const ShortestPathResultSchema = TraversalResultSchema.extend({
  found: z.boolean(),
});

const ComponentsResultSchema = z
  .object({
    components: z.array(z.array(GraphNodeSchema)),
    coverage: AlgorithmCoverageSchema,
    page: StringPageSchema,
  })
  .strict();

const GraphQueryDataSchema = CommonIntelligenceDataSchema.extend({
  result: z.union([TraversalResultSchema, ComponentsResultSchema]),
});

const GraphPathDataSchema = CommonIntelligenceDataSchema.extend({
  result: ShortestPathResultSchema,
});

const GraphExplainDataSchema = CommonIntelligenceDataSchema.extend({
  coverage: z
    .object({
      evaluatedEdges: NonNegativeIntegerSchema,
      exhaustedReasons: z.array(
        z.enum(["bytes", "depth", "edges", "milliseconds", "nodes", "page"]),
      ),
      exhaustive: z.boolean(),
      serializedBytes: NonNegativeIntegerSchema,
      totalEdges: NonNegativeIntegerSchema,
      truncated: z.boolean(),
    })
    .strict(),
  evidence: z.array(GraphEvidenceSchema),
  node: GraphNodeSchema.nullable(),
  page: z
    .object({
      cursor: NonNegativeIntegerSchema.nullable(),
      exhaustive: z.boolean(),
      truncated: z.boolean(),
    })
    .strict(),
  relationships: z.array(GraphEdgeSchema),
});

const DiffBucketSchema = z
  .object({
    edges: z.array(GraphEdgeIdSchema),
    evidence: z.array(GraphEvidenceIdSchema),
    nodes: z.array(GraphNodeIdSchema),
    occurrences: z.array(GraphOccurrenceIdSchema),
  })
  .strict();

const GraphDiffResultSchema = z
  .object({
    added: DiffBucketSchema,
    changed: DiffBucketSchema,
    coverage: z
      .object({
        consideredChanges: NonNegativeIntegerSchema,
        exhaustedReasons: z.array(
          z.enum(["bytes", "depth", "edges", "milliseconds", "nodes", "page"]),
        ),
        exhaustive: z.boolean(),
        totalChanges: NonNegativeIntegerSchema,
        truncated: z.boolean(),
      })
      .strict(),
    fromRevisionId: RevisionIdSchema,
    nextCursor: z.string().nullable(),
    removed: DiffBucketSchema,
    toRevisionId: RevisionIdSchema,
    truncated: z.boolean(),
  })
  .strict();

const GraphDiffDataSchema = z
  .object({
    base: CommonIntelligenceDataSchema,
    federation: z
      .object({
        repositories: z.tuple([RepositoryIdSchema, RepositoryIdSchema]),
      })
      .strict()
      .nullable(),
    result: GraphDiffResultSchema,
    target: CommonIntelligenceDataSchema,
  })
  .strict();

const RetrievalCandidateSchema = z
  .object({
    artifactId: z.string().min(1),
    entityId: GraphEntityIdSchema,
    language: z.string(),
    path: z.string(),
    range: z
      .object({
        startByte: NonNegativeIntegerSchema,
        endByte: NonNegativeIntegerSchema,
        start: z
          .object({
            line: NonNegativeIntegerSchema,
            column: NonNegativeIntegerSchema,
          })
          .strict(),
        end: z
          .object({
            line: NonNegativeIntegerSchema,
            column: NonNegativeIntegerSchema,
          })
          .strict(),
      })
      .strict(),
    reasons: z.array(
      z
        .object({
          explanation: z.string(),
          rank: NonNegativeIntegerSchema,
          signal: z.enum([
            "exact-symbol",
            "lexical",
            "semantic",
            "graph-proximity",
          ]),
        })
        .strict(),
    ),
    score: z.number().finite(),
    sourceArtifactId: SourceArtifactIdSchema,
    text: z.string(),
  })
  .strict();

const RetrieveDataSchema = z
  .object({
    coverage: z
      .object({
        corruptChunks: NonNegativeIntegerSchema,
        corruptEmbeddings: NonNegativeIntegerSchema,
        degraded: z.boolean(),
        eligibleChunks: NonNegativeIntegerSchema,
        evaluatedCandidates: NonNegativeIntegerSchema,
        graphBytesVisited: NonNegativeIntegerSchema,
        graphEdgesVisited: NonNegativeIntegerSchema,
        graphNodesVisited: NonNegativeIntegerSchema,
        scannedChunkRows: NonNegativeIntegerSchema,
        scannedEmbeddingRows: NonNegativeIntegerSchema,
        scannedGraphMemberships: NonNegativeIntegerSchema,
        scannedGraphOccurrences: NonNegativeIntegerSchema,
        scannedJobRows: NonNegativeIntegerSchema,
        semanticState: z.enum(["disabled", "ready", "pending", "unavailable"]),
        totalChunks: NonNegativeIntegerSchema,
      })
      .strict(),
    freshness: z
      .object({
        indexedAt: z.string(),
        pendingJobCount: NonNegativeIntegerSchema,
        reason: z.string().nullable(),
        sourceObservedAt: z.string(),
        stale: z.boolean(),
      })
      .strict(),
    results: z.array(RetrievalCandidateSchema),
    scope: RetrievalScopeSchema,
    truncated: z
      .object({
        bytes: z.boolean(),
        candidates: z.boolean(),
        graph: z.boolean(),
        items: z.boolean(),
        reason: z.enum([
          "none",
          "byte-limit",
          "candidate-limit",
          "item-limit",
          "time-limit",
        ]),
        time: z.boolean(),
        vector: z.boolean(),
      })
      .strict(),
  })
  .strict();

const GenerateDataSchema = z
  .object({
    base: z.null(),
    generated: z
      .object({
        answer: z.string().min(1),
        citations: z.array(GenerationCitationSchema).min(1),
      })
      .strict()
      .nullable(),
    modelIdentity: z.string().nullable(),
    provider: z.enum(["http", "mcp"]).nullable(),
    reason: z.string().nullable(),
    status: z.enum([
      "cancelled",
      "disabled",
      "failed",
      "rejected",
      "succeeded",
      "timeout",
      "unavailable",
    ]),
  })
  .strict();

const StatusCoverageSchema = z
  .object({
    exhaustive: z.boolean(),
    maxRowsPerTable: z.number().int().positive(),
    returnedTables: NonNegativeIntegerSchema,
    timeoutMs: NonNegativeIntegerSchema,
    truncated: z.boolean(),
  })
  .strict();

const StatusDataSchema = CommonIntelligenceDataSchema.extend({
  action: z.literal("status"),
  counts: z.partialRecord(LanceTableNameSchema, NonNegativeIntegerSchema),
  coverage: StatusCoverageSchema,
});

const IndexDataSchema = z.union([
  StatusDataSchema,
  CommonIntelligenceDataSchema.extend({
    action: z.enum(["build", "refresh"]),
    result: z
      .object({
        dirtyOverlayId: DirtyOverlayArtifactIdSchema.nullable(),
        generationId: GenerationIdSchema.nullable(),
        indexedAt: z.string(),
        parsedFiles: z.array(z.string()),
        skippedFiles: z.array(z.string()),
      })
      .strict(),
  }),
  CommonIntelligenceDataSchema.extend({
    action: z.literal("collect"),
    result: z
      .object({
        deletedByTable: z.partialRecord(
          LanceTableNameSchema,
          NonNegativeIntegerSchema,
        ),
        protectedArtifactIds: NonNegativeIntegerSchema,
        protectedGenerationIds: NonNegativeIntegerSchema,
        protectedRevisionIds: NonNegativeIntegerSchema,
      })
      .strict(),
  }),
  CommonIntelligenceDataSchema.extend({
    action: z.literal("verify"),
    coverage: z
      .object({
        artifactReferences: NonNegativeIntegerSchema,
        checkedTables: NonNegativeIntegerSchema,
        exhaustive: z.boolean(),
        truncated: z.boolean(),
      })
      .strict(),
    verified: z.literal(true),
  }),
]);

function intelligenceOutput(data: z.ZodType) {
  return toolOutputSchema.extend({ data: data.optional() });
}

export const IntelligenceOutputSchemas = Object.freeze({
  generate: intelligenceOutput(GenerateDataSchema),
  graphDiff: intelligenceOutput(GraphDiffDataSchema),
  graphExplain: intelligenceOutput(GraphExplainDataSchema),
  graphPath: intelligenceOutput(GraphPathDataSchema),
  graphQuery: intelligenceOutput(GraphQueryDataSchema),
  index: intelligenceOutput(IndexDataSchema),
  indexStatus: intelligenceOutput(StatusDataSchema),
  retrieve: intelligenceOutput(RetrieveDataSchema),
});

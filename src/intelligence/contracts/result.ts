import { z } from "zod";
import {
  EvidenceRangeSchema,
  GenerationIdSchema,
  INTELLIGENCE_SCHEMA_VERSION,
  NonEmptyStringSchema,
  RepositoryRelativePathSchema,
  RevisionIdSchema,
  SearchHitIdSchema,
  SourceArtifactIdSchema,
  TimestampSchema,
  WorkspaceIdSchema,
} from "./common.ts";
import { GraphEntityIdSchema } from "./graph.ts";

export const ResultScopeSchema = z
  .object({
    evaluatedCandidates: z.number().int().nonnegative(),
    excludedPaths: z.array(RepositoryRelativePathSchema),
    includedPaths: z.array(RepositoryRelativePathSchema),
    languages: z.array(NonEmptyStringSchema),
    requestedPaths: z.array(RepositoryRelativePathSchema),
    totalCandidates: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((scope, context) => {
    if (scope.evaluatedCandidates > scope.totalCandidates) {
      context.addIssue({
        code: "custom",
        message: "Evaluated candidates cannot exceed total candidates",
        path: ["evaluatedCandidates"],
      });
    }
  });

export const FreshnessSchema = z
  .object({
    indexedAt: TimestampSchema,
    pendingJobCount: z.number().int().nonnegative(),
    reason: NonEmptyStringSchema.nullable(),
    sourceObservedAt: TimestampSchema,
    stale: z.boolean(),
  })
  .strict()
  .superRefine((freshness, context) => {
    if (freshness.stale !== (freshness.reason !== null)) {
      context.addIssue({
        code: "custom",
        message:
          "Stale results require a reason and fresh results cannot have one",
        path: ["reason"],
      });
    }
  });

export const RankingReasonSchema = z
  .object({
    contribution: z.number().finite(),
    explanation: NonEmptyStringSchema,
    signal: z.enum([
      "exact-symbol",
      "lexical",
      "semantic",
      "graph-proximity",
      "path-affinity",
      "recency",
    ]),
  })
  .strict();

export const PaginationSchema = z
  .object({
    cursor: NonEmptyStringSchema.nullable(),
    hasMore: z.boolean(),
    limit: z.number().int().positive(),
    nextCursor: NonEmptyStringSchema.nullable(),
    returned: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((pagination, context) => {
    if (pagination.returned > pagination.limit) {
      context.addIssue({
        code: "custom",
        message: "Returned count cannot exceed the page limit",
        path: ["returned"],
      });
    }
    if (pagination.hasMore !== (pagination.nextCursor !== null)) {
      context.addIssue({
        code: "custom",
        message: "hasMore must agree with nextCursor",
        path: ["nextCursor"],
      });
    }
  });

export const TruncationBudgetSchema = z
  .object({
    consumedBytes: z.number().int().nonnegative(),
    consumedItems: z.number().int().nonnegative(),
    maxBytes: z.number().int().positive(),
    maxItems: z.number().int().positive(),
    reason: z.enum(["item-limit", "byte-limit", "time-limit", "none"]),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((budget, context) => {
    if (
      budget.consumedItems > budget.maxItems ||
      budget.consumedBytes > budget.maxBytes
    ) {
      context.addIssue({
        code: "custom",
        message: "Consumed budget cannot exceed the requested budget",
      });
    }
    if (budget.truncated !== (budget.reason !== "none")) {
      context.addIssue({
        code: "custom",
        message: "Truncation state must agree with its reason",
        path: ["reason"],
      });
    }
  });

export const SearchEvidenceSchema = z
  .object({
    excerpt: z.string(),
    path: RepositoryRelativePathSchema,
    range: EvidenceRangeSchema,
    sourceArtifactId: SourceArtifactIdSchema,
  })
  .strict();

export const SearchHitSchema = z
  .object({
    entityId: GraphEntityIdSchema,
    evidence: z.array(SearchEvidenceSchema).min(1),
    generationId: GenerationIdSchema,
    hitId: SearchHitIdSchema,
    rankingReasons: z.array(RankingReasonSchema).min(1),
    revisionId: RevisionIdSchema,
    score: z.number().finite(),
    workspaceId: WorkspaceIdSchema,
  })
  .strict();

export const IntelligenceResultSchema = z
  .object({
    budget: TruncationBudgetSchema,
    coverage: ResultScopeSchema,
    freshness: FreshnessSchema,
    generationId: GenerationIdSchema,
    pagination: PaginationSchema,
    results: z.array(SearchHitSchema),
    revisionId: RevisionIdSchema,
    schemaVersion: z.literal(INTELLIGENCE_SCHEMA_VERSION),
    workspaceId: WorkspaceIdSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.pagination.returned !== result.results.length) {
      context.addIssue({
        code: "custom",
        message: "Pagination returned count must equal the result row count",
        path: ["pagination", "returned"],
      });
    }
    result.results.forEach((hit, index) => {
      if (
        hit.workspaceId !== result.workspaceId ||
        hit.revisionId !== result.revisionId ||
        hit.generationId !== result.generationId
      ) {
        context.addIssue({
          code: "custom",
          message:
            "All result rows must use the envelope workspace, revision, and generation",
          path: ["results", index],
        });
      }
    });
  });
export type IntelligenceResult = z.infer<typeof IntelligenceResultSchema>;

export const IntelligenceErrorCodeSchema = z.enum([
  "invalid_request",
  "workspace_not_found",
  "revision_not_found",
  "historical_revision_read_only",
  "path_denied",
  "capability_unsupported",
  "mixed_generation",
  "index_stale",
  "embedding_pending",
  "coordinator_unavailable",
  "storage_unavailable",
  "migration_required",
  "budget_exhausted",
  "internal_error",
]);

export const IntelligenceRecoveryActionSchema = z.enum([
  "correct-request",
  "select-working-revision",
  "request-path-access",
  "choose-supported-language",
  "retry",
  "wait-for-index",
  "run-index",
  "run-migration",
  "reduce-scope",
  "inspect-server-logs",
]);

export const IntelligenceErrorLocationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("repository-relative"),
      path: RepositoryRelativePathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external"),
      location: NonEmptyStringSchema,
    })
    .strict(),
]);

export const IntelligenceErrorSchema = z
  .object({
    actualGenerationId: GenerationIdSchema.nullable(),
    capability: NonEmptyStringSchema.nullable(),
    code: IntelligenceErrorCodeSchema,
    expectedGenerationId: GenerationIdSchema.nullable(),
    message: NonEmptyStringSchema,
    path: IntelligenceErrorLocationSchema.nullable(),
    retryAfterMs: z.number().int().nonnegative().nullable(),
    retryable: z.boolean(),
    schemaVersion: z.literal(INTELLIGENCE_SCHEMA_VERSION),
    selector: NonEmptyStringSchema.nullable(),
    suggestedAction: IntelligenceRecoveryActionSchema,
  })
  .strict()
  .superRefine((error, context) => {
    if (error.code === "mixed_generation") {
      if (
        error.expectedGenerationId === null ||
        error.actualGenerationId === null
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Mixed-generation errors require expected and actual generations",
        });
      }
    }
    if (!error.retryable && error.retryAfterMs !== null) {
      context.addIssue({
        code: "custom",
        message: "Non-retryable errors cannot specify retry timing",
        path: ["retryAfterMs"],
      });
    }
  });
export type IntelligenceError = z.infer<typeof IntelligenceErrorSchema>;

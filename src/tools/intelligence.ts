import { setTimeout as sleep } from "node:timers/promises";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { currentConfig } from "../config/index.ts";
import { toolFailure, toolSuccess } from "../helpers/mcp-schema.ts";
import {
  GenerationIdSchema,
  GraphEdgeKindSchema,
  GraphNodeIdSchema,
  type PublicationGeneration,
  PublicationGenerationSchema,
  ResolutionStatusSchema,
  WorkspaceIdSchema,
} from "../intelligence/contracts/index.ts";
import {
  generateWithEvidence,
  GenerationBudgetSchema,
} from "../intelligence/generation/index.ts";
import {
  createGraphAlgorithmExecutionContext,
  createGraphLoadState,
  diffRevisionGraphs,
  expandImpact,
  type GraphAlgorithmBudget,
  type GraphAlgorithmExecutionContext,
  type GraphAlgorithmSnapshot,
  type GraphLoadOptions,
  type GraphSnapshot,
  LanceGraphRepository,
  shortestPath,
  stronglyConnectedComponents,
  traverseGraph,
} from "../intelligence/graph/index.ts";
import {
  IntelligenceRuntime,
  type IntelligenceRuntimeOptions,
} from "../intelligence/lifecycle/service.ts";
import { refreshMutationIntelligence } from "../intelligence/mutation/freshness.ts";
import {
  assertPublishedMutationGeneration,
  observeMutationIndex,
  withDeferredIndexPublication,
  withFreshMutationRead,
} from "../intelligence/mutation/service.ts";
import {
  RetrievalBudgetSchema,
  retrieve,
} from "../intelligence/retrieval/index.ts";
import { LanceIntelligenceStore } from "../intelligence/storage/store.ts";
import {
  currentWorkspace,
  type WorkspaceHandle,
  withWorkspaceContext,
} from "../intelligence/workspace/context.ts";
import type { ConfiguredExecution } from "./configured.ts";
import { IntelligenceOutputSchemas } from "./intelligence-output.ts";

const WorkspaceRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
});

const IndexReadInputSchema = WorkspaceRequestSchema.extend({
  strictRead: z
    .boolean()
    .optional()
    .describe(
      "Wait within the request budget for scheduled refresh. Defaults to false and permits a stale result from the last complete generation.",
    ),
});

export const GraphBudgetInputSchema = z
  .object({
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024)
      .default(1_000_000),
    maxDepth: z.number().int().nonnegative().max(1_000).default(8),
    maxEdges: z.number().int().positive().max(1_000_000).default(10_000),
    maxMilliseconds: z.number().int().positive().max(120_000).default(5_000),
    maxNodes: z.number().int().positive().max(1_000_000).default(5_000),
    pageSize: z.number().int().positive().max(10_000).default(100),
  })
  .strict()
  .default({
    maxBytes: 1_000_000,
    maxDepth: 8,
    maxEdges: 10_000,
    maxMilliseconds: 5_000,
    maxNodes: 5_000,
    pageSize: 100,
  });

const GraphFiltersSchema = z.object({
  edgeKinds: z.array(GraphEdgeKindSchema).max(32).optional(),
  resolutionStatuses: z.array(ResolutionStatusSchema).max(8).optional(),
});

export const GraphQueryInputSchema = IndexReadInputSchema.extend({
  budget: GraphBudgetInputSchema,
  cursor: z.string().min(1).max(8_192).optional(),
  direction: z.enum(["forward", "reverse"]).default("forward"),
  edgeKinds: GraphFiltersSchema.shape.edgeKinds,
  operation: z.enum(["traverse", "impact", "components"]).default("traverse"),
  resolutionStatuses: GraphFiltersSchema.shape.resolutionStatuses,
  startNodeIds: z.array(GraphNodeIdSchema).min(1).max(1_000),
}).strict();

export const GraphPathInputSchema = IndexReadInputSchema.extend({
  budget: GraphBudgetInputSchema,
  direction: z.enum(["forward", "reverse"]).default("forward"),
  edgeKinds: GraphFiltersSchema.shape.edgeKinds,
  resolutionStatuses: GraphFiltersSchema.shape.resolutionStatuses,
  sourceNodeId: GraphNodeIdSchema,
  targetNodeId: GraphNodeIdSchema,
}).strict();

export const GraphExplainInputSchema = IndexReadInputSchema.extend({
  budget: GraphBudgetInputSchema,
  cursor: z.number().int().nonnegative().default(0),
  nodeId: GraphNodeIdSchema,
  pageSize: z.number().int().positive().max(1_000).default(50),
}).strict();

const GraphDiffScopeSchema = z
  .object({
    generationId: GenerationIdSchema,
    workspaceId: WorkspaceIdSchema,
  })
  .strict();

export const GraphDiffInputSchema = z
  .object({
    base: GraphDiffScopeSchema,
    budget: GraphBudgetInputSchema,
    cursor: z.string().min(1).max(8_192).optional(),
    federation: z.boolean().default(false),
    pageSize: z.number().int().positive().max(10_000).default(100),
    target: GraphDiffScopeSchema,
  })
  .strict();

export const IndexInputSchema = IndexReadInputSchema.extend({
  action: z
    .enum(["build", "refresh", "verify", "collect", "status"])
    .default("status"),
  collection: z
    .object({
      keepFailedJobsForDays: z
        .number()
        .int()
        .nonnegative()
        .max(3_650)
        .optional(),
      keepPublishedGenerations: z
        .number()
        .int()
        .positive()
        .max(10_000)
        .optional(),
      maxDeletesPerTable: z.number().int().positive().max(100_000).optional(),
      pinGraceSeconds: z.number().int().nonnegative().max(86_400).optional(),
      unreachableArtifactDays: z
        .number()
        .int()
        .nonnegative()
        .max(3_650)
        .optional(),
    })
    .strict()
    .optional(),
}).strict();

export const IndexStatusInputSchema = IndexReadInputSchema.extend({
  maxRowsPerTable: z.number().int().positive().max(100_000).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
}).strict();

export const RetrieveInputSchema = IndexReadInputSchema.extend({
  budget: RetrievalBudgetSchema.optional(),
  deniedPaths: z.array(z.string().min(1).max(4_096)).default([]),
  exactSymbols: z.array(z.string().min(1).max(1_024)).default([]),
  includedPaths: z.array(z.string().min(1).max(4_096)).default([]),
  intent: z
    .enum(["implementation", "behavior", "documentation"])
    .default("implementation"),
  languages: z.array(z.string().min(1).max(128)).default([]),
  query: z.string().min(1).max(1_000_000),
  semantic: z.boolean().optional(),
}).strict();

const PublicEvidenceSchema = z
  .object({
    artifactId: z.string().min(1).max(1_024),
    entityId: z.string().min(1).max(1_024),
    path: z.string().min(1).max(4_096),
    range: z
      .object({
        startByte: z.number().int().nonnegative(),
        endByte: z.number().int().nonnegative(),
        start: z.object({
          line: z.number().int().nonnegative(),
          column: z.number().int().nonnegative(),
        }),
        end: z.object({
          line: z.number().int().nonnegative(),
          column: z.number().int().nonnegative(),
        }),
      })
      .strict(),
    text: z.string().max(10_000_000),
  })
  .strict();

export const GenerateInputSchema = IndexReadInputSchema.extend({
  allowedCorpusArtifactIds: z.array(z.string().min(1).max(1_024)),
  budget: GenerationBudgetSchema.optional(),
  evidence: z.array(PublicEvidenceSchema),
  prompt: z.string().min(1).max(1_000_000),
}).strict();

type GraphQueryInput = z.infer<typeof GraphQueryInputSchema>;
type GraphPathInput = z.infer<typeof GraphPathInputSchema>;
type GraphExplainInput = z.infer<typeof GraphExplainInputSchema>;
type GraphDiffInput = z.infer<typeof GraphDiffInputSchema>;
type IndexInput = z.infer<typeof IndexInputSchema>;
type RetrieveInput = z.infer<typeof RetrieveInputSchema>;
type GenerateInput = z.infer<typeof GenerateInputSchema>;

export interface IntelligenceToolService {
  close?(): Promise<void>;
  graphDiff(
    input: GraphDiffInput,
    base: WorkspaceHandle,
    target: WorkspaceHandle,
  ): Promise<unknown>;
  graphExplain(
    input: GraphExplainInput,
    workspace: WorkspaceHandle,
    signal?: AbortSignal,
  ): Promise<unknown>;
  graphPath(
    input: GraphPathInput,
    workspace: WorkspaceHandle,
    signal?: AbortSignal,
  ): Promise<unknown>;
  graphQuery(
    input: GraphQueryInput,
    workspace: WorkspaceHandle,
    signal?: AbortSignal,
  ): Promise<unknown>;
  generate(
    input: GenerateInput,
    workspace: WorkspaceHandle,
    dependencies?: ConfiguredExecution["generationDependencies"],
    signal?: AbortSignal,
  ): Promise<unknown>;
  index(
    input: IndexInput,
    workspace: WorkspaceHandle,
    signal?: AbortSignal,
  ): Promise<unknown>;
  indexStatus(
    workspace: WorkspaceHandle,
    input?: z.infer<typeof IndexStatusInputSchema>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  retrieve(
    input: RetrieveInput,
    workspace: WorkspaceHandle,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

function workspaceFor(workspaceId: string): WorkspaceHandle {
  const workspace = currentWorkspace();
  if (!workspace || workspace.workspaceId !== workspaceId)
    throw Object.assign(new Error("Explicit workspace context is required"), {
      code: "workspace_mismatch",
      retryable: true,
      suggestedNextCall: "workspace_open",
    });
  return workspace;
}

function algorithmSnapshot(snapshot: GraphSnapshot): GraphAlgorithmSnapshot {
  const evidence = new Map<string, GraphSnapshot["evidence"]>();
  for (const item of snapshot.evidence)
    evidence.set(item.edgeId, [...(evidence.get(item.edgeId) ?? []), item]);
  const occurrences = new Map(
    snapshot.occurrences.map((item) => [item.occurrenceId, item]),
  );
  return {
    generationId: snapshot.scope.generationId,
    memberships: snapshot.memberships,
    nodes: snapshot.nodes,
    relationships: snapshot.edges.map((edge) => {
      const edgeEvidence = evidence.get(edge.edgeId) ?? [];
      return {
        edge,
        evidence: edgeEvidence,
        occurrences: edgeEvidence.flatMap((item) => {
          const occurrence = occurrences.get(item.occurrenceId);
          return occurrence ? [occurrence] : [];
        }),
      };
    }),
    revisionId: snapshot.scope.revisionId,
  };
}

async function withStore<T>(
  workspace: WorkspaceHandle,
  operation: (store: LanceIntelligenceStore) => Promise<T>,
  access: "read-only" | "read-pinned" | "read-write" = "read-write",
): Promise<T> {
  const store = await LanceIntelligenceStore.open(workspace.storageDomain, {
    access,
  });
  try {
    return await operation(store);
  } finally {
    await store.shutdownCoordinator();
  }
}

function withFreshStore<T>(
  workspace: WorkspaceHandle,
  operation: (store: LanceIntelligenceStore, expected?: string) => Promise<T>,
  access: "read-only" | "read-write" = "read-write",
): Promise<T> {
  return withFreshMutationRead(workspace, (expected) =>
    withStore(workspace, (store) => operation(store, expected), access),
  );
}

interface IndexReadOptions {
  strictRead?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

function indexRefreshPending() {
  return Object.assign(new Error("Intelligence index refresh is pending"), {
    code: "intelligence_refresh_pending",
    retryable: true,
  });
}

async function withIndexRead<T extends object>(
  workspace: WorkspaceHandle,
  { strictRead, timeoutMs, signal }: IndexReadOptions,
  operation: (generationId?: string, remainingMs?: number) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const deadline = strictRead ? performance.now() + timeoutMs : undefined;
  let before = await observeMutationIndex(workspace);
  while (strictRead && before.pending) {
    const remaining = (deadline ?? 0) - performance.now();
    if (remaining <= 0) throw indexRefreshPending();
    await sleep(Math.min(25, remaining), undefined, { signal });
    before = await observeMutationIndex(workspace);
  }
  if (before.pending && !before.generationId) throw indexRefreshPending();
  const remaining =
    deadline === undefined
      ? undefined
      : Math.floor(deadline - performance.now());
  if (remaining !== undefined && remaining <= 0) throw indexRefreshPending();
  signal?.throwIfAborted();
  const result = await operation(before.generationId, remaining);
  signal?.throwIfAborted();
  if (deadline !== undefined && performance.now() >= deadline)
    throw indexRefreshPending();
  if (workspace.selectedRevision.selector.kind !== "working") return result;
  const after = await observeMutationIndex(workspace);
  if (!before.pending && before.epoch === after.epoch) return result;
  if (strictRead) throw indexRefreshPending();
  const freshness =
    "freshness" in result && typeof result.freshness === "object"
      ? result.freshness
      : undefined;
  return {
    ...result,
    freshness: {
      ...freshness,
      ...(freshness && "reason" in freshness
        ? { reason: "index_refresh_pending" }
        : {}),
      stale: true,
    },
  };
}

function withGraphRead<T extends object>(
  input: { budget: GraphAlgorithmBudget; strictRead?: boolean },
  workspace: WorkspaceHandle,
  signal: AbortSignal | undefined,
  operation: (
    store: LanceIntelligenceStore,
    budget: GraphAlgorithmBudget,
    expected?: string,
  ) => Promise<T>,
): Promise<T> {
  return withIndexRead(
    workspace,
    {
      strictRead: input.strictRead,
      timeoutMs: input.budget.maxMilliseconds,
      signal,
    },
    (expected, remaining) =>
      withStore(
        workspace,
        (store) =>
          operation(
            store,
            {
              ...input.budget,
              maxMilliseconds: remaining ?? input.budget.maxMilliseconds,
            },
            expected,
          ),
        expected ? "read-pinned" : "read-write",
      ),
  );
}

function remainingGraphLoadMilliseconds(
  options?: GraphLoadOptions,
): number | undefined {
  if (!options?.budget) return undefined;
  const remaining = Math.floor(options.budget.deadline - performance.now());
  if (remaining > 0) return remaining;
  options.state?.exhaustedReasons.add("milliseconds");
  throw Object.assign(new Error("Graph load exceeded its time budget"), {
    code: "graph_budget_exhausted",
    retryable: true,
    suggestedNextCall: "retry with a larger maxMilliseconds budget",
  });
}

async function pinGraphGeneration(
  store: LanceIntelligenceStore,
  generation: PublicationGeneration,
  options?: GraphLoadOptions,
) {
  const timeoutMs = remainingGraphLoadMilliseconds(options);
  if (timeoutMs === undefined)
    return store.pinGeneration(generation, "mcp-intelligence-tool");
  const pending = store.pinGeneration(
    generation,
    "mcp-intelligence-tool",
    timeoutMs,
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          options?.state?.exhaustedReasons.add("milliseconds");
          reject(
            Object.assign(
              new Error("Graph reader setup exceeded its time budget"),
              {
                code: "graph_budget_exhausted",
                retryable: true,
                suggestedNextCall: "retry with a larger maxMilliseconds budget",
              },
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    void pending.then((reader) => reader.close()).catch(() => {});
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readIndexGeneration(
  store: LanceIntelligenceStore,
  workspace: WorkspaceHandle,
  generationId: string | undefined,
  timeoutMs = 5_000,
): Promise<PublicationGeneration | null> {
  const publication = generationId
    ? (
        await store.rows(
          "publications",
          `generation_id = '${generationId.replaceAll("\\'", "\\'\\'")}'`,
          {
            limit: 1,
            timeoutMs,
          },
        )
      )[0]
    : undefined;
  const generation = generationId
    ? publication
      ? PublicationGenerationSchema.parse(
          JSON.parse(String(publication.payload_json)),
        )
      : null
    : await store.latestGeneration(workspace.workspaceId, { timeoutMs });
  if (
    generationId &&
    (generation?.generationId !== generationId ||
      generation.revisionId !== workspace.selectedRevision.revisionId ||
      generation.storageDomainId !== workspace.storageDomain.domainId)
  )
    return null;
  return generation;
}

async function loadLatest(
  store: LanceIntelligenceStore,
  workspace: WorkspaceHandle,
  generationId?: string,
  options?: GraphLoadOptions,
  expected?: string,
): Promise<GraphSnapshot> {
  const generation = await readIndexGeneration(
    store,
    workspace,
    expected ?? generationId,
    remainingGraphLoadMilliseconds(options),
  );
  assertPublishedMutationGeneration(expected, generation?.generationId);
  // Reopened working handles can pin only the generation retained for their scope.
  const authorized =
    generation &&
    (generation.workspaceId === workspace.workspaceId ||
      expected !== undefined ||
      (generationId !== undefined &&
        (await observeMutationIndex(workspace)).generationId === generationId));
  if (!generation || !authorized)
    throw Object.assign(
      new Error("Requested generation is unavailable for this workspace"),
      {
        code: "generation_unavailable",
        retryable: true,
        suggestedNextCall: "index_status",
      },
    );
  remainingGraphLoadMilliseconds(options);
  const reader = await pinGraphGeneration(store, generation, options);
  try {
    remainingGraphLoadMilliseconds(options);
    return await new LanceGraphRepository(store).load(
      reader,
      {
        generationId: generation.generationId,
        repositoryId: workspace.repositoryId,
        revisionId: workspace.selectedRevision.revisionId,
        workspaceId: generation.workspaceId,
      },
      { ...workspace, workspaceId: generation.workspaceId },
      options,
    );
  } finally {
    await reader.close();
  }
}

function withoutWorkspaceId<T extends { workspaceId: string }>(
  input: T,
): Omit<T, "workspaceId" | "strictRead"> {
  const { workspaceId, strictRead, ...request } = input as T & {
    strictRead?: boolean;
  };
  void workspaceId;
  void strictRead;
  return request;
}

function commonResult(
  workspace: WorkspaceHandle,
  generationId: string | null,
  generationWorkspaceId?: string,
) {
  return {
    freshness: {
      dirtyOverlayId: workspace.dirtyOverlayId,
      ...(generationWorkspaceId &&
      generationWorkspaceId !== workspace.workspaceId
        ? { generationWorkspaceId }
        : {}),
      revisionId: workspace.selectedRevision.revisionId,
    },
    generation: generationId,
    repository: workspace.repositoryId,
    revision: workspace.selectedRevision.revisionId,
    storage: workspace.storageDomain,
    workspace: workspace.workspaceId,
  };
}

function graphExecution(budget: GraphAlgorithmBudget): {
  context: GraphAlgorithmExecutionContext;
  state: ReturnType<typeof createGraphLoadState>;
} {
  const state = createGraphLoadState();
  return {
    context: createGraphAlgorithmExecutionContext(
      budget,
      state.exhaustedReasons,
    ),
    state,
  };
}

function scopedGraphLoad(
  budget: GraphAlgorithmBudget,
  execution: ReturnType<typeof graphExecution>,
  scope: Omit<GraphLoadOptions, "budget" | "state">,
): GraphLoadOptions {
  return {
    ...scope,
    budget: {
      deadline: execution.context.deadline,
      maxBytes: budget.maxBytes,
      maxEdges: budget.maxEdges,
      maxNodes: budget.maxNodes,
    },
    state: execution.state,
  };
}

async function loadGraphExecution(
  store: LanceIntelligenceStore,
  workspace: WorkspaceHandle,
  budget: GraphAlgorithmBudget,
  scope: Omit<GraphLoadOptions, "budget" | "state">,
  expected?: string,
): Promise<{
  execution: ReturnType<typeof graphExecution>;
  snapshot: GraphSnapshot;
}> {
  const execution = graphExecution(budget);
  const snapshot = await loadLatest(
    store,
    workspace,
    undefined,
    scopedGraphLoad(budget, execution, scope),
    expected,
  );
  return { execution, snapshot };
}

async function readIndexStatus(
  workspace: WorkspaceHandle,
  input?: Pick<
    z.infer<typeof IndexStatusInputSchema>,
    "strictRead" | "timeoutMs" | "maxRowsPerTable"
  >,
  signal?: AbortSignal,
) {
  const timeoutMs = input?.timeoutMs ?? 5_000;
  return withIndexRead(
    workspace,
    { strictRead: input?.strictRead, timeoutMs, signal },
    (expected, remaining) =>
      withStore(
        workspace,
        async (store) => {
          const started = performance.now();
          const budget = remaining ?? timeoutMs;
          const latest =
            budget > 0
              ? await readIndexGeneration(store, workspace, expected, budget)
              : null;
          if (budget > 0)
            assertPublishedMutationGeneration(expected, latest?.generationId);
          const maxRowsPerTable = input?.maxRowsPerTable ?? 10_000;
          const bounded = await store.boundedTableCounts({
            maxRowsPerTable,
            timeoutMs: Math.max(
              0,
              budget - Math.floor(performance.now() - started),
            ),
          });
          return {
            ...commonResult(
              workspace,
              latest?.generationId ?? null,
              latest?.workspaceId,
            ),
            action: "status",
            counts: bounded.counts,
            coverage: {
              exhaustive: bounded.exhaustive,
              maxRowsPerTable,
              returnedTables: bounded.returnedTables,
              timeoutMs,
              truncated: bounded.truncated,
            },
          };
        },
        expected ? "read-pinned" : "read-only",
      ),
  );
}

export function createIntelligenceToolService(
  runtimeOptions: IntelligenceRuntimeOptions = {},
): IntelligenceToolService {
  const runtime = new IntelligenceRuntime(runtimeOptions);
  return {
    async close() {
      await runtime.close();
    },
    async generate(input, workspace, dependencies, signal) {
      return withIndexRead(
        workspace,
        {
          strictRead: input.strictRead,
          timeoutMs: input.budget?.timeoutMs ?? 10_000,
          signal,
        },
        async (expected, remaining) => {
          const config = await currentConfig();
          const configured = config.intelligence.generation;
          const provider =
            configured.provider?.kind === "http"
              ? {
                  apiKey: configured.provider.apiKeyEnv
                    ? (process.env[configured.provider.apiKeyEnv] ?? null)
                    : null,
                  endpoint: configured.provider.endpoint,
                  kind: "http" as const,
                  model: configured.provider.model,
                }
              : configured.provider;
          const latest = await withStore(
            workspace,
            (store) =>
              readIndexGeneration(store, workspace, expected, remaining),
            expected ? "read-pinned" : "read-write",
          );
          assertPublishedMutationGeneration(expected, latest?.generationId);
          if (!latest) throw new Error("generation_unavailable");
          const scope = {
            generationId: latest.generationId,
            repositoryId: workspace.repositoryId,
            revisionId: workspace.selectedRevision.revisionId,
            workspaceId: latest.workspaceId,
          };
          return generateWithEvidence(
            null,
            {
              ...withoutWorkspaceId(input),
              ...(remaining === undefined
                ? {}
                : {
                    budget: GenerationBudgetSchema.parse({
                      ...input.budget,
                      timeoutMs: remaining,
                    }),
                  }),
              enabled: configured.enabled,
              evidence: input.evidence.map((item) => ({ ...item, scope })),
              provider,
              scope,
              signal,
            },
            dependencies,
          );
        },
      );
    },
    async graphDiff(input, base, target) {
      const crossRepository = base.repositoryId !== target.repositoryId;
      const federationEnabled = (await currentConfig()).intelligence.federation
        .enabled;
      if (crossRepository && (!input.federation || !federationEnabled))
        throw Object.assign(
          new Error("Cross-repository graph diff requires federation=true"),
          {
            code: "cross_repository_federation_required",
            retryable: true,
            suggestedNextCall: "graph_diff with federation=true",
          },
        );
      const budget = input.budget as GraphAlgorithmBudget;
      const execution = graphExecution(budget);
      const loadOptions = scopedGraphLoad(budget, execution, {});
      const load = (workspace: WorkspaceHandle, generationId?: string) =>
        withWorkspaceContext(workspace, async () => {
          const observed = await observeMutationIndex(workspace);
          return withStore(
            workspace,
            (store) => loadLatest(store, workspace, generationId, loadOptions),
            observed.generationId ? "read-pinned" : "read-write",
          );
        });
      const [from, to] = await Promise.all([
        load(base, input.base.generationId),
        load(target, input.target.generationId),
      ]);
      const comparableTarget =
        base.repositoryId === target.repositoryId
          ? to
          : {
              ...to,
              scope: { ...to.scope, repositoryId: base.repositoryId },
            };
      return {
        base: commonResult(
          base,
          from.scope.generationId,
          from.scope.workspaceId,
        ),
        federation:
          base.repositoryId === target.repositoryId
            ? null
            : {
                repositories: [base.repositoryId, target.repositoryId],
              },
        result: diffRevisionGraphs(from, comparableTarget, {
          cursor: input.cursor,
          exhaustedReasons: [...execution.state.exhaustedReasons],
          pageSize: input.pageSize,
        }),
        target: commonResult(
          target,
          to.scope.generationId,
          to.scope.workspaceId,
        ),
      };
    },
    async graphExplain(input, workspace, signal) {
      return withGraphRead(
        input,
        workspace,
        signal,
        async (store, budget, expected) => {
          const { execution, snapshot } = await loadGraphExecution(
            store,
            workspace,
            budget,
            {
              direction: "both",
              maxDepth: 0,
              nodeIds: [input.nodeId],
            },
            expected,
          );
          const reasons = execution.state.exhaustedReasons;
          const expired = (): boolean => {
            if (performance.now() < execution.context.deadline) return false;
            reasons.add("milliseconds");
            return true;
          };
          let node: GraphSnapshot["nodes"][number] | undefined;
          for (const candidate of snapshot.nodes) {
            if (expired()) break;
            if (candidate.nodeId === input.nodeId) {
              node = candidate;
              break;
            }
          }
          if (!node && reasons.size === 0)
            throw Object.assign(new Error("Graph node was not found"), {
              code: "graph_node_not_found",
              retryable: false,
            });
          let serializedBytes = 0;
          let returnedNode: GraphSnapshot["nodes"][number] | null = null;
          if (node && !expired()) {
            const size = Buffer.byteLength(JSON.stringify(node));
            if (size <= budget.maxBytes) {
              serializedBytes = size;
              returnedNode = node;
            } else {
              reasons.add("bytes");
            }
          }
          const relatedEdges: GraphSnapshot["edges"] = [];
          for (const edge of snapshot.edges) {
            if (expired()) break;
            if (
              edge.sourceNodeId === input.nodeId ||
              edge.targetNodeId === input.nodeId
            )
              relatedEdges.push(edge);
          }
          if (
            !reasons.has("milliseconds") &&
            input.cursor > relatedEdges.length
          )
            throw Object.assign(
              new Error("Graph explanation cursor is invalid"),
              {
                code: "invalid_graph_cursor",
                retryable: false,
              },
            );
          const evidenceByEdge = new Map<
            string,
            Array<GraphSnapshot["evidence"][number]>
          >();
          for (const item of snapshot.evidence) {
            if (expired()) break;
            const values = evidenceByEdge.get(item.edgeId) ?? [];
            values.push(item);
            evidenceByEdge.set(item.edgeId, values);
          }
          const relationships: GraphSnapshot["edges"] = [];
          const evidence: GraphSnapshot["evidence"] = [];
          const limit = Math.min(
            input.pageSize,
            budget.pageSize,
            budget.maxEdges,
          );
          let next = input.cursor;
          while (
            returnedNode &&
            next < relatedEdges.length &&
            relationships.length < limit &&
            !expired()
          ) {
            const edge = relatedEdges[next];
            if (!edge) break;
            const edgeEvidence = evidenceByEdge.get(edge.edgeId) ?? [];
            let size = Buffer.byteLength(JSON.stringify(edge));
            for (const item of edgeEvidence) {
              if (expired()) break;
              size += Buffer.byteLength(JSON.stringify(item));
            }
            if (reasons.has("milliseconds")) break;
            if (serializedBytes + size > budget.maxBytes) {
              reasons.add("bytes");
              break;
            }
            serializedBytes += size;
            relationships.push(edge);
            evidence.push(...edgeEvidence);
            next++;
          }
          expired();
          const resumable =
            next < relatedEdges.length &&
            !reasons.has("bytes") &&
            !reasons.has("milliseconds") &&
            relationships.length > 0;
          if (resumable) reasons.add("page");
          const exhaustive = reasons.size === 0;
          const page = {
            cursor: resumable ? next : null,
            exhaustive,
            truncated: !exhaustive,
          };
          return {
            ...commonResult(
              workspace,
              snapshot.scope.generationId,
              snapshot.scope.workspaceId,
            ),
            coverage: {
              evaluatedEdges: next,
              exhaustedReasons: [...reasons].sort(),
              exhaustive,
              serializedBytes,
              totalEdges: relatedEdges.length,
              truncated: !exhaustive,
            },
            evidence,
            node: returnedNode,
            page,
            relationships,
          };
        },
      );
    },
    async graphPath(input, workspace, signal) {
      return withGraphRead(
        input,
        workspace,
        signal,
        async (store, budget, expected) => {
          const { execution, snapshot } = await loadGraphExecution(
            store,
            workspace,
            budget,
            {
              direction: input.direction,
              edgeKinds: input.edgeKinds,
              maxDepth: budget.maxDepth,
              nodeIds: [input.sourceNodeId, input.targetNodeId],
              resolutionStatuses: input.resolutionStatuses,
            },
            expected,
          );
          const result = shortestPath(
            {
              budget,
              direction: input.direction,
              edgeKinds: input.edgeKinds,
              resolutionStatuses: input.resolutionStatuses,
              snapshot: algorithmSnapshot(snapshot),
              sourceNodeId: input.sourceNodeId,
              targetNodeId: input.targetNodeId,
            },
            execution.context,
          );
          return {
            ...commonResult(
              workspace,
              snapshot.scope.generationId,
              snapshot.scope.workspaceId,
            ),
            result,
          };
        },
      );
    },
    async graphQuery(input, workspace, signal) {
      return withGraphRead(
        input,
        workspace,
        signal,
        async (store, budget, expected) => {
          const components = input.operation === "components";
          const { execution, snapshot } = await loadGraphExecution(
            store,
            workspace,
            budget,
            {
              direction: components ? "both" : input.direction,
              edgeKinds: input.edgeKinds,
              maxDepth: budget.maxDepth,
              nodeIds: components ? undefined : input.startNodeIds,
              resolutionStatuses: input.resolutionStatuses,
            },
            expected,
          );
          const request = {
            budget,
            cursor: input.cursor,
            edgeKinds: input.edgeKinds,
            resolutionStatuses: input.resolutionStatuses,
            snapshot: algorithmSnapshot(snapshot),
          };
          const result = components
            ? stronglyConnectedComponents(request, undefined, execution.context)
            : input.operation === "impact"
              ? expandImpact(
                  {
                    ...request,
                    direction: input.direction,
                    startNodeIds: input.startNodeIds,
                  },
                  undefined,
                  execution.context,
                )
              : traverseGraph(
                  {
                    ...request,
                    direction: input.direction,
                    startNodeIds: input.startNodeIds,
                  },
                  undefined,
                  execution.context,
                );
          return {
            ...commonResult(
              workspace,
              snapshot.scope.generationId,
              snapshot.scope.workspaceId,
            ),
            result,
          };
        },
      );
    },
    async index(input, workspace, signal) {
      if (input.action === "build" || input.action === "refresh") {
        const result = await withDeferredIndexPublication(
          workspace,
          (finalize) =>
            withStore(workspace, (store) =>
              runtime.runIndexOperation(workspace, (resources) =>
                refreshMutationIntelligence({
                  allowReadOnlySource: true,
                  finalize,
                  analyze: resources.analyze,
                  embedding: resources.embedding,
                  parse: resources.parse,
                  signal,
                  store,
                  supports: resources.supports,
                  workspace,
                }),
              ),
            ),
          signal,
        );
        return {
          ...commonResult(workspace, result.generationId),
          action: input.action,
          result,
        };
      }
      if (input.action === "status")
        return readIndexStatus(workspace, input, signal);
      return withFreshStore(
        workspace,
        async (store, expected) => {
          if (input.action === "collect") {
            const result = await store.collect(input.collection);
            return {
              ...commonResult(
                workspace,
                (await store.latestGeneration(workspace.workspaceId))
                  ?.generationId ?? null,
              ),
              action: input.action,
              result,
            };
          }
          const verification = await store.verifyLatestGeneration(
            workspace.workspaceId,
            workspace.selectedRevision.revisionId,
          );
          assertPublishedMutationGeneration(
            expected,
            verification.generation.generationId,
          );
          return {
            ...commonResult(workspace, verification.generation.generationId),
            action: input.action,
            coverage: {
              artifactReferences: verification.artifactReferences,
              checkedTables: verification.checkedTables,
              exhaustive: verification.exhaustive,
              truncated: false,
            },
            verified: true,
          };
        },
        input.action === "verify" ? "read-only" : "read-write",
      );
    },
    indexStatus: readIndexStatus,
    async retrieve(input, workspace, signal) {
      return withIndexRead(
        workspace,
        {
          strictRead: input.strictRead,
          timeoutMs: input.budget?.timeoutMs ?? 5_000,
          signal,
        },
        (expected, remaining) =>
          withStore(
            workspace,
            async (store) => {
              const generation = await readIndexGeneration(
                store,
                workspace,
                expected,
                remaining,
              );
              assertPublishedMutationGeneration(
                expected,
                generation?.generationId,
              );
              if (!generation) throw new Error("generation_unavailable");
              const reader = await store.pinGeneration(
                generation,
                "mcp-retrieve-tool",
              );
              try {
                const indexedWorkspace = {
                  ...workspace,
                  workspaceId: generation.workspaceId,
                };
                const graph = await new LanceGraphRepository(store).load(
                  reader,
                  {
                    generationId: generation.generationId,
                    repositoryId: workspace.repositoryId,
                    revisionId: workspace.selectedRevision.revisionId,
                    workspaceId: indexedWorkspace.workspaceId,
                  },
                  indexedWorkspace,
                );
                const config = await currentConfig();
                const semantic =
                  input.semantic ?? config.intelligence.retrieval.semantic;
                let query:
                  | Awaited<ReturnType<IntelligenceRuntime["queryVector"]>>
                  | undefined;
                try {
                  query = await runtime.queryVector(
                    input.query,
                    semantic,
                    workspace,
                  );
                } catch (error) {
                  if (!semantic) throw error;
                  query = undefined;
                }
                return await retrieve(
                  store,
                  reader,
                  {
                    ...withoutWorkspaceId(input),
                    ...(remaining === undefined
                      ? {}
                      : {
                          budget: RetrievalBudgetSchema.parse({
                            ...input.budget,
                            timeoutMs: remaining,
                          }),
                        }),
                    scope: graph.scope,
                    semantic,
                  },
                  {
                    graph,
                    model: query?.config,
                    queryVector: query?.vector,
                    workspace: indexedWorkspace,
                  },
                );
              } finally {
                await reader.close();
              }
            },
            expected ? "read-pinned" : "read-write",
          ),
      );
    },
  };
}

function register(
  server: McpServer,
  execute: ConfiguredExecution,
  _service: IntelligenceToolService,
  name: string,
  title: string,
  description: string,
  schema: z.ZodType,
  outputSchema: z.ZodType,
  operation: (
    input: never,
    workspace: WorkspaceHandle,
    signal?: AbortSignal,
  ) => Promise<unknown>,
  readOnly: boolean,
): void {
  server.registerTool(
    name,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: readOnly,
      },
      description,
      inputSchema: schema,
      outputSchema,
      title,
    },
    async (input, context) => {
      try {
        return toolSuccess(
          await execute(
            input,
            (signal) =>
              operation(
                input as never,
                workspaceFor((input as { workspaceId: string }).workspaceId),
                signal,
              ),
            context,
            name,
          ),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

export default function registerIntelligenceTools(
  server: McpServer,
  execute: ConfiguredExecution,
  service?: IntelligenceToolService,
): void {
  const ownsService = service === undefined;
  service ??= createIntelligenceToolService({
    allowEmbeddingDownload: false,
  });
  if (ownsService) {
    const closeServer = server.close.bind(server);
    let closePromise: Promise<void> | undefined;
    server.close = () => {
      closePromise ??= (async () => {
        try {
          await closeServer();
        } finally {
          await service.close?.();
        }
      })();
      return closePromise;
    };
  }

  register(
    server,
    execute,
    service,
    "graph_query",
    "Query Intelligence Graph",
    "Traverses, expands impact, or finds components in the selected workspace generation.",
    GraphQueryInputSchema,
    IntelligenceOutputSchemas.graphQuery,
    service.graphQuery.bind(service),
    true,
  );
  register(
    server,
    execute,
    service,
    "graph_path",
    "Find Intelligence Graph Path",
    "Finds a bounded shortest path with evidence-backed relationships.",
    GraphPathInputSchema,
    IntelligenceOutputSchemas.graphPath,
    service.graphPath.bind(service),
    true,
  );
  register(
    server,
    execute,
    service,
    "graph_explain",
    "Explain Intelligence Graph Node",
    "Returns one graph node with paginated relationships and source evidence.",
    GraphExplainInputSchema,
    IntelligenceOutputSchemas.graphExplain,
    service.graphExplain.bind(service),
    true,
  );
  server.registerTool(
    "graph_diff",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Compares two explicitly selected workspace generations and requires federation for cross-repository requests.",
      inputSchema: GraphDiffInputSchema,
      outputSchema: IntelligenceOutputSchemas.graphDiff,
      title: "Diff Intelligence Graphs",
    },
    async (input, context) => {
      try {
        if (!execute.workspaceRegistry)
          throw new Error("Workspace registry is unavailable");
        const [base, target] = await Promise.all([
          execute.workspaceRegistry.get(input.base.workspaceId),
          execute.workspaceRegistry.get(input.target.workspaceId),
        ]);
        return toolSuccess(
          await execute(
            { workspaceId: base.workspaceId },
            () => service.graphDiff(input, base, target),
            context,
            "graph_diff",
          ),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
  register(
    server,
    execute,
    service,
    "retrieve",
    "Retrieve Intelligence Context",
    "Ranks revision-scoped exact, lexical, semantic, and graph evidence within explicit budgets.",
    RetrieveInputSchema,
    IntelligenceOutputSchemas.retrieve,
    service.retrieve.bind(service),
    true,
  );
  server.registerTool(
    "generate",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Optionally generates a cited answer from explicitly supplied, revision-scoped evidence.",
      inputSchema: GenerateInputSchema,
      outputSchema: IntelligenceOutputSchemas.generate,
      title: "Generate Cited Intelligence Answer",
    },
    async (input, context) => {
      try {
        return toolSuccess(
          await execute(
            input,
            (signal) =>
              service.generate(
                input,
                workspaceFor(input.workspaceId),
                execute.generationDependencies,
                signal,
              ),
            context,
            "generate",
          ),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
  register(
    server,
    execute,
    service,
    "index",
    "Manage Intelligence Index",
    "Builds, refreshes, verifies, collects, or inspects the LanceDB intelligence index.",
    IndexInputSchema,
    IntelligenceOutputSchemas.index,
    service.index.bind(service),
    false,
  );
  register(
    server,
    execute,
    service,
    "index_status",
    "Inspect Intelligence Index",
    "Returns freshness, coverage, storage, and generation status for one workspace.",
    IndexStatusInputSchema,
    IntelligenceOutputSchemas.indexStatus,
    (input, workspace, signal) => service.indexStatus(workspace, input, signal),
    true,
  );
}

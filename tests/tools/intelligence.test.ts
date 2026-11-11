import { describe, expect, spyOn, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/server";

import * as mutation from "../../src/intelligence/mutation/service.ts";
import { LanceIntelligenceStore } from "../../src/intelligence/storage/store.ts";
import {
  type WorkspaceHandle,
  withWorkspaceContext,
} from "../../src/intelligence/workspace/context.ts";
import type { ConfiguredExecution } from "../../src/tools/configured.ts";
import {
  createIntelligenceToolService,
  GenerateInputSchema,
  GraphDiffInputSchema,
  GraphExplainInputSchema,
  GraphPathInputSchema,
  GraphQueryInputSchema,
  IndexInputSchema,
  IndexStatusInputSchema,
  type IntelligenceToolService,
  RetrieveInputSchema,
  default as registerIntelligenceTools,
} from "../../src/tools/intelligence.ts";
import { createMockTime } from "../support/mock-time";

const identity = (namespace: string, character: string) =>
  `${namespace}:v1:${character.repeat(64)}`;

const workspace = {
  checkoutRoot: "/worktrees/feature",
  dirtyOverlayId: null,
  repositoryId: identity("repository", "a"),
  selectedRevision: {
    revisionId: identity("revision", "b"),
    selector: { kind: "index" },
  },
  storageDomain: { domainId: identity("storage-domain", "c") },
  workspaceId: identity("workspace", "d"),
} as unknown as WorkspaceHandle;

const nodeA = identity("graph-node", "e");
const nodeB = identity("graph-node", "f");
const generation = identity("generation", "1");

describe("owned intelligence tool schemas", () => {
  test("require explicit workspace scope and apply bounded defaults", () => {
    expect(
      GraphQueryInputSchema.parse({
        startNodeIds: [nodeA],
        workspaceId: workspace.workspaceId,
      }),
    ).toMatchObject({
      budget: { maxDepth: 8, pageSize: 100 },
      direction: "forward",
      operation: "traverse",
    });
    expect(() =>
      GraphQueryInputSchema.parse({ startNodeIds: [nodeA] }),
    ).toThrow();
    expect(
      GraphPathInputSchema.parse({
        sourceNodeId: nodeA,
        targetNodeId: nodeB,
        workspaceId: workspace.workspaceId,
      }).direction,
    ).toBe("forward");
    expect(
      GraphExplainInputSchema.parse({
        nodeId: nodeA,
        workspaceId: workspace.workspaceId,
      }),
    ).toMatchObject({ cursor: 0, pageSize: 50 });
    expect(
      GraphDiffInputSchema.parse({
        base: { generationId: generation, workspaceId: workspace.workspaceId },
        target: {
          generationId: generation,
          workspaceId: workspace.workspaceId,
        },
      }).pageSize,
    ).toBe(100);
    expect(
      IndexInputSchema.parse({ workspaceId: workspace.workspaceId }).action,
    ).toBe("status");
    expect(
      IndexStatusInputSchema.parse({ workspaceId: workspace.workspaceId }),
    ).toEqual({ workspaceId: workspace.workspaceId });
    expect(
      RetrieveInputSchema.parse({
        query: "find caller",
        workspaceId: workspace.workspaceId,
      }),
    ).toMatchObject({
      deniedPaths: [],
      exactSymbols: [],
      includedPaths: [],
      intent: "implementation",
      languages: [],
    });
    expect(
      GenerateInputSchema.parse({
        allowedCorpusArtifactIds: [],
        evidence: [],
        prompt: "answer",
        workspaceId: workspace.workspaceId,
      }),
    ).toMatchObject({ allowedCorpusArtifactIds: [], evidence: [] });
  });

  test("reject unknown fields and unbounded collection requests", () => {
    expect(() =>
      IndexInputSchema.parse({
        action: "collect",
        collection: { maxDeletesPerTable: 100_001 },
        workspaceId: workspace.workspaceId,
      }),
    ).toThrow();
    expect(() =>
      GraphExplainInputSchema.parse({
        nodeId: nodeA,
        secret: "ignored",
        workspaceId: workspace.workspaceId,
      }),
    ).toThrow();
  });
});

test.each([100, 1])(
  "graph publication pin deadline is bounded at %i milliseconds",
  async (maxMilliseconds) => {
    const time = createMockTime();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let shutdown = 0;
    const store = {
      latestGeneration: async () => ({
        generationId: generation,
        workspaceId: workspace.workspaceId,
      }),
      pinGeneration: async () => {
        entered.resolve();
        await release.promise;
        return {
          close: async () => {
            closed.resolve();
          },
        };
      },
      shutdownCoordinator: async () => {
        shutdown++;
      },
    };
    const open = spyOn(LanceIntelligenceStore, "open").mockResolvedValue(
      store as never,
    );
    const service = createIntelligenceToolService({
      allowEmbeddingDownload: false,
    });
    const query = service
      .graphQuery(
        GraphQueryInputSchema.parse({
          budget: { maxMilliseconds },
          startNodeIds: [nodeA],
          workspaceId: workspace.workspaceId,
        }),
        workspace,
      )
      .then(
        () => {
          throw new Error("Query bypassed its publication deadline");
        },
        (error) => error,
      );
    try {
      await Promise.race([
        entered.promise,
        query.then((error) => {
          throw error;
        }),
      ]);
      await time.advanceBy(maxMilliseconds);
      expect(await query).toMatchObject({ code: "graph_budget_exhausted" });
      expect(shutdown).toBe(1);
      release.resolve();
      await closed.promise;
      expect(time.pending()).toBe(0);
    } finally {
      release.resolve();
      await query;
      open.mockRestore();
      await service.close?.();
      time.dispose();
    }
  },
);

test.each([false, true])(
  "index status checks the publication epoch after reading with strictRead=%s",
  async (strictRead) => {
    const time = createMockTime();
    const working = {
      ...workspace,
      selectedRevision: {
        ...workspace.selectedRevision,
        selector: { kind: "working" } as const,
      },
    };
    const observe = spyOn(mutation, "observeMutationIndex")
      .mockResolvedValueOnce({ epoch: "before", pending: false })
      .mockResolvedValueOnce({ epoch: "after", pending: true });
    const open = spyOn(LanceIntelligenceStore, "open").mockResolvedValue({
      boundedTableCounts: async () => ({
        counts: {},
        exhaustive: true,
        returnedTables: [],
        truncated: false,
      }),
      latestGeneration: async () => ({
        generationId: generation,
        workspaceId: working.workspaceId,
      }),
      shutdownCoordinator: async () => {},
    } as never);
    const service = createIntelligenceToolService();
    try {
      const status = service.indexStatus(
        working,
        IndexStatusInputSchema.parse({
          strictRead,
          workspaceId: working.workspaceId,
        }),
      );
      if (strictRead) {
        await expect(status).rejects.toMatchObject({
          code: "intelligence_refresh_pending",
          retryable: true,
        });
      } else {
        await expect(status).resolves.toMatchObject({
          freshness: { stale: true },
          generation,
        });
      }
      expect(observe).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledWith(working.storageDomain, {
        access: "read-only",
      });
    } finally {
      open.mockRestore();
      observe.mockRestore();
      await service.close?.();
      time.dispose();
    }
  },
);

test("index status reports a pending refresh when no generation can be retained", async () => {
  const observe = spyOn(mutation, "observeMutationIndex").mockResolvedValue({
    pending: true,
  });
  const open = spyOn(LanceIntelligenceStore, "open");
  const service = createIntelligenceToolService();
  try {
    await expect(service.indexStatus(workspace)).rejects.toMatchObject({
      code: "intelligence_refresh_pending",
      retryable: true,
    });
    expect(open).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
    observe.mockRestore();
    await service.close?.();
  }
});

test("registration binds every operation to the selected workspace", async () => {
  type Handler = (
    input: Record<string, unknown>,
    context: unknown,
  ) => Promise<{ isError?: boolean; structuredContent?: unknown }>;
  const handlers = new Map<string, Handler>();
  const definitions = new Map<string, unknown>();
  const server = {
    registerTool(name: string, definition: unknown, handler: Handler) {
      definitions.set(name, definition);
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const execute = Object.assign(
    async <T>(_args: unknown, operation: () => Promise<T>): Promise<T> =>
      withWorkspaceContext(workspace, operation),
    { workspaceRegistry: { get: async () => workspace } },
  ) as unknown as ConfiguredExecution;
  const calls: string[] = [];
  const service: IntelligenceToolService = {
    generate: async (_input, selected) =>
      calls.push(`generate:${selected.checkoutRoot}`),
    graphDiff: async (_input, base, target) =>
      calls.push(`diff:${base.checkoutRoot}:${target.checkoutRoot}`),
    graphExplain: async (_input, selected) =>
      calls.push(`explain:${selected.checkoutRoot}`),
    graphPath: async (_input, selected) =>
      calls.push(`path:${selected.checkoutRoot}`),
    graphQuery: async (_input, selected) =>
      calls.push(`query:${selected.checkoutRoot}`),
    index: async (_input, selected) =>
      calls.push(`index:${selected.checkoutRoot}`),
    indexStatus: async (selected) =>
      calls.push(`status:${selected.checkoutRoot}`),
    retrieve: async (_input, selected) =>
      calls.push(`retrieve:${selected.checkoutRoot}`),
  };
  registerIntelligenceTools(server, execute, service);

  expect([...handlers.keys()].sort()).toEqual([
    "generate",
    "graph_diff",
    "graph_explain",
    "graph_path",
    "graph_query",
    "index",
    "index_status",
    "retrieve",
  ]);
  for (const name of handlers.keys()) {
    const input =
      name === "graph_diff"
        ? {
            base: {
              generationId: generation,
              workspaceId: workspace.workspaceId,
            },
            target: {
              generationId: generation,
              workspaceId: workspace.workspaceId,
            },
          }
        : name === "retrieve"
          ? { query: "symbol", workspaceId: workspace.workspaceId }
          : name === "generate"
            ? {
                allowedCorpusArtifactIds: [],
                evidence: [],
                prompt: "answer",
                workspaceId: workspace.workspaceId,
              }
            : { workspaceId: workspace.workspaceId };
    const result = await handlers.get(name)?.(input, {});
    expect(result?.isError).not.toBeTrue();
  }
  expect(calls).toEqual([
    "query:/worktrees/feature",
    "path:/worktrees/feature",
    "explain:/worktrees/feature",
    "diff:/worktrees/feature:/worktrees/feature",
    "retrieve:/worktrees/feature",
    "generate:/worktrees/feature",
    "index:/worktrees/feature",
    "status:/worktrees/feature",
  ]);
  expect(definitions.size).toBe(8);
  for (const definition of definitions.values()) {
    const outputSchema = (
      definition as {
        outputSchema: { safeParse(value: unknown): { success: boolean } };
      }
    ).outputSchema;
    expect(outputSchema.safeParse({ data: {}, ok: true }).success).toBeFalse();
  }

  const mismatch = await handlers.get("index_status")?.(
    { workspaceId: identity("workspace", "9") },
    {},
  );
  expect(mismatch?.isError).toBeTrue();
  expect(mismatch?.structuredContent).toMatchObject({
    error: {
      code: "workspace_mismatch",
      suggestedNextCall: "workspace_open",
    },
    ok: false,
  });
});

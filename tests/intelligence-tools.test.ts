import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";

import { graphNodeIdentity } from "../src/intelligence/contracts/graph.ts";
import { LanceIntelligenceStore } from "../src/intelligence/storage/store.ts";
import {
  type WorkspaceHandle,
  withWorkspaceContext,
} from "../src/intelligence/workspace/context.ts";
import { WorkspaceRegistry } from "../src/intelligence/workspace/registry.ts";
import type { ConfiguredExecution } from "../src/tools/configured.ts";
import { IntelligenceOutputSchemas } from "../src/tools/intelligence-output.ts";
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
} from "../src/tools/intelligence.ts";

const identity = (namespace: string, character: string) =>
  `${namespace}:v1:${character.repeat(64)}`;

const workspace = {
  checkoutRoot: "/worktrees/feature",
  dirtyOverlayId: null,
  repositoryId: identity("repository", "a"),
  selectedRevision: { revisionId: identity("revision", "b") },
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

test("native index and graph tools stay bound to a worktree generation", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-public-intelligence-"),
  );
  const storage = path.join(root, "lance");
  await writeFile(
    path.join(root, "service.ts"),
    "export function alpha() { return beta(); }\nfunction beta() { return 1; }\n",
  );
  const selected = await new WorkspaceRegistry().open({
    configurationGeneration: 1,
    directory: root,
    storage: { kind: "explicit", path: storage },
  });
  const defaultIntelligenceToolService = createIntelligenceToolService({
    allowEmbeddingDownload: false,
  });
  try {
    await withWorkspaceContext(selected, async () => {
      const built = (await defaultIntelligenceToolService.index(
        { action: "build", workspaceId: selected.workspaceId },
        selected,
      )) as { generation: string };
      expect(built.generation).toStartWith("generation:v1:");

      const status = (await defaultIntelligenceToolService.indexStatus(
        selected,
      )) as {
        counts: Record<string, number>;
        coverage: { exhaustive: boolean; truncated: boolean };
        generation: string;
      };
      expect(status.generation).toBe(built.generation);
      expect(status.coverage).toMatchObject({
        exhaustive: true,
        truncated: false,
      });
      expect(Object.keys(status.counts).length).toBeGreaterThan(0);

      const actionStatus = (await defaultIntelligenceToolService.index(
        { action: "status", workspaceId: selected.workspaceId },
        selected,
      )) as {
        action: string;
        coverage: { exhaustive: boolean; truncated: boolean };
      };
      expect(actionStatus).toMatchObject({
        action: "status",
        coverage: { exhaustive: true, truncated: false },
      });

      const cappedStatus = (await defaultIntelligenceToolService.indexStatus(
        selected,
        {
          maxRowsPerTable: 1,
          timeoutMs: 5_000,
          workspaceId: selected.workspaceId,
        },
      )) as {
        counts: Record<string, number>;
        coverage: { exhaustive: boolean; truncated: boolean };
      };
      expect(cappedStatus.coverage).toMatchObject({
        exhaustive: false,
        truncated: true,
      });
      expect(
        Object.values(cappedStatus.counts).every((count) => count <= 1),
      ).toBeTrue();

      const expiredStatus = (await defaultIntelligenceToolService.indexStatus(
        selected,
        {
          maxRowsPerTable: 10,
          timeoutMs: 0,
          workspaceId: selected.workspaceId,
        },
      )) as {
        counts: Record<string, number>;
        coverage: { exhaustive: boolean; truncated: boolean };
      };
      expect(expiredStatus.counts).toEqual({});
      expect(expiredStatus.coverage).toMatchObject({
        exhaustive: false,
        truncated: true,
      });

      const retrieved = (await defaultIntelligenceToolService.retrieve(
        RetrieveInputSchema.parse({
          query: "alpha",
          workspaceId: selected.workspaceId,
        }),
        selected,
      )) as { scope: { generationId: string; workspaceId: string } };
      expect(retrieved.scope).toMatchObject({
        generationId: built.generation,
        workspaceId: selected.workspaceId,
      });

      const generated = (await defaultIntelligenceToolService.generate(
        GenerateInputSchema.parse({
          allowedCorpusArtifactIds: [],
          evidence: [],
          prompt: "answer",
          workspaceId: selected.workspaceId,
        }),
        selected,
      )) as { status: string };
      expect(generated.status).toBe("disabled");

      const verified = (await defaultIntelligenceToolService.index(
        { action: "verify", workspaceId: selected.workspaceId },
        selected,
      )) as { verified: boolean };
      expect(verified.verified).toBeTrue();

      const repositoryNodeId = graphNodeIdentity({
        canonicalName: `repository:${selected.repositoryId}`,
        kind: "repository",
      });
      const queryBudget = GraphQueryInputSchema.parse({
        startNodeIds: [repositoryNodeId],
        workspaceId: selected.workspaceId,
      }).budget;
      const delayedReader = { close: async () => {} };
      const pinSpy = spyOn(
        LanceIntelligenceStore.prototype,
        "pinGeneration",
      ).mockImplementation(async () => {
        await Bun.sleep(150);
        return delayedReader as never;
      });
      try {
        await expect(
          defaultIntelligenceToolService.graphQuery(
            {
              budget: { ...queryBudget, maxMilliseconds: 100 },
              direction: "forward",
              operation: "traverse",
              startNodeIds: [repositoryNodeId],
              workspaceId: selected.workspaceId,
            },
            selected,
          ),
        ).rejects.toMatchObject({ code: "graph_budget_exhausted" });
        await Bun.sleep(75);
      } finally {
        pinSpy.mockRestore();
      }
      await expect(
        defaultIntelligenceToolService.graphQuery(
          {
            budget: { ...queryBudget, maxMilliseconds: 1 },
            direction: "forward",
            operation: "traverse",
            startNodeIds: [repositoryNodeId],
            workspaceId: selected.workspaceId,
          },
          selected,
        ),
      ).rejects.toMatchObject({ code: "graph_budget_exhausted" });

      const queried = (await defaultIntelligenceToolService.graphQuery(
        {
          budget: queryBudget,
          direction: "forward",
          operation: "traverse",
          startNodeIds: [repositoryNodeId],
          workspaceId: selected.workspaceId,
        },
        selected,
      )) as { result: { coverage: { generationId: string } } };
      expect(queried.result.coverage.generationId).toBe(built.generation);

      for (const operation of ["impact", "components"] as const) {
        const result = (await defaultIntelligenceToolService.graphQuery(
          {
            budget: queryBudget,
            direction: "forward",
            operation,
            startNodeIds: [repositoryNodeId],
            workspaceId: selected.workspaceId,
          },
          selected,
        )) as { result: { coverage: { generationId: string } } };
        expect(result.result.coverage.generationId).toBe(built.generation);
      }

      const pathResult = (await defaultIntelligenceToolService.graphPath(
        GraphPathInputSchema.parse({
          sourceNodeId: nodeA,
          targetNodeId: nodeB,
          workspaceId: selected.workspaceId,
        }),
        selected,
      )) as { result: { found: boolean } };
      expect(pathResult.result.found).toBeFalse();

      const explanation = (await defaultIntelligenceToolService.graphExplain(
        GraphExplainInputSchema.parse({
          nodeId: repositoryNodeId,
          pageSize: 1,
          workspaceId: selected.workspaceId,
        }),
        selected,
      )) as {
        evidence: unknown[];
        node: { nodeId: string };
        page: { exhaustive: boolean };
        relationships: unknown[];
      };
      expect(explanation.node.nodeId).toBe(repositoryNodeId);
      expect(explanation.relationships).toHaveLength(1);
      expect(explanation.evidence).toHaveLength(1);
      expect(explanation.page.exhaustive).toBeTrue();

      const oneByte = (await defaultIntelligenceToolService.graphExplain(
        GraphExplainInputSchema.parse({
          budget: { ...queryBudget, maxBytes: 1 },
          nodeId: repositoryNodeId,
          pageSize: 1,
          workspaceId: selected.workspaceId,
        }),
        selected,
      )) as {
        coverage: {
          exhaustedReasons: string[];
          serializedBytes: number;
          truncated: boolean;
        };
        node: null;
        page: { cursor: null; exhaustive: boolean; truncated: boolean };
        relationships: unknown[];
      };
      expect(oneByte).toMatchObject({
        coverage: {
          exhaustedReasons: ["bytes"],
          serializedBytes: 0,
          truncated: true,
        },
        node: null,
        page: { cursor: null, exhaustive: false, truncated: true },
        relationships: [],
      });

      const fileNodeId = graphNodeIdentity({
        canonicalName: `repository:${selected.repositoryId}:file:service.ts`,
        kind: "file",
      });
      const firstExplanation =
        (await defaultIntelligenceToolService.graphExplain(
          GraphExplainInputSchema.parse({
            nodeId: fileNodeId,
            pageSize: 1,
            workspaceId: selected.workspaceId,
          }),
          selected,
        )) as {
          coverage: { serializedBytes: number };
          evidence: unknown[];
          node: unknown;
          page: {
            cursor: number | null;
            exhaustive: boolean;
            truncated: boolean;
          };
          relationships: Array<{ edgeId: string }>;
        };
      expect(firstExplanation.page).toMatchObject({
        exhaustive: false,
        truncated: true,
      });
      expect(firstExplanation.page.cursor).not.toBeNull();
      const serializedItems: unknown[] = [
        firstExplanation.node,
        ...firstExplanation.relationships,
        ...firstExplanation.evidence,
      ].filter((item) => item !== null);
      expect(firstExplanation.coverage.serializedBytes).toBe(
        serializedItems.reduce<number>(
          (sum, item) => sum + Buffer.byteLength(JSON.stringify(item)),
          0,
        ),
      );
      const secondExplanation =
        (await defaultIntelligenceToolService.graphExplain(
          GraphExplainInputSchema.parse({
            cursor: firstExplanation.page.cursor ?? 0,
            nodeId: fileNodeId,
            pageSize: 1,
            workspaceId: selected.workspaceId,
          }),
          selected,
        )) as {
          page: { cursor: number | null };
          relationships: Array<{ edgeId: string }>;
        };
      expect(secondExplanation.relationships[0]?.edgeId).not.toBe(
        firstExplanation.relationships[0]?.edgeId,
      );

      const diff = (await defaultIntelligenceToolService.graphDiff(
        GraphDiffInputSchema.parse({
          base: {
            generationId: built.generation,
            workspaceId: selected.workspaceId,
          },
          target: {
            generationId: built.generation,
            workspaceId: selected.workspaceId,
          },
        }),
        selected,
        selected,
      )) as { result: { coverage: { totalChanges: number } } };
      expect(diff.result.coverage.totalChanges).toBe(0);
      for (const [schema, data] of [
        [IntelligenceOutputSchemas.index, built],
        [IntelligenceOutputSchemas.indexStatus, status],
        [IntelligenceOutputSchemas.retrieve, retrieved],
        [IntelligenceOutputSchemas.generate, generated],
        [IntelligenceOutputSchemas.index, verified],
        [IntelligenceOutputSchemas.graphQuery, queried],
        [IntelligenceOutputSchemas.graphPath, pathResult],
        [IntelligenceOutputSchemas.graphExplain, firstExplanation],
        [IntelligenceOutputSchemas.graphDiff, diff],
      ] as const)
        expect(schema.safeParse({ data, ok: true }).success).toBeTrue();

      await expect(
        defaultIntelligenceToolService.graphDiff(
          GraphDiffInputSchema.parse({
            base: {
              generationId: identity("generation", "9"),
              workspaceId: selected.workspaceId,
            },
            target: {
              generationId: built.generation,
              workspaceId: selected.workspaceId,
            },
          }),
          selected,
          selected,
        ),
      ).rejects.toMatchObject({ code: "generation_unavailable" });

      const otherRepository = {
        ...selected,
        repositoryId: identity("repository", "9"),
      } as WorkspaceHandle;
      await expect(
        defaultIntelligenceToolService.graphDiff(
          GraphDiffInputSchema.parse({
            base: {
              generationId: built.generation,
              workspaceId: selected.workspaceId,
            },
            target: {
              generationId: built.generation,
              workspaceId: selected.workspaceId,
            },
          }),
          selected,
          otherRepository,
        ),
      ).rejects.toMatchObject({
        code: "cross_repository_federation_required",
      });
      await expect(
        defaultIntelligenceToolService.graphDiff(
          GraphDiffInputSchema.parse({
            base: {
              generationId: built.generation,
              workspaceId: selected.workspaceId,
            },
            federation: true,
            target: {
              generationId: built.generation,
              workspaceId: selected.workspaceId,
            },
          }),
          selected,
          otherRepository,
        ),
      ).rejects.toMatchObject({
        code: "cross_repository_federation_required",
      });

      const collected = (await defaultIntelligenceToolService.index(
        {
          action: "collect",
          collection: { maxDeletesPerTable: 1 },
          workspaceId: selected.workspaceId,
        },
        selected,
      )) as { action: string };
      expect(collected.action).toBe("collect");
    });
  } finally {
    await defaultIntelligenceToolService.close?.();
    await rm(root, { force: true, recursive: true });
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

import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { graphNodeIdentity } from "../../src/intelligence/contracts/graph.ts";
import { LanceGraphRepository } from "../../src/intelligence/graph/repository.ts";
import {
  type WorkspaceHandle,
  withWorkspaceContext,
} from "../../src/intelligence/workspace/context.ts";
import { WorkspaceRegistry } from "../../src/intelligence/workspace/registry.ts";
import { IntelligenceOutputSchemas } from "../../src/tools/intelligence-output.ts";
import {
  createIntelligenceToolService,
  GenerateInputSchema,
  GraphDiffInputSchema,
  GraphExplainInputSchema,
  GraphPathInputSchema,
  GraphQueryInputSchema,
  RetrieveInputSchema,
} from "../../src/tools/intelligence.ts";

const identity = (namespace: string, character: string) =>
  `${namespace}:v1:${character.repeat(64)}`;

const nodeA = identity("graph-node", "e");
const nodeB = identity("graph-node", "f");

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

      await expect(
        defaultIntelligenceToolService.graphExplain(
          GraphExplainInputSchema.parse({
            nodeId: nodeA,
            workspaceId: selected.workspaceId,
          }),
          selected,
        ),
      ).rejects.toMatchObject({
        code: "graph_node_not_found",
        retryable: false,
      });
      await expect(
        defaultIntelligenceToolService.graphExplain(
          GraphExplainInputSchema.parse({
            nodeId: repositoryNodeId,
            cursor: 10_000,
            workspaceId: selected.workspaceId,
          }),
          selected,
        ),
      ).rejects.toMatchObject({
        code: "invalid_graph_cursor",
        retryable: false,
      });

      const originalLoad = LanceGraphRepository.prototype.load;
      let clockSpy:
        | ReturnType<typeof spyOn<typeof performance, "now">>
        | undefined;
      const expireAfterLoad = spyOn(
        LanceGraphRepository.prototype,
        "load",
      ).mockImplementation(async function (
        this: LanceGraphRepository,
        ...args
      ) {
        const graph = await originalLoad.apply(this, args);
        clockSpy = spyOn(performance, "now").mockReturnValue(
          Number.MAX_SAFE_INTEGER,
        );
        return graph;
      });
      try {
        const expired = await defaultIntelligenceToolService.graphExplain(
          GraphExplainInputSchema.parse({
            nodeId: repositoryNodeId,
            workspaceId: selected.workspaceId,
          }),
          selected,
        );
        expect(expired).toMatchObject({
          node: null,
          relationships: [],
          evidence: [],
          coverage: { exhaustedReasons: ["milliseconds"], truncated: true },
          page: { cursor: null, exhaustive: false, truncated: true },
        });
      } finally {
        clockSpy?.mockRestore();
        expireAfterLoad.mockRestore();
      }

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

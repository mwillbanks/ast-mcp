import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sourceArtifactIdentity } from "../src/intelligence/contracts/artifacts.ts";
import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../src/intelligence/contracts/common.ts";
import {
  graphEvidenceIdentity,
  revisionMembershipIdentity,
} from "../src/intelligence/contracts/graph.ts";
import {
  createStorageDomainId,
  type StorageDomain,
} from "../src/intelligence/contracts/storage.ts";
import { diffRevisionGraphs } from "../src/intelligence/graph/diff.ts";
import { graphFromResolution } from "../src/intelligence/graph/from-resolution.ts";
import { materializeGraph } from "../src/intelligence/graph/materializer.ts";
import {
  createGraphLoadState,
  decodeEdge,
  decodeEvidence,
  decodeMembership,
  decodeNode,
  decodeOccurrence,
  LanceGraphRepository,
} from "../src/intelligence/graph/repository.ts";
import { GraphSnapshotSchema } from "../src/intelligence/graph/types.ts";
import { parseSource } from "../src/intelligence/parser/parser.ts";
import { materializeResolutionInput } from "../src/intelligence/resolution/index.ts";
import {
  LanceIntelligenceStore,
  type PinnedGenerationReader,
} from "../src/intelligence/storage/store.ts";
import type { WorkspaceHandle } from "../src/intelligence/workspace/context.ts";

async function domain(): Promise<StorageDomain> {
  const storagePath = await mkdtemp(join(tmpdir(), "ast-mcp-graph-"));
  return {
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
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing graph fixture value");
  return value;
}

function fixture(
  source = "export const value = 1; value;",
  revision = "working",
) {
  const repositoryId = createIdentity("repository", { root: "/graph" });
  const revisionId = createIdentity("revision", { revision });
  const workspaceId = createIdentity("workspace", { checkout: "/graph" });
  const generationId = createIdentity("generation", { revisionId });
  const facts = parseSource({
    languageId: "typescript",
    source,
  });
  const scope = { generationId, repositoryId, revisionId, workspaceId };
  const snapshot = materializeGraph({
    environmentFingerprint: "b".repeat(64),
    extractorVersion: "wp08-repository-v1",
    scope,
    units: [
      {
        facts,
        kind: "syntax",
        path: "src/value.ts",
        sourceArtifactId: sourceArtifactIdentity({
          contentDigest: facts.sourceDigest,
        }),
      },
    ],
  });
  const workspace = {
    repositoryId,
    selectedRevision: { revisionId },
    workspaceId,
    writeEligibility: { eligible: true },
  } as unknown as WorkspaceHandle;
  return { scope, snapshot, workspace };
}

describe("LanceDB graph repository", () => {
  test("serializes concurrent immutable writes and reloads one authorized generation", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const repository = new LanceGraphRepository(store);
    const { scope, snapshot, workspace } = fixture();
    const edgeWithoutEvidence = required(snapshot.edges[0]);
    const invalidEvidenceIds = new Set(
      snapshot.evidence
        .filter((evidence) => evidence.edgeId === edgeWithoutEvidence.edgeId)
        .map((evidence) => evidence.evidenceId),
    );
    await expect(
      repository.persist(
        {
          ...snapshot,
          evidence: snapshot.evidence.filter(
            (evidence) => evidence.edgeId !== edgeWithoutEvidence.edgeId,
          ),
          memberships: snapshot.memberships.filter(
            (membership) =>
              membership.entityKind !== "evidence" ||
              !invalidEvidenceIds.has(membership.entityId),
          ),
        },
        workspace,
      ),
    ).rejects.toThrow("requires at least one evidence record");
    await Promise.all([
      repository.persist(snapshot, workspace),
      repository.persist(snapshot, workspace),
    ]);
    expect(await store.count("graph_nodes")).toBe(snapshot.nodes.length);
    expect(await store.count("graph_edges")).toBe(snapshot.edges.length);
    expect(await store.count("graph_evidence")).toBe(snapshot.evidence.length);
    expect(await store.count("revision_membership")).toBe(
      snapshot.memberships.length,
    );

    const reader = {
      pin: {
        generationId: scope.generationId,
        revisionId: scope.revisionId,
        workspaceId: scope.workspaceId,
      },
      rows: (table: Parameters<LanceIntelligenceStore["rows"]>[0]) =>
        store.rows(table),
    } as unknown as PinnedGenerationReader;
    await expect(repository.load(reader, scope)).rejects.toThrow(
      "workspace_context_required",
    );
    expect(await repository.load(reader, scope, workspace)).toEqual(snapshot);
    await store.shutdownCoordinator();

    const reopened = await LanceIntelligenceStore.open(storage);
    expect(await reopened.count("graph_occurrences")).toBe(
      snapshot.occurrences.length,
    );
    await reopened.shutdownCoordinator();
  });

  test("loads a bounded logical-node neighborhood without materializing a large generation", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const repository = new LanceGraphRepository(store);
    const large = fixture(
      Array.from(
        { length: 500 },
        (_, index) => `export const value${index} = ${index};`,
      ).join("\n"),
      "large",
    );
    await repository.persist(large.snapshot, large.workspace);
    expect(await store.count("graph_nodes")).toBeGreaterThan(500);
    const target = required(
      large.snapshot.nodes.find((node) =>
        node.properties.some(
          ({ key, value }) => key === "name" && value === "value250",
        ),
      ),
    );
    const calls: Array<{
      limit: number | undefined;
      predicate: string | undefined;
      table: string;
    }> = [];
    const reader = {
      pin: {
        generationId: large.scope.generationId,
        revisionId: large.scope.revisionId,
        workspaceId: large.scope.workspaceId,
      },
      rows: (
        table: Parameters<LanceIntelligenceStore["rows"]>[0],
        predicate?: string,
        options: { limit?: number; timeoutMs?: number } = {},
      ) => {
        calls.push({ limit: options.limit, predicate, table });
        return store.rows(table, predicate, options);
      },
    } as unknown as PinnedGenerationReader;
    const state = createGraphLoadState();
    const restored = await repository.load(
      reader,
      large.scope,
      large.workspace,
      {
        budget: {
          deadline: performance.now() + 5_000,
          maxBytes: 100_000,
          maxEdges: 2,
          maxNodes: 3,
        },
        direction: "both",
        maxDepth: 0,
        nodeIds: [target.nodeId],
        state,
      },
    );
    expect(restored.nodes.some(({ nodeId }) => nodeId === target.nodeId)).toBe(
      true,
    );
    expect(restored.nodes.length).toBeLessThanOrEqual(3);
    expect(restored.edges.length).toBeLessThanOrEqual(2);
    expect(
      calls.find(({ table }) => table === "graph_nodes")?.predicate,
    ).toContain("canonical_name LIKE");
    const graphNodeCall = calls.find(({ table }) => table === "graph_nodes");
    expect(graphNodeCall?.limit).toBeUndefined();
    expect(
      calls
        .filter(
          ({ table }) =>
            table !== "graph_nodes" &&
            table !== "graph_edges" &&
            table !== "graph_evidence",
        )
        .every(({ limit, predicate }) => limit !== undefined && !!predicate),
    ).toBe(true);
    const edgeMembershipCall = calls.findIndex(
      ({ predicate, table }) =>
        table === "revision_membership" &&
        predicate?.includes("entity_kind") &&
        predicate.includes("edge"),
    );
    const edgeEntityCall = calls.findLastIndex(
      ({ table }) => table === "graph_edges",
    );
    const evidenceMembershipCall = calls.findIndex(
      ({ predicate, table }) =>
        table === "revision_membership" &&
        predicate?.includes("entity_kind") &&
        predicate.includes("evidence"),
    );
    const evidenceEntityCall = calls.findLastIndex(
      ({ table }) => table === "graph_evidence",
    );
    expect(edgeMembershipCall).toBeGreaterThanOrEqual(0);
    expect(edgeMembershipCall).toBeLessThan(edgeEntityCall);
    expect(evidenceMembershipCall).toBeGreaterThanOrEqual(0);
    expect(evidenceMembershipCall).toBeLessThan(evidenceEntityCall);
    expect(restored.memberships.map(({ entityId }) => entityId).sort()).toEqual(
      [
        ...restored.nodes.map(({ nodeId }) => nodeId),
        ...restored.edges.map(({ edgeId }) => edgeId),
        ...restored.occurrences.map(({ occurrenceId }) => occurrenceId),
        ...restored.evidence.map(({ evidenceId }) => evidenceId),
      ].sort(),
    );
    expect(GraphSnapshotSchema.parse(restored)).toEqual(restored);
    await store.shutdownCoordinator();
  });

  test("keeps tiny-budget selection stable across reader ordering", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const repository = new LanceGraphRepository(store);
    const selected = fixture(
      Array.from(
        { length: 20 },
        (_, index) => `export const value${index} = ${index};`,
      ).join("\n"),
      "membership-crowding",
    );
    await repository.persist(selected.snapshot, selected.workspace);
    const logicalTarget = required(selected.snapshot.edges[0]).targetNodeId;
    const storedNodes = await store.rows("graph_nodes");
    const storedTarget = required(
      storedNodes.find((row) =>
        String(row.canonical_name).startsWith(
          `graph-node-version:v2:${Buffer.from(logicalTarget).toString("base64url")}:`,
        ),
      ),
    );
    const storedEdges = await store.rows("graph_edges");
    const relevantEdge = required(
      storedEdges.find(
        (row) =>
          row.source_node_id === storedTarget.node_id ||
          row.target_node_id === storedTarget.node_id,
      ),
    );
    const unrelatedEdge = required(
      storedEdges.find(
        (row) =>
          row.edge_id !== relevantEdge.edge_id &&
          row.source_node_id !== storedTarget.node_id &&
          row.target_node_id !== storedTarget.node_id,
      ),
    );
    const storedEvidence = await store.rows("graph_evidence");
    const relevantEvidence = required(
      storedEvidence.find((row) => row.edge_id === relevantEdge.edge_id),
    );
    const unrelatedEvidence = required(
      storedEvidence.find(
        (row) =>
          row.edge_id === unrelatedEdge.edge_id &&
          row.evidence_id !== relevantEvidence.evidence_id,
      ),
    );
    const storedMemberships = await store.rows("revision_membership");
    const unrelatedEdgeMembership = required(
      storedMemberships.find(
        (row) =>
          row.entity_kind === "edge" && row.entity_id === unrelatedEdge.edge_id,
      ),
    );
    const unrelatedEvidenceMembership = required(
      storedMemberships.find(
        (row) =>
          row.entity_kind === "evidence" &&
          row.entity_id === unrelatedEvidence.evidence_id,
      ),
    );
    const membershipPredicates: string[] = [];
    const createReader = (reverseRows: boolean) =>
      ({
        pin: {
          generationId: selected.scope.generationId,
          revisionId: selected.scope.revisionId,
          workspaceId: selected.scope.workspaceId,
        },
        rows: async (
          table: Parameters<LanceIntelligenceStore["rows"]>[0],
          predicate?: string,
          options: { limit?: number; timeoutMs?: number } = {},
        ) => {
          if (table === "revision_membership") {
            membershipPredicates.push(predicate ?? "");
            const isExact = predicate?.includes("entity_id") ?? false;
            if (!isExact && predicate?.includes("edge"))
              return [unrelatedEdgeMembership];
            if (!isExact && predicate?.includes("evidence"))
              return [unrelatedEvidenceMembership];
          }
          const rows = await store.rows(table, predicate, options);
          return reverseRows ? [...rows].reverse() : rows;
        },
      }) as unknown as PinnedGenerationReader;
    const load = (reader: PinnedGenerationReader) =>
      repository.load(reader, selected.scope, selected.workspace, {
        budget: {
          deadline: performance.now() + 5_000,
          maxBytes: 100_000,
          maxEdges: 1,
          maxNodes: 3,
        },
        direction: "both",
        maxDepth: 0,
        nodeIds: [logicalTarget],
        state: createGraphLoadState(),
      });
    const restored = await load(createReader(false));
    const reordered = await load(createReader(true));
    expect(restored.edges).toHaveLength(1);
    expect(
      restored.edges.some(
        (edge) =>
          edge.sourceNodeId === logicalTarget ||
          edge.targetNodeId === logicalTarget,
      ),
    ).toBe(true);
    expect(restored.evidence).not.toHaveLength(0);
    expect(reordered.nodes).toEqual(restored.nodes);
    expect(reordered.edges).toEqual(restored.edges);
    expect(reordered.evidence).toEqual(restored.evidence);
    expect(reordered.occurrences).toEqual(restored.occurrences);
    expect(reordered.memberships).toEqual(restored.memberships);
    expect(
      membershipPredicates.some(
        (predicate) =>
          predicate.includes("edge") && predicate.includes("entity_id"),
      ),
    ).toBe(true);
    expect(
      membershipPredicates.some(
        (predicate) =>
          predicate.includes("evidence") && predicate.includes("entity_id"),
      ),
    ).toBe(true);
    await store.shutdownCoordinator();
  });

  test("applies unrestricted edge limits after aggregating every frontier", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const repository = new LanceGraphRepository(store);
    const selected = fixture(
      Array.from(
        { length: 300 },
        (_, index) => `export const value${index} = ${index};`,
      ).join("\n"),
      "unrestricted-global-limit",
    );
    expect(selected.snapshot.edges.length).toBeGreaterThan(300);
    await repository.persist(selected.snapshot, selected.workspace);

    const createReader = (reverseRows: boolean) =>
      ({
        pin: {
          generationId: selected.scope.generationId,
          revisionId: selected.scope.revisionId,
          workspaceId: selected.scope.workspaceId,
        },
        rows: async (
          table: Parameters<LanceIntelligenceStore["rows"]>[0],
          predicate?: string,
          options: { limit?: number; timeoutMs?: number } = {},
        ) => {
          const rows = await store.rows(table, predicate, options);
          return reverseRows ? [...rows].reverse() : rows;
        },
      }) as unknown as PinnedGenerationReader;
    const load = async (reverseRows: boolean) => {
      const state = createGraphLoadState();
      const snapshot = await repository.load(
        createReader(reverseRows),
        selected.scope,
        selected.workspace,
        {
          budget: {
            deadline: performance.now() + 15_000,
            maxBytes: 50_000_000,
            maxEdges: 300,
            maxNodes: 2_000,
          },
          state,
        },
      );
      return { snapshot, state };
    };

    const normal = await load(false);
    const reordered = await load(true);
    expect(normal.snapshot.edges).toHaveLength(300);
    expect(normal.state.exhaustedReasons).toContain("edges");
    expect(reordered.snapshot).toEqual(normal.snapshot);
    expect(reordered.state.exhaustedReasons).toEqual(
      normal.state.exhaustedReasons,
    );
    await store.shutdownCoordinator();
  });

  test("preserves stable logical nodes across immutable content versions and restart", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const repository = new LanceGraphRepository(store);
    const first = fixture("export const value = 1; value;", "first");
    const second = fixture("export const value = 2; value;", "second");
    const symbol = (snapshot: typeof first.snapshot) =>
      required(
        snapshot.nodes.find((node) =>
          node.properties.some(
            (property) => property.key === "name" && property.value === "value",
          ),
        ),
      );
    expect(symbol(first.snapshot).nodeId).toBe(symbol(second.snapshot).nodeId);
    expect(symbol(first.snapshot).contentFingerprint).not.toBe(
      symbol(second.snapshot).contentFingerprint,
    );
    const graphDiff = diffRevisionGraphs(first.snapshot, second.snapshot, {
      pageSize: 10_000,
    });
    expect(graphDiff.changed.nodes).toContain(symbol(first.snapshot).nodeId);
    expect(graphDiff.added.nodes).not.toContain(symbol(first.snapshot).nodeId);
    expect(graphDiff.removed.nodes).not.toContain(
      symbol(first.snapshot).nodeId,
    );

    await Promise.all([
      repository.persist(first.snapshot, first.workspace),
      repository.persist(second.snapshot, second.workspace),
    ]);
    expect(await store.count("graph_nodes")).toBeGreaterThan(
      first.snapshot.nodes.length,
    );
    const storedNodes = await store.rows("graph_nodes");
    const storedOccurrences = await store.rows("graph_occurrences");
    const storedEdges = await store.rows("graph_edges");
    const storedEvidence = await store.rows("graph_evidence");
    const storedMemberships = await store.rows("revision_membership");
    const nodeIds = new Set(storedNodes.map((row) => row.node_id));
    const occurrenceIds = new Set(
      storedOccurrences.map((row) => row.occurrence_id),
    );
    const edgeIds = new Set(storedEdges.map((row) => row.edge_id));
    expect(storedOccurrences.every((row) => nodeIds.has(row.node_id))).toBe(
      true,
    );
    expect(
      storedEdges.every(
        (row) =>
          nodeIds.has(row.source_node_id) && nodeIds.has(row.target_node_id),
      ),
    ).toBe(true);
    expect(
      storedEvidence.every(
        (row) =>
          edgeIds.has(row.edge_id) && occurrenceIds.has(row.occurrence_id),
      ),
    ).toBe(true);
    const entityIds = new Set([
      ...nodeIds,
      ...occurrenceIds,
      ...edgeIds,
      ...storedEvidence.map((row) => row.evidence_id),
    ]);
    expect(storedMemberships.every((row) => entityIds.has(row.entity_id))).toBe(
      true,
    );

    const reader = (
      selected: typeof first,
      selectedStore: LanceIntelligenceStore,
    ) =>
      ({
        pin: {
          generationId: selected.scope.generationId,
          revisionId: selected.scope.revisionId,
          workspaceId: selected.scope.workspaceId,
        },
        rows: (table: Parameters<LanceIntelligenceStore["rows"]>[0]) =>
          selectedStore.rows(table),
      }) as unknown as PinnedGenerationReader;
    expect(
      await repository.load(reader(first, store), first.scope, first.workspace),
    ).toEqual(first.snapshot);
    expect(
      await repository.load(
        reader(second, store),
        second.scope,
        second.workspace,
      ),
    ).toEqual(second.snapshot);
    await store.shutdownCoordinator();

    const reopened = await LanceIntelligenceStore.open(storage);
    const reopenedRepository = new LanceGraphRepository(reopened);
    expect(
      await reopenedRepository.load(
        reader(first, reopened),
        first.scope,
        first.workspace,
      ),
    ).toEqual(first.snapshot);
    expect(
      await reopenedRepository.load(
        reader(second, reopened),
        second.scope,
        second.workspace,
      ),
    ).toEqual(second.snapshot);
    await reopened.shutdownCoordinator();
  });

  test("persists and restores resolution-backed hierarchy after restart", async () => {
    const storage = await domain();
    const repositoryId = createIdentity("repository", {
      root: "/graph-hierarchy",
    });
    const revisionId = createIdentity("revision", { revision: "hierarchy" });
    const generationId = createIdentity("generation", { revisionId });
    const workspaceId = createIdentity("workspace", {
      checkout: "/graph-hierarchy",
    });
    const digest = "a".repeat(64);
    const artifactId = sourceArtifactIdentity({ contentDigest: digest });
    const projectDigest = "f".repeat(64);
    const projectArtifactId = sourceArtifactIdentity({
      contentDigest: projectDigest,
    });
    const exactRange = (startByte: number, endByte: number) => ({
      end: { column: endByte, line: 0 },
      endByte,
      endCoordinate: {
        byteOffset: endByte,
        characterOffset: endByte,
        column: endByte,
        line: 0,
        utf16Column: endByte,
        utf16Offset: endByte,
      },
      start: { column: startByte, line: 0 },
      startByte,
      startCoordinate: {
        byteOffset: startByte,
        characterOffset: startByte,
        column: startByte,
        line: 0,
        utf16Column: startByte,
        utf16Offset: startByte,
      },
    });
    const parentFactId = "b".repeat(64);
    const childFactId = "c".repeat(64);
    const resolution = materializeResolutionInput({
      environmentFingerprint: "d".repeat(64),
      repositoryId,
      resolverFingerprint: "e".repeat(64),
      revisionId,
      sources: [
        {
          facts: {
            artifactId,
            nodes: [
              {
                id: childFactId,
                name: "API",
                nodeKind: "section",
                parentId: parentFactId,
                range: exactRange(6, 9),
              },
              {
                id: parentFactId,
                name: "Guide",
                nodeKind: "document",
                parentId: null,
                range: exactRange(0, 5),
              },
            ],
            relationships: [],
            sourceDigest: digest,
          },
          kind: "document",
          path: "docs/guide.md",
        },
        {
          facts: {
            diagnostics: [],
            format: "dotnet-project",
            nodes: [
              {
                attributes: {},
                childIds: [],
                id: "1".repeat(64),
                kind: "package",
                name: "Child",
                parentId: "2".repeat(64),
                range: exactRange(4, 7),
              },
              {
                attributes: {},
                childIds: ["1".repeat(64)],
                id: "2".repeat(64),
                kind: "project",
                name: "Parent",
                parentId: null,
                range: exactRange(0, 3),
              },
            ],
            parserFingerprint: "3".repeat(64),
            partial: false,
            relationships: [],
            rewriteSupported: false,
            schemaVersion: "ast-mcp.project-facts.v1",
            sourceArtifactId: projectArtifactId,
            sourceByteLength: 8,
            sourceDigest: projectDigest,
            syntaxFactsArtifactId: "4".repeat(64),
          },
          kind: "project",
          path: "app.csproj",
        },
      ],
    });
    const scope = { generationId, repositoryId, revisionId, workspaceId };
    const snapshot = graphFromResolution(resolution, {
      generationId,
      sourceDigests: {
        [artifactId]: digest,
        [projectArtifactId]: projectDigest,
      },
      workspaceId,
    });
    const workspace = {
      repositoryId,
      selectedRevision: { revisionId },
      workspaceId,
      writeEligibility: { eligible: true },
    } as unknown as WorkspaceHandle;
    const nodeByName = (name: string) =>
      required(
        snapshot.nodes.find((node) =>
          node.properties.some(
            (property) => property.key === "name" && property.value === name,
          ),
        ),
      );
    const parent = nodeByName("Guide");
    const child = nodeByName("API");
    const nodeByResolutionKind = (kind: "project" | "package") => {
      const resolutionNodeId = required(
        resolution.nodes.find((node) => node.kind === kind),
      ).id;
      return required(
        snapshot.nodes.find((node) =>
          node.properties.some(
            (property) =>
              property.key === "resolutionNodeId" &&
              property.value === resolutionNodeId,
          ),
        ),
      );
    };
    const projectParent = nodeByResolutionKind("project");
    const projectChild = nodeByResolutionKind("package");
    const containsHierarchy = (
      selected: typeof snapshot,
      selectedParent: typeof parent,
      selectedChild: typeof child,
    ) =>
      selected.edges.some(
        (edge) =>
          edge.kind === "contains" &&
          edge.sourceNodeId === selectedParent.nodeId &&
          edge.targetNodeId === selectedChild.nodeId,
      );
    expect(containsHierarchy(snapshot, parent, child)).toBe(true);
    expect(containsHierarchy(snapshot, projectParent, projectChild)).toBe(true);

    const store = await LanceIntelligenceStore.open(storage);
    await new LanceGraphRepository(store).persist(snapshot, workspace);
    await store.shutdownCoordinator();
    const reopened = await LanceIntelligenceStore.open(storage);
    const restored = await new LanceGraphRepository(reopened).load(
      {
        pin: { generationId, revisionId, workspaceId },
        rows: (table: Parameters<LanceIntelligenceStore["rows"]>[0]) =>
          reopened.rows(table),
      } as unknown as PinnedGenerationReader,
      scope,
      workspace,
    );
    expect(restored).toEqual(snapshot);
    expect(containsHierarchy(restored, parent, child)).toBe(true);
    expect(containsHierarchy(restored, projectParent, projectChild)).toBe(true);
    await reopened.shutdownCoordinator();
  });

  test("rejects unauthorized coordinates and malformed persistent rows", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const repository = new LanceGraphRepository(store);
    const { scope, snapshot, workspace } = fixture();
    await expect(
      repository.persist(snapshot, {
        ...workspace,
        workspaceId: createIdentity("workspace", { wrong: true }),
      }),
    ).rejects.toThrow("graph_scope_unauthorized");
    await expect(
      repository.persist(snapshot, {
        ...workspace,
        writeEligibility: { eligible: false, reason: "historical" },
      } as unknown as WorkspaceHandle),
    ).rejects.toThrow("workspace_read_only");
    await expect(repository.persist(snapshot)).rejects.toThrow(
      "workspace_context_required",
    );
    await expect(
      repository.load(
        {
          pin: {
            generationId: createIdentity("generation", { wrong: true }),
            revisionId: scope.revisionId,
            workspaceId: scope.workspaceId,
          },
        } as unknown as PinnedGenerationReader,
        scope,
        workspace,
      ),
    ).rejects.toThrow("graph_reader_pin_unauthorized");

    const node = required(snapshot.nodes[0]);
    const occurrence = required(snapshot.occurrences[0]);
    const edge = required(snapshot.edges[0]);
    const evidence = required(snapshot.evidence[0]);
    const membership = required(snapshot.memberships[0]);
    expect(
      decodeNode({
        canonical_name: node.canonicalName,
        content_fingerprint: node.contentFingerprint,
        kind: node.kind,
        node_id: node.nodeId,
        properties_json: JSON.stringify(node.properties),
      }),
    ).toEqual(node);
    expect(
      decodeOccurrence({
        node_id: occurrence.nodeId,
        occurrence_id: occurrence.occurrenceId,
        path: occurrence.path,
        range_json: JSON.stringify(occurrence.range),
        role: occurrence.role,
        source_artifact_id: occurrence.sourceArtifactId,
      }),
    ).toEqual(occurrence);
    expect(
      decodeEdge({
        content_fingerprint: edge.contentFingerprint,
        discriminator: edge.discriminator,
        edge_id: edge.edgeId,
        environment_fingerprint: edge.environmentFingerprint,
        kind: edge.kind,
        properties_json: JSON.stringify(edge.properties),
        resolution_status: edge.resolutionStatus,
        source_node_id: edge.sourceNodeId,
        target_node_id: edge.targetNodeId,
      }),
    ).toEqual(edge);
    expect(
      decodeEvidence({
        confidence: evidence.confidence,
        edge_id: evidence.edgeId,
        evidence_id: evidence.evidenceId,
        extraction_method: evidence.extractionMethod,
        extraction_version: evidence.extractionVersion,
        extractor_fingerprint: evidence.extractorFingerprint,
        occurrence_id: evidence.occurrenceId,
        path: evidence.path,
        range_json: JSON.stringify(evidence.range),
        source_artifact_id: evidence.sourceArtifactId,
      }),
    ).toEqual(evidence);
    expect(
      decodeMembership({
        entity_id: membership.entityId,
        entity_kind: membership.entityKind,
        generation_id: membership.generationId,
        membership_id: membership.membershipId,
        revision_id: membership.revisionId,
      }),
    ).toEqual(membership);
    expect(() =>
      decodeNode({
        ...node,
        properties_json: "{",
      }),
    ).toThrow("invalid_graph_json");
    await store.shutdownCoordinator();
  });

  test("validates snapshot uniqueness and graph referential integrity", () => {
    const { snapshot } = fixture();
    const edge = required(snapshot.edges[0]);
    const edgeEvidence = snapshot.evidence.filter(
      (item) => item.edgeId === edge.edgeId,
    );
    const edgeEvidenceIds = new Set(
      edgeEvidence.map((item) => item.evidenceId),
    );
    expect(() =>
      GraphSnapshotSchema.parse({
        ...snapshot,
        evidence: snapshot.evidence.filter(
          (item) => item.edgeId !== edge.edgeId,
        ),
        memberships: snapshot.memberships.filter(
          (membership) =>
            membership.entityKind !== "evidence" ||
            !edgeEvidenceIds.has(membership.entityId),
        ),
      }),
    ).toThrow("requires at least one evidence record");

    const incompatible = snapshot.evidence
      .map((evidence) => {
        const selectedEdge = snapshot.edges.find(
          (item) => item.edgeId === evidence.edgeId,
        );
        const alienOccurrence = snapshot.occurrences.find(
          (occurrence) =>
            selectedEdge &&
            occurrence.nodeId !== selectedEdge.sourceNodeId &&
            occurrence.nodeId !== selectedEdge.targetNodeId,
        );
        return alienOccurrence ? { alienOccurrence, evidence } : undefined;
      })
      .find((item) => item !== undefined);
    if (!incompatible) throw new Error("expected unrelated occurrence");
    const { alienOccurrence, evidence } = incompatible;
    const movedEvidence = {
      ...evidence,
      occurrenceId: alienOccurrence.occurrenceId,
      path: alienOccurrence.path,
      range: alienOccurrence.range,
      sourceArtifactId: alienOccurrence.sourceArtifactId,
    };
    movedEvidence.evidenceId = graphEvidenceIdentity({
      edgeId: movedEvidence.edgeId,
      extractionMethod: movedEvidence.extractionMethod,
      extractionVersion: movedEvidence.extractionVersion,
      extractorFingerprint: movedEvidence.extractorFingerprint,
      occurrenceId: movedEvidence.occurrenceId,
      path: movedEvidence.path,
      range: movedEvidence.range,
      sourceArtifactId: movedEvidence.sourceArtifactId,
    });
    expect(() =>
      GraphSnapshotSchema.parse({
        ...snapshot,
        evidence: snapshot.evidence.map((item) =>
          item.evidenceId === evidence.evidenceId ? movedEvidence : item,
        ),
        memberships: snapshot.memberships.map((membership) =>
          membership.entityKind === "evidence" &&
          membership.entityId === evidence.evidenceId
            ? {
                ...membership,
                entityId: movedEvidence.evidenceId,
                membershipId: revisionMembershipIdentity({
                  entityId: movedEvidence.evidenceId,
                  entityKind: "evidence",
                  generationId: membership.generationId,
                  revisionId: membership.revisionId,
                }),
              }
            : membership,
        ),
      }),
    ).toThrow("edge endpoint");
    expect(() =>
      GraphSnapshotSchema.parse({
        ...snapshot,
        nodes: [...snapshot.nodes, snapshot.nodes[0]],
      }),
    ).toThrow("duplicate identities");
    expect(() =>
      GraphSnapshotSchema.parse({
        ...snapshot,
        occurrences: [
          {
            ...snapshot.occurrences[0],
            nodeId: createIdentity("graph-node", { missing: true }),
          },
        ],
      }),
    ).toThrow("unknown node");
    expect(() =>
      GraphSnapshotSchema.parse({
        ...snapshot,
        edges: [
          {
            ...snapshot.edges[0],
            sourceNodeId: createIdentity("graph-node", { missing: true }),
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      GraphSnapshotSchema.parse({
        ...snapshot,
        evidence: [
          {
            ...snapshot.evidence[0],
            occurrenceId: createIdentity("graph-occurrence", { missing: true }),
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      GraphSnapshotSchema.parse({
        ...snapshot,
        memberships: [
          {
            ...snapshot.memberships[0],
            entityId: createIdentity("graph-node", { missing: true }),
          },
        ],
      }),
    ).toThrow();
  });
});

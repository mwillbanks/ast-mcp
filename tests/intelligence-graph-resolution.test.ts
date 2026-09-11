import { describe, expect, test } from "bun:test";
import { sourceArtifactIdentity } from "../src/intelligence/contracts/artifacts.ts";
import { createIdentity } from "../src/intelligence/contracts/common.ts";
import { traverseGraph } from "../src/intelligence/graph/algorithms/index.ts";
import { graphFromResolution } from "../src/intelligence/graph/from-resolution.ts";
import { GraphSnapshotSchema } from "../src/intelligence/graph/types.ts";
import {
  acceptedIntelligenceManifestRegistry,
  createIntelligenceManifestRegistry,
} from "../src/intelligence/manifest-registry.ts";
import { parseSource } from "../src/intelligence/parser/parser.ts";
import { materializeResolutionInput } from "../src/intelligence/resolution/index.ts";

const HASH = "e".repeat(64);

function contentDigests(
  sources: readonly {
    facts: { sourceArtifactId: string; sourceDigest: string };
  }[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    sources.map(({ facts }) => [facts.sourceArtifactId, facts.sourceDigest]),
  );
}

describe("resolution graph integration", () => {
  test("converts exact, ambiguous, and unresolved resolver observations into WP02 graph records", () => {
    const repositoryId = createIdentity("repository", { root: "/resolution" });
    const revisionId = createIdentity("revision", { commit: "abc" });
    const workspaceId = createIdentity("workspace", {
      checkout: "/resolution",
    });
    const generationId = createIdentity("generation", { revisionId });
    const sources = [
      {
        facts: parseSource({
          languageId: "typescript",
          source:
            "export function exact() { return 1; } export function duplicate() {}",
        }),
        kind: "code" as const,
        path: "src/a.ts",
      },
      {
        facts: parseSource({
          languageId: "typescript",
          source: "export function duplicate() {}",
        }),
        kind: "code" as const,
        path: "src/other.ts",
      },
      {
        facts: parseSource({
          languageId: "typescript",
          source:
            "import { exact } from './a'; exact(); duplicate(); missing();",
        }),
        kind: "code" as const,
        path: "src/use.ts",
      },
    ];
    const resolution = materializeResolutionInput({
      environmentFingerprint: HASH,
      repositoryId,
      resolverFingerprint: HASH,
      revisionId,
      sources,
    });
    const sourceDigests = contentDigests(sources);
    const graph = graphFromResolution(resolution, {
      generationId,
      sourceDigests,
      workspaceId,
    });
    expect(GraphSnapshotSchema.parse(graph)).toEqual(graph);
    const statuses = new Set(graph.edges.map((edge) => edge.resolutionStatus));
    expect(statuses.has("resolved")).toBe(true);
    expect(statuses.has("unresolved")).toBe(true);
    expect(graph.nodes.some((node) => node.kind === "external-reference")).toBe(
      true,
    );
    const duplicateTargets = resolution.nodes
      .filter((node) => node.name === "duplicate")
      .map((node) => node.id);
    const ambiguousGraph = graphFromResolution(
      {
        ...resolution,
        relationships: resolution.relationships.map((relationship) =>
          relationship.target === "duplicate"
            ? {
                ...relationship,
                status: "ambiguous" as const,
                targetNodeIds: duplicateTargets,
              }
            : relationship,
        ),
      },
      { generationId, sourceDigests, workspaceId },
    );
    expect(
      ambiguousGraph.edges.some(
        (edge) => edge.resolutionStatus === "ambiguous",
      ),
    ).toBe(true);
    expect(ambiguousGraph.nodes.some((node) => node.kind === "concept")).toBe(
      true,
    );
    expect(
      graph.evidence.every((item) => item.extractionMethod === "resolver"),
    ).toBe(true);
  });

  test("fails closed when resolver relationships lose evidence integrity", () => {
    const facts = parseSource({
      languageId: "typescript",
      source: "unknown();",
    });
    const sources = [{ facts, kind: "code" as const, path: "src/broken.ts" }];
    const sourceDigests = contentDigests(sources);
    const resolution = materializeResolutionInput({
      environmentFingerprint: HASH,
      repositoryId: createIdentity("repository", { root: "/broken" }),
      resolverFingerprint: HASH,
      revisionId: createIdentity("revision", { commit: "broken" }),
      sources,
    });
    expect(() =>
      graphFromResolution(
        {
          ...resolution,
          evidence: [],
          memberships: resolution.memberships.filter(
            (membership) => membership.entityKind !== "evidence",
          ),
        },
        {
          generationId: createIdentity("generation", { broken: true }),
          sourceDigests,
          workspaceId: createIdentity("workspace", { broken: true }),
        },
      ),
    ).toThrow("invalid_resolution_relationship_reference");
    const evidence = resolution.evidence.at(0);
    if (!evidence) throw new Error("expected resolution evidence");
    expect(() =>
      graphFromResolution(
        {
          ...resolution,
          evidence: resolution.evidence.map((item) =>
            item.id === evidence.id
              ? { ...item, occurrenceId: "missing-occurrence" }
              : item,
          ),
        },
        {
          generationId: createIdentity("generation", { missing: true }),
          sourceDigests,
          workspaceId: createIdentity("workspace", { missing: true }),
        },
      ),
    ).toThrow("invalid_resolution_evidence_occurrence");

    expect(() =>
      graphFromResolution(resolution, {
        generationId: createIdentity("generation", { mismatch: true }),
        sourceDigests: {
          [facts.sourceArtifactId]: "f".repeat(64),
        },
        workspaceId: createIdentity("workspace", { mismatch: true }),
      }),
    ).toThrow("source_artifact_content_mismatch");
    expect(() =>
      graphFromResolution(resolution, {
        generationId: createIdentity("generation", { missingDigest: true }),
        sourceDigests: {},
        workspaceId: createIdentity("workspace", { missingDigest: true }),
      }),
    ).toThrow("resolution_source_digest_set_mismatch");

    const membership = resolution.memberships.at(0);
    if (!membership) throw new Error("expected resolution membership");
    expect(() =>
      graphFromResolution(
        {
          ...resolution,
          memberships: [
            {
              ...membership,
              revisionId: createIdentity("revision", { foreign: true }),
            },
            ...resolution.memberships.slice(1),
          ],
        },
        {
          generationId: createIdentity("generation", { foreign: true }),
          sourceDigests,
          workspaceId: createIdentity("workspace", { foreign: true }),
        },
      ),
    ).toThrow("invalid_resolution_membership");

    const legacySourceArtifactId = Bun.SHA256.hash(
      JSON.stringify(["source", facts.sourceDigest]),
      "hex",
    );
    const legacyResolution = materializeResolutionInput({
      environmentFingerprint: HASH,
      repositoryId: createIdentity("repository", { root: "/legacy" }),
      resolverFingerprint: HASH,
      revisionId: createIdentity("revision", { commit: "legacy" }),
      sources: [
        {
          facts: { ...facts, sourceArtifactId: legacySourceArtifactId },
          kind: "code",
          path: "src/legacy.ts",
        },
      ],
    });
    const legacyGraph = graphFromResolution(legacyResolution, {
      generationId: createIdentity("generation", { legacy: true }),
      sourceDigests: { [legacySourceArtifactId]: facts.sourceDigest },
      workspaceId: createIdentity("workspace", { legacy: true }),
    });
    expect(
      legacyGraph.nodes.some(
        (node) => node.contentFingerprint === facts.sourceDigest,
      ),
    ).toBe(true);
  });

  test("preserves document and project hierarchy through conversion and traversal", () => {
    const repositoryId = createIdentity("repository", { root: "/hierarchy" });
    const revisionId = createIdentity("revision", { commit: "hierarchy" });
    const workspaceId = createIdentity("workspace", { checkout: "/hierarchy" });
    const generationId = createIdentity("generation", { revisionId });
    const docDigest = "1".repeat(64);
    const projectDigest = "2".repeat(64);
    const docArtifact = sourceArtifactIdentity({ contentDigest: docDigest });
    const projectArtifact = sourceArtifactIdentity({
      contentDigest: projectDigest,
    });
    const range = (startByte: number, endByte: number) => ({
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
    const docParentId = "3".repeat(64);
    const docChildId = "4".repeat(64);
    const projectParentId = "5".repeat(64);
    const projectChildId = "6".repeat(64);
    const sources = [
      {
        facts: {
          artifactId: docArtifact,
          nodes: [
            {
              id: docChildId,
              name: "API",
              nodeKind: "section" as const,
              parentId: docParentId,
              range: range(6, 9),
            },
            {
              id: "7".repeat(64),
              name: "API",
              nodeKind: "section" as const,
              parentId: null,
              range: range(10, 13),
            },
            {
              id: docParentId,
              name: "Guide",
              nodeKind: "document" as const,
              parentId: null,
              range: range(0, 5),
            },
          ],
          relationships: [],
          sourceDigest: docDigest,
        },
        kind: "document" as const,
        path: "docs/guide.md",
      },
      {
        facts: {
          diagnostics: [],
          format: "dotnet-project" as const,
          nodes: [
            {
              attributes: {},
              childIds: [],
              id: projectChildId,
              kind: "package" as const,
              name: "App",
              parentId: projectParentId,
              range: range(4, 7),
            },
            {
              attributes: {},
              childIds: [projectChildId],
              id: projectParentId,
              kind: "project" as const,
              name: "App",
              parentId: null,
              range: range(0, 3),
            },
          ],
          parserFingerprint: "8".repeat(64),
          partial: false,
          relationships: [],
          rewriteSupported: false as const,
          schemaVersion: "ast-mcp.project-facts.v1" as const,
          sourceArtifactId: projectArtifact,
          sourceByteLength: 8,
          sourceDigest: projectDigest,
          syntaxFactsArtifactId: "9".repeat(64),
        },
        kind: "project" as const,
        path: "app.csproj",
      },
    ];
    const resolution = materializeResolutionInput({
      environmentFingerprint: HASH,
      repositoryId,
      resolverFingerprint: HASH,
      revisionId,
      sources,
    });
    const hierarchy = resolution.relationships.filter(
      (relationship) => relationship.kind === "containment",
    );
    expect(hierarchy).toHaveLength(2);
    expect(
      resolution.evidence.filter((evidence) => evidence.basis === "hierarchy"),
    ).toHaveLength(2);

    const coordinates = {
      generationId,
      sourceDigests: {
        [docArtifact]: docDigest,
        [projectArtifact]: projectDigest,
      },
      workspaceId,
    };
    const graph = graphFromResolution(resolution, coordinates);
    const byResolutionId = (id: string) =>
      graph.nodes.find((node) =>
        node.properties.some(
          (property) =>
            property.key === "resolutionNodeId" && property.value === id,
        ),
      );
    const guide = byResolutionId(
      resolution.nodes.find((node) => node.name === "Guide")?.id ?? "",
    );
    const api = byResolutionId(
      resolution.nodes.find(
        (node) => node.name === "API" && node.parentNodeId !== null,
      )?.id ?? "",
    );
    const project = byResolutionId(
      resolution.nodes.find((node) => node.kind === "project")?.id ?? "",
    );
    const projectChild = byResolutionId(
      resolution.nodes.find((node) => node.kind === "package")?.id ?? "",
    );
    if (!guide || !api || !project || !projectChild)
      throw new Error("expected converted hierarchy nodes");
    const hierarchyEdges = graph.edges.filter(
      (edge) =>
        edge.kind === "contains" &&
        ((edge.sourceNodeId === guide.nodeId &&
          edge.targetNodeId === api.nodeId) ||
          (edge.sourceNodeId === project.nodeId &&
            edge.targetNodeId === projectChild.nodeId)),
    );
    expect(hierarchyEdges).toHaveLength(2);
    expect(
      hierarchyEdges.every((edge) =>
        graph.evidence.some(
          (evidence) =>
            evidence.edgeId === edge.edgeId &&
            evidence.extractionMethod === "resolver",
        ),
      ),
    ).toBe(true);
    expect(
      graph.nodes.filter((node) =>
        node.properties.some(
          (property) => property.key === "name" && property.value === "API",
        ),
      ),
    ).toHaveLength(2);

    const algorithmSnapshot = {
      generationId,
      memberships: graph.memberships,
      nodes: graph.nodes,
      relationships: graph.edges.map((edge) => {
        const evidence = graph.evidence.filter(
          (item) => item.edgeId === edge.edgeId,
        );
        const occurrenceIds = new Set(
          evidence.map((item) => item.occurrenceId),
        );
        return {
          edge,
          evidence,
          occurrences: graph.occurrences.filter((occurrence) =>
            occurrenceIds.has(occurrence.occurrenceId),
          ),
        };
      }),
      revisionId,
    };
    for (const [parent, child] of [
      [guide, api],
      [project, projectChild],
    ]) {
      const traversed = traverseGraph({
        budget: {
          maxBytes: 1_000_000,
          maxDepth: 2,
          maxEdges: 100,
          maxMilliseconds: 10_000,
          maxNodes: 100,
          pageSize: 100,
        },
        direction: "forward",
        snapshot: algorithmSnapshot,
        startNodeIds: [parent.nodeId],
      });
      expect(traversed.nodes.map((node) => node.nodeId)).toContain(
        child.nodeId,
      );
    }

    const containment = hierarchy[0];
    const hierarchyEvidenceId = containment?.evidenceIds[0];
    if (!containment || !hierarchyEvidenceId)
      throw new Error("expected containment evidence");
    expect(() =>
      graphFromResolution(
        {
          ...resolution,
          evidence: resolution.evidence.map((evidence) =>
            evidence.id === hierarchyEvidenceId
              ? { ...evidence, basis: "name-only" as const }
              : evidence,
          ),
        },
        coordinates,
      ),
    ).toThrow("invalid_resolution_containment");
  });

  test("rejects malformed resolver graphs before graph conversion", () => {
    const facts = parseSource({
      languageId: "typescript",
      source: "export function target() {} target();",
    });
    const sources = [{ facts, kind: "code" as const, path: "src/strict.ts" }];
    const resolution = materializeResolutionInput({
      environmentFingerprint: HASH,
      repositoryId: createIdentity("repository", { root: "/strict" }),
      resolverFingerprint: HASH,
      revisionId: createIdentity("revision", { commit: "strict" }),
      sources,
    });
    const coordinates = {
      generationId: createIdentity("generation", { strict: true }),
      sourceDigests: contentDigests(sources),
      workspaceId: createIdentity("workspace", { strict: true }),
    };
    const convert = (value: unknown) =>
      graphFromResolution(value as typeof resolution, coordinates);

    expect(() => convert({ ...resolution, unexpected: true })).toThrow();
    expect(() =>
      convert({
        ...resolution,
        memberships: resolution.memberships.slice(1),
      }),
    ).toThrow("incomplete_resolution_membership");

    const membership = resolution.memberships.at(0);
    if (!membership) throw new Error("expected membership");
    expect(() =>
      convert({
        ...resolution,
        memberships: [
          { ...membership, id: createIdentity("membership", ["tampered"]) },
          ...resolution.memberships.slice(1),
        ],
      }),
    ).toThrow("invalid_resolution_membership");

    const resolved = resolution.relationships.find(
      (relationship) => relationship.targetNodeIds.length === 1,
    );
    if (!resolved) throw new Error("expected resolved relationship");
    expect(() =>
      convert({
        ...resolution,
        relationships: resolution.relationships.map((relationship) =>
          relationship.id === resolved.id
            ? { ...relationship, status: "unresolved" as const }
            : relationship,
        ),
      }),
    ).toThrow("invalid_resolution_status_cardinality");
    expect(() =>
      convert({
        ...resolution,
        relationships: resolution.relationships.map((relationship) =>
          relationship.id === resolved.id
            ? {
                ...relationship,
                status: "ambiguous" as const,
                targetNodeIds: [
                  resolved.targetNodeIds[0],
                  resolved.targetNodeIds[0],
                ],
              }
            : relationship,
        ),
      }),
    ).toThrow("invalid_resolution_relationship_reference");

    const node = resolution.nodes.at(0);
    const otherOccurrence = resolution.occurrences.find(
      (occurrence) => occurrence.id !== node?.occurrenceId,
    );
    if (!node || !otherOccurrence)
      throw new Error("expected independent occurrence");
    expect(() =>
      convert({
        ...resolution,
        nodes: resolution.nodes.map((item) =>
          item.id === node.id
            ? { ...item, occurrenceId: otherOccurrence.id }
            : item,
        ),
      }),
    ).toThrow("invalid_resolution_node_occurrence");

    expect(() =>
      convert({
        ...resolution,
        sourceArtifacts: [
          ...resolution.sourceArtifacts,
          resolution.sourceArtifacts[0],
        ],
      }),
    ).toThrow("duplicate_resolution_source_artifact");
  });
});

describe("accepted intelligence manifest registry", () => {
  test("freezes deterministic accepted manifests without duplicate providers", () => {
    expect(acceptedIntelligenceManifestRegistry.entries.length).toBeGreaterThan(
      30,
    );
    expect(acceptedIntelligenceManifestRegistry.fingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(Object.isFrozen(acceptedIntelligenceManifestRegistry)).toBe(true);
    expect(
      acceptedIntelligenceManifestRegistry.entries.some(
        (entry) => entry.id === "language:typescript",
      ),
    ).toBe(true);
    expect(
      acceptedIntelligenceManifestRegistry.entries.some(
        (entry) => entry.id === "document:markdown",
      ),
    ).toBe(true);
    expect(
      acceptedIntelligenceManifestRegistry.entries.some(
        (entry) => entry.id === "project:dotnet-project",
      ),
    ).toBe(true);
  });

  test("rejects invalid fingerprints, extensions, and duplicate identities", () => {
    const capability = {} as Readonly<Record<string, unknown>>;
    expect(() =>
      createIntelligenceManifestRegistry([
        {
          adapters: [
            {
              capability,
              extensions: [".x"],
              languageId: "x",
            },
          ],
          groupId: "bad",
          implementationFingerprint: "bad",
        },
      ]),
    ).toThrow("invalid_manifest_fingerprint");
    expect(() =>
      createIntelligenceManifestRegistry([
        {
          adapters: [{ capability, extensions: [""], languageId: "x" }],
          groupId: "empty",
          implementationFingerprint: HASH,
        },
      ]),
    ).toThrow("invalid_manifest_extensions");
    expect(() =>
      createIntelligenceManifestRegistry([
        {
          adapters: [
            { capability, extensions: [".x"], languageId: "x" },
            { capability, extensions: [".x"], languageId: "x" },
          ],
          groupId: "duplicate",
          implementationFingerprint: HASH,
        },
      ]),
    ).toThrow("duplicate_manifest_id");
  });
});

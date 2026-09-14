import { createHash } from "node:crypto";
import { sourceArtifactIdentity } from "../contracts/artifacts.ts";
import {
  GraphEdgeSchema,
  GraphEvidenceSchema,
  GraphNodeSchema,
  GraphOccurrenceSchema,
  graphEdgeIdentity,
  graphEvidenceIdentity,
  graphNodeIdentity,
  graphOccurrenceIdentity,
} from "../contracts/graph.ts";
import type {
  MaterializedNode,
  MaterializedOccurrence,
  GraphMaterializationInput as ResolutionGraph,
} from "../resolution/types.ts";
import { parseResolutionGraphMaterialization } from "./resolution-schema.ts";
import { createGraphMemberships } from "./shared.ts";
import type {
  GraphEdge,
  GraphEvidence,
  GraphNode,
  GraphOccurrence,
  GraphScope,
  GraphSnapshot,
} from "./types.ts";
import { GraphScopeSchema, GraphSnapshotSchema } from "./types.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceArtifactMatchesDigest(
  sourceArtifactId: string,
  sourceDigest: string,
): boolean {
  return (
    sourceArtifactId ===
      sourceArtifactIdentity({ contentDigest: sourceDigest }) ||
    sourceArtifactId === sha256(JSON.stringify(["source", sourceDigest]))
  );
}

export interface ResolutionGraphCoordinates {
  generationId: string;
  sourceDigests: Readonly<Record<string, string>>;
  workspaceId: string;
}

function validatedSourceDigests(
  input: ResolutionGraph,
  coordinates: ResolutionGraphCoordinates,
): ReadonlyMap<string, string> {
  const artifacts = [...new Set(input.sourceArtifacts)].sort();
  if (artifacts.length !== input.sourceArtifacts.length)
    throw new Error("duplicate_resolution_source_artifact");
  const entries = Object.entries(coordinates.sourceDigests).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  if (
    entries.length !== artifacts.length ||
    entries.some(([artifactId], index) => artifactId !== artifacts[index])
  ) {
    throw new Error("resolution_source_digest_set_mismatch");
  }
  const digests = new Map<string, string>();
  for (const [artifactId, digest] of entries) {
    if (
      !/^[a-f0-9]{64}$/.test(digest) ||
      !sourceArtifactMatchesDigest(artifactId, digest)
    ) {
      throw new Error("source_artifact_content_mismatch");
    }
    digests.set(artifactId, digest);
    digests.set(sourceArtifactIdentity({ contentDigest: digest }), digest);
  }
  for (const item of [...input.nodes, ...input.occurrences])
    if (!digests.has(item.sourceArtifactId))
      throw new Error("unknown_resolution_source_artifact");

  const entities = {
    evidence: new Set(input.evidence.map((item) => item.id)),
    node: new Set(input.nodes.map((item) => item.id)),
    occurrence: new Set(input.occurrences.map((item) => item.id)),
    relationship: new Set(input.relationships.map((item) => item.id)),
  };
  const membershipIds = new Set<string>();
  for (const membership of input.memberships) {
    if (
      membershipIds.has(membership.id) ||
      membership.repositoryId !== input.repositoryId ||
      membership.revisionId !== input.revisionId ||
      !digests.has(membership.sourceArtifactId) ||
      !entities[membership.entityKind].has(membership.entityId)
    ) {
      throw new Error("invalid_resolution_membership");
    }
    membershipIds.add(membership.id);
  }
  return digests;
}

function nodeKind(kind: MaterializedNode["kind"]): GraphNode["kind"] {
  return {
    component: "module",
    document: "document",
    external: "external-reference",
    package: "package",
    project: "module",
    resource: "external-reference",
    section: "section",
    symbol: "variable",
  }[kind] as GraphNode["kind"];
}

function role(value: MaterializedOccurrence["role"]): GraphOccurrence["role"] {
  if (value === "import" || value === "export" || value === "call")
    return value;
  if (value === "declaration") return "declaration";
  return "reference";
}

function edgeKind(
  value: ResolutionGraph["relationships"][number]["kind"],
): GraphEdge["kind"] {
  return {
    call: "calls",
    containment: "contains",
    dependency: "depends-on",
    "document-link": "links",
    export: "exports",
    implementation: "implements",
    import: "imports",
    inheritance: "inherits",
    reference: "references",
    resource: "contains",
    "type-reference": "references",
  }[value] as GraphEdge["kind"];
}

export function graphFromResolution(
  inputValue: ResolutionGraph,
  coordinates: ResolutionGraphCoordinates,
): GraphSnapshot {
  const input = parseResolutionGraphMaterialization(inputValue);
  const sourceDigests = validatedSourceDigests(input, coordinates);
  const sourceDigestFor = (sourceArtifactId: string): string => {
    const digest = sourceDigests.get(sourceArtifactId);
    if (!digest) throw new Error("unknown_resolution_source_artifact");
    return digest;
  };
  const graphSourceArtifactFor = (sourceArtifactId: string): string =>
    sourceArtifactIdentity({
      contentDigest: sourceDigestFor(sourceArtifactId),
    });
  const scope = GraphScopeSchema.parse({
    generationId: coordinates.generationId,
    repositoryId: input.repositoryId,
    revisionId: input.revisionId,
    workspaceId: coordinates.workspaceId,
  } satisfies GraphScope);
  const nodes = new Map<string, GraphNode>();
  const files = new Map<string, GraphNode>();
  const fileArtifacts = new Map<string, string>();
  const nodeIds = new Map<string, string>();
  const occurrences = new Map<string, GraphOccurrence>();
  const occurrenceIds = new Map<string, string>();
  const edges: GraphEdge[] = [];
  const evidence: GraphEvidence[] = [];

  const addNode = (
    canonicalName: string,
    kind: GraphNode["kind"],
    fingerprint: string,
    properties: GraphNode["properties"] = [],
  ) => {
    const node = GraphNodeSchema.parse({
      canonicalName,
      contentFingerprint: fingerprint,
      kind,
      nodeId: graphNodeIdentity({ canonicalName, kind }),
      properties,
    });
    nodes.set(node.nodeId, node);
    return node;
  };
  const fileFor = (path: string, artifactId: string) => {
    const existing = files.get(path);
    if (existing) {
      if (fileArtifacts.get(path) !== artifactId)
        throw new Error("resolution_path_content_conflict");
      return existing;
    }
    const file = addNode(
      `repository:${input.repositoryId}:file:${path}`,
      "file",
      sourceDigestFor(artifactId),
      [{ key: "path", value: path }],
    );
    files.set(path, file);
    fileArtifacts.set(path, artifactId);
    return file;
  };
  const repository = addNode(
    `repository:${input.repositoryId}`,
    "repository",
    sha256(input.repositoryId),
  );
  const addObservedEdge = (
    sourceNodeId: string,
    targetNodeId: string,
    kind: GraphEdge["kind"],
    discriminator: string,
    occurrence: GraphOccurrence,
    status: GraphEdge["resolutionStatus"] = "explicit",
  ) => {
    const contentFingerprint = sourceDigestFor(occurrence.sourceArtifactId);
    const edgeDiscriminator = [
      discriminator,
      contentFingerprint,
      input.environmentFingerprint,
    ].join(":");
    const edge = GraphEdgeSchema.parse({
      contentFingerprint,
      direction: "directed",
      discriminator: edgeDiscriminator,
      edgeId: graphEdgeIdentity({
        discriminator: edgeDiscriminator,
        kind,
        sourceNodeId,
        targetNodeId,
      }),
      environmentFingerprint: input.environmentFingerprint,
      kind,
      properties: [],
      resolutionStatus: status,
      sourceNodeId,
      targetNodeId,
    });
    edges.push(edge);
    evidence.push(
      GraphEvidenceSchema.parse({
        confidence:
          status === "ambiguous" ? 0.5 : status === "unresolved" ? 0 : 1,
        edgeId: edge.edgeId,
        evidenceId: graphEvidenceIdentity({
          edgeId: edge.edgeId,
          extractionMethod: "resolver",
          extractionVersion: "wp08-resolution-v1",
          extractorFingerprint: input.resolverFingerprint,
          occurrenceId: occurrence.occurrenceId,
          path: occurrence.path,
          range: occurrence.range,
          sourceArtifactId: occurrence.sourceArtifactId,
        }),
        extractionMethod: "resolver",
        extractionVersion: "wp08-resolution-v1",
        extractorFingerprint: input.resolverFingerprint,
        occurrenceId: occurrence.occurrenceId,
        path: occurrence.path,
        range: occurrence.range,
        sourceArtifactId: occurrence.sourceArtifactId,
      }),
    );
  };

  for (const item of input.nodes) {
    const node = addNode(
      `resolved:${input.repositoryId}:${item.path}:${item.id}`,
      nodeKind(item.kind),
      sourceDigestFor(item.sourceArtifactId),
      [
        { key: "name", value: item.name },
        { key: "parentResolutionNodeId", value: item.parentNodeId },
        { key: "qualifiedName", value: item.qualifiedName },
        { key: "resolutionNodeId", value: item.id },
      ],
    );
    nodeIds.set(item.id, node.nodeId);
    fileFor(item.path, item.sourceArtifactId);
  }
  for (const item of input.occurrences)
    fileFor(item.path, item.sourceArtifactId);

  const relationshipForOccurrence = new Map<
    string,
    ResolutionGraph["relationships"][number]
  >();
  for (const relationship of input.relationships)
    for (const evidenceId of relationship.evidenceIds) {
      const record = input.evidence.find((item) => item.id === evidenceId);
      if (record)
        relationshipForOccurrence.set(record.occurrenceId, relationship);
    }

  for (const item of input.occurrences) {
    const declaration = input.nodes.find(
      (node) => node.occurrenceId === item.id,
    );
    const relationship = relationshipForOccurrence.get(item.id);
    const owner =
      (declaration && nodeIds.get(declaration.id)) ||
      (relationship?.sourceNodeId && nodeIds.get(relationship.sourceNodeId)) ||
      fileFor(item.path, item.sourceArtifactId).nodeId;
    const occurrence = GraphOccurrenceSchema.parse({
      nodeId: owner,
      occurrenceId: graphOccurrenceIdentity({
        nodeId: owner,
        path: item.path,
        range: item.range,
        role: role(item.role),
        sourceArtifactId: graphSourceArtifactFor(item.sourceArtifactId),
      }),
      path: item.path,
      range: item.range,
      role: role(item.role),
      sourceArtifactId: graphSourceArtifactFor(item.sourceArtifactId),
    });
    occurrences.set(occurrence.occurrenceId, occurrence);
    occurrenceIds.set(item.id, occurrence.occurrenceId);
  }

  for (const [path, file] of [...files].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const source = input.occurrences.find((item) => item.path === path);
    if (!source) continue;
    const occurrence = GraphOccurrenceSchema.parse({
      nodeId: file.nodeId,
      occurrenceId: graphOccurrenceIdentity({
        nodeId: file.nodeId,
        path,
        range: source.range,
        role: "containment",
        sourceArtifactId: graphSourceArtifactFor(source.sourceArtifactId),
      }),
      path,
      range: source.range,
      role: "containment",
      sourceArtifactId: graphSourceArtifactFor(source.sourceArtifactId),
    });
    occurrences.set(occurrence.occurrenceId, occurrence);
    addObservedEdge(
      repository.nodeId,
      file.nodeId,
      "contains",
      `repository-file:${path}`,
      occurrence,
    );
  }
  for (const item of input.nodes) {
    const targetNodeId = nodeIds.get(item.id);
    const graphOccurrenceId = occurrenceIds.get(item.occurrenceId);
    const occurrence = graphOccurrenceId && occurrences.get(graphOccurrenceId);
    if (!targetNodeId || !occurrence)
      throw new Error("resolution_declaration_without_occurrence");
    addObservedEdge(
      fileFor(item.path, item.sourceArtifactId).nodeId,
      targetNodeId,
      item.kind === "document" || item.kind === "section"
        ? "contains"
        : "declares",
      `resolution-declaration:${item.id}`,
      occurrence,
    );
  }

  for (const item of input.relationships) {
    const firstEvidence = input.evidence.find((record) =>
      item.evidenceIds.includes(record.id),
    );
    if (!firstEvidence)
      throw new Error("resolution_relationship_without_evidence");
    const occurrence = occurrences.get(
      occurrenceIds.get(firstEvidence.occurrenceId) ?? "",
    );
    if (!occurrence) throw new Error("resolution_evidence_without_occurrence");
    const sourceNodeId =
      (item.sourceNodeId && nodeIds.get(item.sourceNodeId)) ??
      occurrence.nodeId;
    let targetNodeId: string;
    const mappedTargets = item.targetNodeIds
      .map((id) => nodeIds.get(id))
      .filter((id): id is string => Boolean(id))
      .sort();
    if (item.status === "resolved" && mappedTargets.length === 1) {
      const onlyTarget = mappedTargets.at(0);
      if (!onlyTarget) throw new Error("resolution_target_missing");
      targetNodeId = onlyTarget;
    } else if (item.status === "ambiguous") {
      targetNodeId = addNode(
        `ambiguous:${input.repositoryId}:${item.id}`,
        "concept",
        sha256(item.id),
        [
          { key: "target", value: item.target },
          { key: "candidateNodeIds", value: mappedTargets },
        ],
      ).nodeId;
    } else {
      targetNodeId = addNode(
        `external:${item.target}`,
        "external-reference",
        sha256(item.target),
        [{ key: "target", value: item.target }],
      ).nodeId;
    }
    const contentFingerprint = sourceDigestFor(occurrence.sourceArtifactId);
    const discriminator = [
      `resolution:${item.id}`,
      contentFingerprint,
      input.environmentFingerprint,
    ].join(":");
    const kind = edgeKind(item.kind);
    const edge = GraphEdgeSchema.parse({
      contentFingerprint,
      direction: "directed",
      discriminator,
      edgeId: graphEdgeIdentity({
        discriminator,
        kind,
        sourceNodeId,
        targetNodeId,
      }),
      environmentFingerprint: input.environmentFingerprint,
      kind,
      properties: [
        { key: "target", value: item.target },
        { key: "candidateNodeIds", value: mappedTargets },
      ],
      resolutionStatus: item.status,
      sourceNodeId,
      targetNodeId,
    });
    edges.push(edge);
    for (const sourceEvidence of input.evidence.filter((record) =>
      item.evidenceIds.includes(record.id),
    )) {
      const graphOccurrenceId = occurrenceIds.get(sourceEvidence.occurrenceId);
      const graphOccurrence =
        graphOccurrenceId && occurrences.get(graphOccurrenceId);
      if (!graphOccurrence)
        throw new Error("resolution_evidence_without_occurrence");
      evidence.push(
        GraphEvidenceSchema.parse({
          confidence:
            item.status === "resolved"
              ? 1
              : item.status === "ambiguous"
                ? 0.5
                : 0,
          edgeId: edge.edgeId,
          evidenceId: graphEvidenceIdentity({
            edgeId: edge.edgeId,
            extractionMethod: "resolver",
            extractionVersion: "wp08-resolution-v1",
            extractorFingerprint: input.resolverFingerprint,
            occurrenceId: graphOccurrence.occurrenceId,
            path: graphOccurrence.path,
            range: graphOccurrence.range,
            sourceArtifactId: graphOccurrence.sourceArtifactId,
          }),
          extractionMethod: "resolver",
          extractionVersion: "wp08-resolution-v1",
          extractorFingerprint: input.resolverFingerprint,
          occurrenceId: graphOccurrence.occurrenceId,
          path: graphOccurrence.path,
          range: graphOccurrence.range,
          sourceArtifactId: graphOccurrence.sourceArtifactId,
        }),
      );
    }
  }

  const allEvidence = evidence.sort((a, b) =>
    a.evidenceId.localeCompare(b.evidenceId),
  );
  const allEdges = edges.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  const memberships = createGraphMemberships(scope, {
    edges: allEdges.map((item) => item.edgeId),
    evidence: allEvidence.map((item) => item.evidenceId),
    nodes: nodes.keys(),
    occurrences: occurrences.keys(),
  });
  return GraphSnapshotSchema.parse({
    edges: allEdges,
    evidence: allEvidence,
    memberships: memberships.sort((a, b) =>
      a.membershipId.localeCompare(b.membershipId),
    ),
    nodes: [...nodes.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    occurrences: [...occurrences.values()].sort((a, b) =>
      a.occurrenceId.localeCompare(b.occurrenceId),
    ),
    scope,
  });
}

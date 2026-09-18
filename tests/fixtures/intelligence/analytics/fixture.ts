import { createHash } from "node:crypto";

import { createIdentity } from "../../../../src/intelligence/contracts/common.ts";
import {
  graphEdgeIdentity,
  graphEvidenceIdentity,
  graphNodeIdentity,
  graphOccurrenceIdentity,
  revisionMembershipIdentity,
} from "../../../../src/intelligence/contracts/graph.ts";
import { GraphSnapshotSchema } from "../../../../src/intelligence/graph/types.ts";

type Status = "ambiguous" | "explicit" | "inferred" | "resolved" | "unresolved";
type Kind =
  | "calls"
  | "contains"
  | "declares"
  | "depends-on"
  | "documents"
  | "exports"
  | "implements"
  | "imports"
  | "inherits"
  | "links"
  | "overrides"
  | "reads"
  | "references"
  | "writes";

export interface AnalyticsEdgeFixture {
  confidence?: number;
  confidences?: readonly number[];
  discriminator?: string;
  kind?: Kind;
  source: string;
  status?: Status;
  target: string;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing analytics fixture value");
  return value;
}

export function analyticsFixture(
  names: readonly string[],
  edgeSpecs: readonly AnalyticsEdgeFixture[],
  revision = "analytics",
) {
  const repositoryId = createIdentity("repository", { root: "/analytics" });
  const revisionId = createIdentity("revision", { revision });
  const workspaceId = createIdentity("workspace", {
    revision,
    root: "/analytics",
  });
  const generationId = createIdentity("generation", { revision });
  const scope = { generationId, repositoryId, revisionId, workspaceId };
  const nodes = names.map((name) => {
    const canonicalName = `project.${name}`;
    const kind = name.startsWith("doc") ? "document" : "function";
    return {
      canonicalName,
      contentFingerprint: sha(`node:${name}`),
      kind,
      nodeId: graphNodeIdentity({ canonicalName, kind }),
      properties: [{ key: "name", value: name }],
    } as const;
  });
  const nodeByName = new Map(
    names.map((name, index) => [name, required(nodes[index])]),
  );
  const occurrences = nodes.map((node, index) => {
    const range = {
      end: { column: 1, line: index },
      endByte: index + 1,
      start: { column: 0, line: index },
      startByte: index,
    };
    const sourceArtifactId = createIdentity("source", { nodeId: node.nodeId });
    return {
      nodeId: node.nodeId,
      occurrenceId: graphOccurrenceIdentity({
        nodeId: node.nodeId,
        path: `src/${names[index]}.ts`,
        range,
        role: "declaration",
        sourceArtifactId,
      }),
      path: `src/${names[index]}.ts`,
      range,
      role: "declaration" as const,
      sourceArtifactId,
    };
  });
  const occurrenceByNode = new Map(
    occurrences.map((occurrence) => [occurrence.nodeId, occurrence]),
  );
  const edges = edgeSpecs.map((spec, index) => {
    const sourceNodeId = required(nodeByName.get(spec.source)).nodeId;
    const targetNodeId = required(nodeByName.get(spec.target)).nodeId;
    const kind = spec.kind ?? "calls";
    const discriminator = spec.discriminator ?? `${kind}:${index}`;
    return {
      contentFingerprint: sha(
        `edge:${index}:${(spec.confidences ?? [spec.confidence ?? 1]).join(",")}`,
      ),
      direction: "directed" as const,
      discriminator,
      edgeId: graphEdgeIdentity({
        discriminator,
        kind,
        sourceNodeId,
        targetNodeId,
      }),
      environmentFingerprint: sha("environment"),
      kind,
      properties: [],
      resolutionStatus: spec.status ?? "resolved",
      sourceNodeId,
      targetNodeId,
    };
  });
  const evidence = edges.flatMap((edge, index) => {
    const occurrence = required(occurrenceByNode.get(edge.sourceNodeId));
    const spec = required(edgeSpecs[index]);
    return (spec.confidences ?? [spec.confidence ?? 1]).map(
      (confidence, evidenceIndex) => {
        const base = {
          edgeId: edge.edgeId,
          extractionMethod: "ast" as const,
          extractionVersion: `wp09-fixture-v1:${evidenceIndex}`,
          extractorFingerprint: sha("wp09-fixture"),
          occurrenceId: occurrence.occurrenceId,
          path: occurrence.path,
          range: occurrence.range,
          sourceArtifactId: occurrence.sourceArtifactId,
        };
        return {
          ...base,
          confidence,
          evidenceId: graphEvidenceIdentity(base),
        };
      },
    );
  });
  const entities = [
    ...nodes.map((item) => ({
      entityId: item.nodeId,
      entityKind: "node" as const,
    })),
    ...occurrences.map((item) => ({
      entityId: item.occurrenceId,
      entityKind: "occurrence" as const,
    })),
    ...edges.map((item) => ({
      entityId: item.edgeId,
      entityKind: "edge" as const,
    })),
    ...evidence.map((item) => ({
      entityId: item.evidenceId,
      entityKind: "evidence" as const,
    })),
  ];
  const memberships = entities.map((entity) => ({
    ...entity,
    generationId,
    membershipId: revisionMembershipIdentity({
      ...entity,
      generationId,
      revisionId,
    }),
    revisionId,
  }));
  return GraphSnapshotSchema.parse({
    edges,
    evidence,
    memberships,
    nodes,
    occurrences,
    scope,
  });
}

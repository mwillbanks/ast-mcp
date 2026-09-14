import { z } from "zod";
import {
  GenerationIdSchema,
  RepositoryIdSchema,
  RevisionIdSchema,
  WorkspaceIdSchema,
} from "../contracts/common.ts";
import {
  GraphEdgeSchema,
  GraphEvidenceSchema,
  GraphNodeSchema,
  GraphOccurrenceSchema,
  RevisionMembershipSchema,
} from "../contracts/graph.ts";

export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphOccurrence = z.infer<typeof GraphOccurrenceSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type GraphEvidence = z.infer<typeof GraphEvidenceSchema>;
export type RevisionMembership = z.infer<typeof RevisionMembershipSchema>;

export const GraphScopeSchema = z
  .object({
    generationId: GenerationIdSchema,
    repositoryId: RepositoryIdSchema,
    revisionId: RevisionIdSchema,
    workspaceId: WorkspaceIdSchema,
  })
  .strict();
export type GraphScope = z.infer<typeof GraphScopeSchema>;

export const GraphSnapshotSchema = z
  .object({
    edges: z.array(GraphEdgeSchema),
    evidence: z.array(GraphEvidenceSchema),
    memberships: z.array(RevisionMembershipSchema),
    nodes: z.array(GraphNodeSchema),
    occurrences: z.array(GraphOccurrenceSchema),
    scope: GraphScopeSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const nodes = new Set(snapshot.nodes.map((node) => node.nodeId));
    const occurrences = new Map(
      snapshot.occurrences.map((occurrence) => [
        occurrence.occurrenceId,
        occurrence,
      ]),
    );
    const edges = new Set(snapshot.edges.map((edge) => edge.edgeId));
    const evidence = new Set(snapshot.evidence.map((item) => item.evidenceId));
    const duplicate = <T>(values: readonly T[]) =>
      values.find((value, index) => values.indexOf(value) !== index);
    const duplicateIds = [
      duplicate(snapshot.nodes.map((item) => item.nodeId)),
      duplicate(snapshot.occurrences.map((item) => item.occurrenceId)),
      duplicate(snapshot.edges.map((item) => item.edgeId)),
      duplicate(snapshot.evidence.map((item) => item.evidenceId)),
      duplicate(snapshot.memberships.map((item) => item.membershipId)),
    ].filter(Boolean);
    if (duplicateIds.length) {
      context.addIssue({
        code: "custom",
        message: `Graph snapshot contains duplicate identities: ${duplicateIds.join(", ")}`,
      });
    }
    snapshot.occurrences.forEach((occurrence, index) => {
      if (!nodes.has(occurrence.nodeId)) {
        context.addIssue({
          code: "custom",
          message: "Occurrence references an unknown node",
          path: ["occurrences", index, "nodeId"],
        });
      }
    });
    snapshot.edges.forEach((edge, index) => {
      if (!nodes.has(edge.sourceNodeId) || !nodes.has(edge.targetNodeId)) {
        context.addIssue({
          code: "custom",
          message: "Edge references an unknown endpoint",
          path: ["edges", index],
        });
      }
    });
    const edgeRecords = new Map(
      snapshot.edges.map((edge) => [edge.edgeId, edge]),
    );
    const evidenceByEdge = new Map<string, number>();
    snapshot.evidence.forEach((item, index) => {
      evidenceByEdge.set(
        item.edgeId,
        (evidenceByEdge.get(item.edgeId) ?? 0) + 1,
      );
      const edge = edgeRecords.get(item.edgeId);
      const occurrence = occurrences.get(item.occurrenceId);
      if (!edge || !occurrence) {
        context.addIssue({
          code: "custom",
          message: "Evidence references an unknown edge or occurrence",
          path: ["evidence", index],
        });
        return;
      }
      if (
        occurrence.nodeId !== edge.sourceNodeId &&
        occurrence.nodeId !== edge.targetNodeId
      ) {
        context.addIssue({
          code: "custom",
          message: "Evidence occurrence does not belong to an edge endpoint",
          path: ["evidence", index, "occurrenceId"],
        });
      }
      if (
        occurrence.path !== item.path ||
        occurrence.sourceArtifactId !== item.sourceArtifactId ||
        JSON.stringify(occurrence.range) !== JSON.stringify(item.range)
      ) {
        context.addIssue({
          code: "custom",
          message: "Evidence provenance does not match its occurrence",
          path: ["evidence", index],
        });
      }
    });
    snapshot.edges.forEach((edge, index) => {
      if (!evidenceByEdge.has(edge.edgeId)) {
        context.addIssue({
          code: "custom",
          message: "Every graph edge requires at least one evidence record",
          path: ["edges", index, "edgeId"],
        });
      }
    });
    const entities = new Set<string>([
      ...nodes,
      ...occurrences.keys(),
      ...edges,
      ...evidence,
    ]);
    snapshot.memberships.forEach((membership, index) => {
      if (
        membership.generationId !== snapshot.scope.generationId ||
        membership.revisionId !== snapshot.scope.revisionId ||
        !entities.has(membership.entityId)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Membership is outside this snapshot or references an unknown entity",
          path: ["memberships", index],
        });
      }
    });
    const memberIds = new Set(
      snapshot.memberships.map((membership) => membership.entityId),
    );
    if (
      memberIds.size !== entities.size ||
      [...entities].some((entityId) => !memberIds.has(entityId))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Snapshot membership must cover every graph entity exactly once",
        path: ["memberships"],
      });
    }
  });
export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;

export interface GraphDiff {
  added: {
    edges: string[];
    evidence: string[];
    nodes: string[];
    occurrences: string[];
  };
  changed: {
    edges: string[];
    evidence: string[];
    nodes: string[];
    occurrences: string[];
  };
  coverage: {
    consideredChanges: number;
    exhaustedReasons: Array<
      "bytes" | "depth" | "edges" | "milliseconds" | "nodes" | "page"
    >;
    exhaustive: boolean;
    totalChanges: number;
    truncated: boolean;
  };
  fromRevisionId: string;
  nextCursor: string | null;
  removed: {
    edges: string[];
    evidence: string[];
    nodes: string[];
    occurrences: string[];
  };
  toRevisionId: string;
  truncated: boolean;
}

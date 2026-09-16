import { z } from "zod";
import {
  createIdentity,
  EvidenceRangeSchema,
  RepositoryIdSchema,
  RepositoryRelativePathSchema,
  RevisionIdSchema,
  Sha256Schema,
} from "../contracts/common.ts";
import type { GraphMaterializationInput } from "../resolution/types.ts";

const identity = z.string().min(1);
const sourceArtifact = z.union([
  Sha256Schema,
  z.string().regex(/^source:v1:[a-f0-9]{64}$/u),
]);
const nullableIdentity = identity.nullable();

const nodeSchema = z
  .object({
    id: identity,
    kind: z.enum([
      "symbol",
      "document",
      "section",
      "project",
      "package",
      "resource",
      "component",
      "external",
    ]),
    name: z.string(),
    occurrenceId: identity,
    parentNodeId: nullableIdentity,
    path: RepositoryRelativePathSchema,
    qualifiedName: z.string().nullable(),
    range: EvidenceRangeSchema,
    sourceArtifactId: sourceArtifact,
  })
  .strict();

const occurrenceSchema = z
  .object({
    id: identity,
    name: z.string(),
    ordinal: z.number().int().nonnegative(),
    path: RepositoryRelativePathSchema,
    range: EvidenceRangeSchema,
    role: z.enum([
      "declaration",
      "read",
      "write",
      "type",
      "import",
      "export",
      "call",
      "relationship",
    ]),
    sourceArtifactId: sourceArtifact,
    sourceFactId: identity,
  })
  .strict();

const evidenceSchema = z
  .object({
    basis: z.enum([
      "declaration",
      "local-scope",
      "module-export",
      "direct-document",
      "direct-project",
      "hierarchy",
      "name-only",
    ]),
    id: identity,
    occurrenceId: identity,
    path: RepositoryRelativePathSchema,
    range: EvidenceRangeSchema,
    sourceFactId: identity,
  })
  .strict();

const relationshipSchema = z
  .object({
    evidenceIds: z.array(identity).min(1),
    id: identity,
    kind: z.enum([
      "reference",
      "call",
      "import",
      "export",
      "inheritance",
      "implementation",
      "document-link",
      "dependency",
      "resource",
      "type-reference",
      "containment",
    ]),
    sourceNodeId: nullableIdentity,
    status: z.enum(["resolved", "ambiguous", "unresolved"]),
    target: z.string(),
    targetNodeIds: z.array(identity),
  })
  .strict();

const membershipSchema = z
  .object({
    entityId: identity,
    entityKind: z.enum(["node", "occurrence", "relationship", "evidence"]),
    id: identity,
    path: RepositoryRelativePathSchema,
    repositoryId: RepositoryIdSchema,
    revisionId: RevisionIdSchema,
    sourceArtifactId: sourceArtifact,
  })
  .strict();

const resolutionGraphSchema = z
  .object({
    environmentFingerprint: Sha256Schema,
    evidence: z.array(evidenceSchema),
    id: identity,
    memberships: z.array(membershipSchema),
    nodes: z.array(nodeSchema),
    occurrences: z.array(occurrenceSchema),
    relationships: z.array(relationshipSchema),
    repositoryId: RepositoryIdSchema,
    resolverFingerprint: Sha256Schema,
    revisionId: RevisionIdSchema,
    sourceArtifacts: z.array(sourceArtifact),
  })
  .strict();

function sameRange(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uniqueIds<T extends { id: string }>(
  values: readonly T[],
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id))
      throw new TypeError(`duplicate_resolution_${label}_identity`);
    result.set(value.id, value);
  }
  return result;
}

export function parseResolutionGraphMaterialization(
  value: unknown,
): GraphMaterializationInput {
  const graph = resolutionGraphSchema.parse(value);
  const nodes = uniqueIds(graph.nodes, "node");
  const occurrences = uniqueIds(graph.occurrences, "occurrence");
  const relationships = uniqueIds(graph.relationships, "relationship");
  const evidence = uniqueIds(graph.evidence, "evidence");
  const artifacts = new Set(graph.sourceArtifacts);
  if (artifacts.size !== graph.sourceArtifacts.length)
    throw new TypeError("duplicate_resolution_source_artifact");

  for (const node of graph.nodes) {
    const occurrence = occurrences.get(node.occurrenceId);
    if (
      !occurrence ||
      occurrence.path !== node.path ||
      occurrence.sourceArtifactId !== node.sourceArtifactId ||
      !sameRange(occurrence.range, node.range)
    )
      throw new TypeError("invalid_resolution_node_occurrence");
  }

  for (const item of graph.evidence) {
    const occurrence = occurrences.get(item.occurrenceId);
    if (
      !occurrence ||
      occurrence.path !== item.path ||
      occurrence.sourceFactId !== item.sourceFactId ||
      !sameRange(occurrence.range, item.range)
    )
      throw new TypeError("invalid_resolution_evidence_occurrence");
  }

  const containmentChildren = new Map<string, number>();
  for (const relationship of graph.relationships) {
    if (
      (relationship.sourceNodeId !== null &&
        !nodes.has(relationship.sourceNodeId)) ||
      relationship.targetNodeIds.some((nodeId) => !nodes.has(nodeId)) ||
      new Set(relationship.targetNodeIds).size !==
        relationship.targetNodeIds.length ||
      relationship.evidenceIds.some(
        (evidenceId) => !evidence.has(evidenceId),
      ) ||
      new Set(relationship.evidenceIds).size !== relationship.evidenceIds.length
    )
      throw new TypeError("invalid_resolution_relationship_reference");
    if (
      (relationship.status === "resolved" &&
        relationship.targetNodeIds.length !== 1) ||
      (relationship.status === "ambiguous" &&
        relationship.targetNodeIds.length === 0) ||
      (relationship.status === "unresolved" &&
        relationship.targetNodeIds.length !== 0)
    )
      throw new TypeError("invalid_resolution_status_cardinality");
    if (relationship.kind === "containment") {
      const source =
        relationship.sourceNodeId === null
          ? undefined
          : nodes.get(relationship.sourceNodeId);
      const child = nodes.get(relationship.targetNodeIds[0] ?? "");
      if (
        relationship.status !== "resolved" ||
        !source ||
        !child ||
        child.parentNodeId !== source.id ||
        source.path !== child.path ||
        source.sourceArtifactId !== child.sourceArtifactId ||
        relationship.evidenceIds.some(
          (evidenceId) => evidence.get(evidenceId)?.basis !== "hierarchy",
        )
      )
        throw new TypeError("invalid_resolution_containment");
      containmentChildren.set(
        child.id,
        (containmentChildren.get(child.id) ?? 0) + 1,
      );
    }
  }
  for (const node of graph.nodes) {
    if (
      (node.parentNodeId === null && containmentChildren.has(node.id)) ||
      (node.parentNodeId !== null &&
        (containmentChildren.get(node.id) !== 1 ||
          !nodes.has(node.parentNodeId) ||
          node.parentNodeId === node.id))
    )
      throw new TypeError("invalid_resolution_node_hierarchy");
    const ancestors = new Set<string>([node.id]);
    let parentNodeId = node.parentNodeId;
    while (parentNodeId !== null) {
      if (ancestors.has(parentNodeId))
        throw new TypeError("cyclic_resolution_node_hierarchy");
      ancestors.add(parentNodeId);
      parentNodeId = nodes.get(parentNodeId)?.parentNodeId ?? null;
    }
  }

  const expectedMemberships = new Set<string>([
    ...graph.nodes.map((item) => `node:${item.id}`),
    ...graph.occurrences.map((item) => `occurrence:${item.id}`),
    ...graph.relationships.map((item) => `relationship:${item.id}`),
    ...graph.evidence.map((item) => `evidence:${item.id}`),
  ]);
  const membershipIds = new Set<string>();
  const membershipEntities = new Set<string>();
  for (const membership of graph.memberships) {
    const entityKey = `${membership.entityKind}:${membership.entityId}`;
    if (
      !artifacts.has(membership.sourceArtifactId) ||
      membership.repositoryId !== graph.repositoryId ||
      membership.revisionId !== graph.revisionId ||
      membershipIds.has(membership.id) ||
      membershipEntities.has(entityKey) ||
      membership.id !==
        createIdentity("membership", [
          graph.repositoryId,
          graph.revisionId,
          membership.path,
          membership.sourceArtifactId,
          membership.entityKind,
          membership.entityId,
        ])
    )
      throw new TypeError("invalid_resolution_membership");

    let path: string;
    let artifactId: string;
    if (membership.entityKind === "node") {
      const entity = nodes.get(membership.entityId);
      if (!entity) throw new TypeError("invalid_resolution_membership");
      path = entity.path;
      artifactId = entity.sourceArtifactId;
    } else if (membership.entityKind === "occurrence") {
      const entity = occurrences.get(membership.entityId);
      if (!entity) throw new TypeError("invalid_resolution_membership");
      path = entity.path;
      artifactId = entity.sourceArtifactId;
    } else if (membership.entityKind === "evidence") {
      const entity = evidence.get(membership.entityId);
      const occurrence = entity && occurrences.get(entity.occurrenceId);
      if (!occurrence) throw new TypeError("invalid_resolution_membership");
      path = occurrence.path;
      artifactId = occurrence.sourceArtifactId;
    } else {
      const entity = relationships.get(membership.entityId);
      const firstEvidence = entity && evidence.get(entity.evidenceIds[0] ?? "");
      const occurrence =
        firstEvidence && occurrences.get(firstEvidence.occurrenceId);
      if (!occurrence) throw new TypeError("invalid_resolution_membership");
      path = occurrence.path;
      artifactId = occurrence.sourceArtifactId;
    }
    if (membership.path !== path || membership.sourceArtifactId !== artifactId)
      throw new TypeError("invalid_resolution_membership");
    membershipIds.add(membership.id);
    membershipEntities.add(entityKey);
  }
  if (
    membershipEntities.size !== expectedMemberships.size ||
    [...expectedMemberships].some((key) => !membershipEntities.has(key))
  )
    throw new TypeError("incomplete_resolution_membership");

  return graph;
}

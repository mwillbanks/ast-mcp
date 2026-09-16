import { z } from "zod";
import {
  createIdentity,
  EvidenceRangeSchema,
  GenerationIdSchema,
  NonEmptyStringSchema,
  namespacedIdentitySchema,
  RepositoryRelativePathSchema,
  RevisionIdSchema,
  Sha256Schema,
  SourceArtifactIdSchema,
} from "./common.ts";

export const GraphNodeIdSchema = namespacedIdentitySchema("graph-node");
export const GraphOccurrenceIdSchema =
  namespacedIdentitySchema("graph-occurrence");
export const GraphEdgeIdSchema = namespacedIdentitySchema("graph-edge");
export const GraphEvidenceIdSchema = namespacedIdentitySchema("graph-evidence");
export const RevisionMembershipIdSchema = namespacedIdentitySchema(
  "revision-membership",
);
export const GraphEntityIdSchema = z.union([
  GraphNodeIdSchema,
  GraphOccurrenceIdSchema,
  GraphEdgeIdSchema,
  GraphEvidenceIdSchema,
]);

export const GraphNodeKindSchema = z.enum([
  "repository",
  "package",
  "concept",
  "external-reference",
  "file",
  "module",
  "namespace",
  "type",
  "function",
  "method",
  "field",
  "variable",
  "parameter",
  "document",
  "section",
  "chunk",
]);

const GraphPropertyScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const GraphPropertySchema = z
  .object({
    key: NonEmptyStringSchema,
    value: z.union([
      GraphPropertyScalarSchema,
      z.array(GraphPropertyScalarSchema),
    ]),
  })
  .strict();

export const GraphNodeSchema = z
  .object({
    canonicalName: NonEmptyStringSchema,
    contentFingerprint: Sha256Schema,
    kind: GraphNodeKindSchema,
    nodeId: GraphNodeIdSchema,
    properties: z.array(GraphPropertySchema),
  })
  .strict()
  .superRefine((node, context) => {
    if (
      node.nodeId !==
      graphNodeIdentity({
        canonicalName: node.canonicalName,
        kind: node.kind,
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Graph node identity does not match its stable coordinates",
        path: ["nodeId"],
      });
    }
  });

export const GraphOccurrenceRoleSchema = z.enum([
  "declaration",
  "reference",
  "import",
  "export",
  "call",
  "inheritance",
  "containment",
  "document",
]);

export const GraphOccurrenceSchema = z
  .object({
    nodeId: GraphNodeIdSchema,
    occurrenceId: GraphOccurrenceIdSchema,
    path: RepositoryRelativePathSchema,
    range: EvidenceRangeSchema,
    role: GraphOccurrenceRoleSchema,
    sourceArtifactId: SourceArtifactIdSchema,
  })
  .strict()
  .superRefine((occurrence, context) => {
    if (
      occurrence.occurrenceId !==
      graphOccurrenceIdentity({
        nodeId: occurrence.nodeId,
        path: occurrence.path,
        range: occurrence.range,
        role: occurrence.role,
        sourceArtifactId: occurrence.sourceArtifactId,
      })
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Graph occurrence identity does not match its stable coordinates",
        path: ["occurrenceId"],
      });
    }
  });

export const GraphEdgeKindSchema = z.enum([
  "contains",
  "declares",
  "references",
  "imports",
  "exports",
  "calls",
  "inherits",
  "implements",
  "overrides",
  "reads",
  "writes",
  "documents",
  "links",
  "depends-on",
]);

export const ResolutionStatusSchema = z.enum([
  "explicit",
  "resolved",
  "inferred",
  "ambiguous",
  "unresolved",
]);

export const GraphEdgeSchema = z
  .object({
    contentFingerprint: Sha256Schema,
    direction: z.literal("directed"),
    discriminator: NonEmptyStringSchema,
    edgeId: GraphEdgeIdSchema,
    environmentFingerprint: Sha256Schema.nullable(),
    kind: GraphEdgeKindSchema,
    properties: z.array(GraphPropertySchema),
    resolutionStatus: ResolutionStatusSchema,
    sourceNodeId: GraphNodeIdSchema,
    targetNodeId: GraphNodeIdSchema,
  })
  .strict()
  .superRefine((edge, context) => {
    if (
      edge.edgeId !==
      graphEdgeIdentity({
        discriminator: edge.discriminator,
        kind: edge.kind,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Graph edge identity does not match its stable coordinates",
        path: ["edgeId"],
      });
    }
  });

export const ExtractionMethodSchema = z.enum([
  "ast",
  "tree-sitter-query",
  "ast-grep",
  "structured-parser",
  "text-pattern",
  "resolver",
]);

const GraphEvidenceRecordSchema = z
  .object({
    confidence: z.number().min(0).max(1),
    edgeId: GraphEdgeIdSchema,
    evidenceId: GraphEvidenceIdSchema,
    extractionMethod: ExtractionMethodSchema,
    extractionVersion: NonEmptyStringSchema,
    extractorFingerprint: Sha256Schema,
    occurrenceId: GraphOccurrenceIdSchema,
    path: RepositoryRelativePathSchema,
    range: EvidenceRangeSchema,
    sourceArtifactId: SourceArtifactIdSchema,
  })
  .strict();

export const GraphEvidenceSchema = GraphEvidenceRecordSchema.superRefine(
  (evidence, context) => {
    if (
      evidence.evidenceId !==
      graphEvidenceIdentity({
        edgeId: evidence.edgeId,
        extractionMethod: evidence.extractionMethod,
        extractionVersion: evidence.extractionVersion,
        extractorFingerprint: evidence.extractorFingerprint,
        occurrenceId: evidence.occurrenceId,
        path: evidence.path,
        range: evidence.range,
        sourceArtifactId: evidence.sourceArtifactId,
      })
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Graph evidence identity does not match its stable coordinates",
        path: ["evidenceId"],
      });
    }
  },
);

export const GraphRelationshipSchema = z
  .object({
    edge: GraphEdgeSchema,
    evidence: z.array(GraphEvidenceSchema).min(1),
    occurrences: z.array(GraphOccurrenceSchema).min(1),
  })
  .strict()
  .superRefine((relationship, context) => {
    const occurrences = new Map(
      relationship.occurrences.map((occurrence) => [
        occurrence.occurrenceId,
        occurrence,
      ]),
    );
    relationship.evidence.forEach((evidence, index) => {
      if (evidence.edgeId !== relationship.edge.edgeId) {
        context.addIssue({
          code: "custom",
          message: "Relationship evidence must link to its edge",
          path: ["evidence", index, "edgeId"],
        });
      }
      const occurrence = occurrences.get(evidence.occurrenceId);
      if (!occurrence) {
        context.addIssue({
          code: "custom",
          message: "Relationship evidence must link to a bundled occurrence",
          path: ["evidence", index, "occurrenceId"],
        });
        return;
      }
      if (
        occurrence.nodeId !== relationship.edge.sourceNodeId &&
        occurrence.nodeId !== relationship.edge.targetNodeId
      ) {
        context.addIssue({
          code: "custom",
          message: "Evidence occurrence must belong to an edge endpoint",
          path: ["occurrences", occurrence.occurrenceId, "nodeId"],
        });
      }
      if (
        occurrence.path !== evidence.path ||
        occurrence.sourceArtifactId !== evidence.sourceArtifactId ||
        occurrence.range.startByte !== evidence.range.startByte ||
        occurrence.range.endByte !== evidence.range.endByte ||
        occurrence.range.start.line !== evidence.range.start.line ||
        occurrence.range.start.column !== evidence.range.start.column ||
        occurrence.range.end.line !== evidence.range.end.line ||
        occurrence.range.end.column !== evidence.range.end.column
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Relationship evidence range must match its bundled occurrence",
          path: ["evidence", index, "range"],
        });
      }
    });
  });

const RevisionMembershipRecordSchema = z
  .object({
    entityId: GraphEntityIdSchema,
    entityKind: z.enum(["node", "occurrence", "edge", "evidence"]),
    generationId: GenerationIdSchema,
    membershipId: RevisionMembershipIdSchema,
    revisionId: RevisionIdSchema,
  })
  .strict();

export const RevisionMembershipSchema =
  RevisionMembershipRecordSchema.superRefine((membership, context) => {
    const entitySchema = {
      edge: GraphEdgeIdSchema,
      evidence: GraphEvidenceIdSchema,
      node: GraphNodeIdSchema,
      occurrence: GraphOccurrenceIdSchema,
    }[membership.entityKind];
    if (!entitySchema.safeParse(membership.entityId).success) {
      context.addIssue({
        code: "custom",
        message: "Revision membership entity namespace must match its kind",
        path: ["entityId"],
      });
    }
    if (
      membership.membershipId !==
      revisionMembershipIdentity({
        entityId: membership.entityId,
        entityKind: membership.entityKind,
        generationId: membership.generationId,
        revisionId: membership.revisionId,
      })
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Revision membership identity does not match its stable coordinates",
        path: ["membershipId"],
      });
    }
  });

export const GraphNodeIdentityInputSchema = z
  .object({ canonicalName: NonEmptyStringSchema, kind: GraphNodeKindSchema })
  .strict();

export const GraphOccurrenceIdentityInputSchema = z
  .object({
    nodeId: GraphNodeIdSchema,
    path: RepositoryRelativePathSchema,
    range: EvidenceRangeSchema,
    role: GraphOccurrenceRoleSchema,
    sourceArtifactId: SourceArtifactIdSchema,
  })
  .strict();

export const GraphEdgeIdentityInputSchema = z
  .object({
    discriminator: NonEmptyStringSchema,
    kind: GraphEdgeKindSchema,
    sourceNodeId: GraphNodeIdSchema,
    targetNodeId: GraphNodeIdSchema,
  })
  .strict();

export const GraphEvidenceIdentityInputSchema = GraphEvidenceRecordSchema.omit({
  confidence: true,
  evidenceId: true,
});

export const RevisionMembershipIdentityInputSchema =
  RevisionMembershipRecordSchema.omit({
    membershipId: true,
  });

export function graphNodeIdentity(
  input: z.input<typeof GraphNodeIdentityInputSchema>,
): string {
  return createIdentity(
    "graph-node",
    GraphNodeIdentityInputSchema.parse(input),
  );
}

export function graphOccurrenceIdentity(
  input: z.input<typeof GraphOccurrenceIdentityInputSchema>,
): string {
  return createIdentity(
    "graph-occurrence",
    GraphOccurrenceIdentityInputSchema.parse(input),
  );
}

export function graphEdgeIdentity(
  input: z.input<typeof GraphEdgeIdentityInputSchema>,
): string {
  return createIdentity(
    "graph-edge",
    GraphEdgeIdentityInputSchema.parse(input),
  );
}

export function graphEvidenceIdentity(
  input: z.input<typeof GraphEvidenceIdentityInputSchema>,
): string {
  return createIdentity(
    "graph-evidence",
    GraphEvidenceIdentityInputSchema.parse(input),
  );
}

export function revisionMembershipIdentity(
  input: z.input<typeof RevisionMembershipIdentityInputSchema>,
): string {
  return createIdentity(
    "revision-membership",
    RevisionMembershipIdentityInputSchema.parse(input),
  );
}

import type { EvidenceRange } from "../contracts/common.ts";
import type { ProjectFacts } from "../languages/project/types.ts";
import type { SyntaxFacts } from "../parser/types.ts";

export type ResolutionStatus = "resolved" | "ambiguous" | "unresolved";

export interface ResolutionContext {
  environmentFingerprint: string;
  repositoryId: string;
  resolverFingerprint: string;
  revisionId: string;
}
export interface CodeResolutionSource {
  facts: SyntaxFacts;
  kind: "code";
  path: string;
}
export interface DocumentFactNode {
  id: string;
  name: string;
  nodeKind?: "document" | "section" | "package" | "resource";
  parentId: string | null;
  range: EvidenceRange;
}
export interface DocumentFactRelationship {
  id: string;
  kind: "document-link" | "dependency" | "reference" | "resource";
  range: EvidenceRange;
  sourceNodeId: string | null;
  target: string;
}
export interface DocumentResolutionFacts {
  artifactId: string;
  nodes: readonly DocumentFactNode[];
  relationships: readonly DocumentFactRelationship[];
  sourceDigest: string;
}
export interface DocumentResolutionSource {
  facts: DocumentResolutionFacts;
  kind: "document";
  path: string;
}
export interface ProjectResolutionSource {
  facts: ProjectFacts;
  kind: "project";
  path: string;
}
export type ResolutionSource =
  | CodeResolutionSource
  | DocumentResolutionSource
  | ProjectResolutionSource;
export interface ResolveGraphRequest extends ResolutionContext {
  sources: readonly ResolutionSource[];
}
export interface MaterializedNode {
  id: string;
  kind:
    | "symbol"
    | "document"
    | "section"
    | "project"
    | "package"
    | "resource"
    | "component"
    | "external";
  name: string;
  occurrenceId: string;
  parentNodeId: string | null;
  path: string;
  qualifiedName: string | null;
  range: EvidenceRange;
  sourceArtifactId: string;
}
export interface MaterializedOccurrence {
  id: string;
  name: string;
  ordinal: number;
  path: string;
  range: EvidenceRange;
  role:
    | "declaration"
    | "read"
    | "write"
    | "type"
    | "import"
    | "export"
    | "call"
    | "relationship";
  sourceArtifactId: string;
  sourceFactId: string;
}
export interface ResolutionEvidence {
  basis:
    | "declaration"
    | "local-scope"
    | "module-export"
    | "direct-document"
    | "direct-project"
    | "hierarchy"
    | "name-only";
  id: string;
  occurrenceId: string;
  path: string;
  range: EvidenceRange;
  sourceFactId: string;
}
export interface MaterializedRelationship {
  evidenceIds: readonly string[];
  id: string;
  kind:
    | "reference"
    | "call"
    | "import"
    | "export"
    | "inheritance"
    | "implementation"
    | "document-link"
    | "dependency"
    | "resource"
    | "type-reference"
    | "containment";
  sourceNodeId: string | null;
  status: ResolutionStatus;
  target: string;
  targetNodeIds: readonly string[];
}
export interface ResolutionMembership {
  entityId: string;
  entityKind: "node" | "occurrence" | "relationship" | "evidence";
  id: string;
  path: string;
  repositoryId: string;
  revisionId: string;
  sourceArtifactId: string;
}
export interface GraphMaterializationInput extends ResolutionContext {
  evidence: readonly ResolutionEvidence[];
  id: string;
  memberships: readonly ResolutionMembership[];
  nodes: readonly MaterializedNode[];
  occurrences: readonly MaterializedOccurrence[];
  relationships: readonly MaterializedRelationship[];
  sourceArtifacts: readonly string[];
}

import type { z } from "zod";

import type {
  GraphNodeSchema,
  GraphRelationshipSchema,
  RevisionMembershipSchema,
} from "../../contracts/graph.ts";

export type AlgorithmNode = z.infer<typeof GraphNodeSchema>;
export type AlgorithmRelationship = z.infer<typeof GraphRelationshipSchema>;
export type AlgorithmMembership = z.infer<typeof RevisionMembershipSchema>;

export interface GraphAlgorithmSnapshot {
  generationId: string;
  memberships: readonly AlgorithmMembership[];
  nodes: readonly AlgorithmNode[];
  relationships: readonly AlgorithmRelationship[];
  revisionId: string;
}

export interface GraphAlgorithmBudget {
  maxBytes: number;
  maxDepth: number;
  maxEdges: number;
  maxMilliseconds: number;
  maxNodes: number;
  pageSize: number;
}

export type GraphDirection = "forward" | "reverse";

export interface GraphAlgorithmCursorCodec {
  decode(cursor: string, binding: string): unknown;
  encode(payload: { offset: number }, binding: string): string;
}

export interface TraversalRequest {
  budget: GraphAlgorithmBudget;
  cursor?: string;
  direction: GraphDirection;
  edgeKinds?: readonly AlgorithmRelationship["edge"]["kind"][];
  resolutionStatuses?: readonly AlgorithmRelationship["edge"]["resolutionStatus"][];
  snapshot: GraphAlgorithmSnapshot;
  startNodeIds: readonly string[];
}

export interface ShortestPathRequest extends Omit<
  TraversalRequest,
  "cursor" | "startNodeIds"
> {
  sourceNodeId: string;
  targetNodeId: string;
}

export interface StronglyConnectedComponentsRequest {
  budget: GraphAlgorithmBudget;
  cursor?: string;
  edgeKinds?: readonly AlgorithmRelationship["edge"]["kind"][];
  resolutionStatuses?: readonly AlgorithmRelationship["edge"]["resolutionStatus"][];
  snapshot: GraphAlgorithmSnapshot;
}

export interface ImpactExpansionRequest extends Omit<
  TraversalRequest,
  "direction"
> {
  direction?: GraphDirection;
}

export type BudgetReason =
  | "bytes"
  | "depth"
  | "edges"
  | "milliseconds"
  | "nodes"
  | "page";

export interface AlgorithmCoverage {
  consideredEdges: number;
  discoveredNodes: number;
  exhaustedReasons: BudgetReason[];
  generationId: string;
  revisionId: string;
}

export interface PageMetadata {
  cursor: string | null;
  exhaustive: boolean;
  truncated: boolean;
}

export interface TraversalResult {
  coverage: AlgorithmCoverage;
  nodes: AlgorithmNode[];
  page: PageMetadata;
  relationships: AlgorithmRelationship[];
}

export interface ShortestPathResult {
  coverage: AlgorithmCoverage;
  found: boolean;
  nodes: AlgorithmNode[];
  page: PageMetadata;
  relationships: AlgorithmRelationship[];
}

export interface StronglyConnectedComponentsResult {
  components: AlgorithmNode[][];
  coverage: AlgorithmCoverage;
  page: PageMetadata;
}

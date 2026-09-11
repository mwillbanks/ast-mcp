import type { GraphScope, GraphSnapshot } from "../graph/types.ts";

export const ANALYTICS_ALGORITHM = "seeded-leiden-native" as const;
export const ANALYTICS_VERSION = "1" as const;
export const PROJECTION_VERSION = "evidence-weighted-undirected-v1" as const;

export interface AnalyticsBudget {
  maxCentralitySources: number;
  maxEdges: number;
  maxIterations: number;
  maxLevels: number;
  maxNodes: number;
  pagerankIterations: number;
  tolerance: number;
}

export interface AnalyticsOptions {
  budget?: Partial<AnalyticsBudget>;
  resolution?: number;
  seed?: number;
}

export interface AnalyticsCoverage {
  consideredEdges: number;
  consideredNodes: number;
  reasons: readonly (
    | "centrality-budget"
    | "edge-budget"
    | "iteration-budget"
    | "level-budget"
    | "node-budget"
  )[];
  totalEdges: number;
  totalNodes: number;
  truncated: boolean;
}

export interface ProjectedEdge {
  edgeIds: readonly string[];
  evidenceIds: readonly string[];
  sourceNodeId: string;
  targetNodeId: string;
  weight: number;
}

export interface WeightedProjection {
  edges: readonly ProjectedEdge[];
  evidenceFingerprint: string;
  fingerprint: string;
  nodeIds: readonly string[];
}

export interface NodeCentrality {
  betweenness: number;
  degree: number;
  inDegree: number;
  nodeId: string;
  outDegree: number;
  pageRank: number;
  weightedDegree: number;
}

export interface CommunityLevel {
  communities: readonly (readonly string[])[];
  level: number;
  modularity: number;
}

export interface DeterministicCommunitySummary {
  cacheKey: string;
  content: string;
  contentDigest: string;
  evidenceFingerprint: string;
  label: string;
  membershipFingerprint: string;
  summaryId: string;
}

export interface AnalyticsCommunity {
  communityId: string;
  connected: boolean;
  label: string;
  level: number;
  memberIds: readonly string[];
  membershipFingerprint: string;
  summary: DeterministicCommunitySummary;
}

export interface GraphAnalyticsResult {
  algorithm: typeof ANALYTICS_ALGORITHM;
  algorithmVersion: typeof ANALYTICS_VERSION;
  centrality: readonly NodeCentrality[];
  communities: readonly AnalyticsCommunity[];
  coverage: AnalyticsCoverage;
  hierarchy: readonly CommunityLevel[];
  projection: WeightedProjection;
  resolution: number;
  scope: GraphScope;
  seed: number;
}

export interface AnalyticsInput {
  options?: AnalyticsOptions;
  snapshot: GraphSnapshot;
}

export interface PersistedAnalytics {
  algorithm: typeof ANALYTICS_ALGORITHM;
  algorithmVersion: typeof ANALYTICS_VERSION;
  communities: readonly AnalyticsCommunity[];
  projectionFingerprint: string;
  resolution: number;
  scope: GraphScope;
  seed: number;
}

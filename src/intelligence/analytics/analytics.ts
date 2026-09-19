import { createHash } from "node:crypto";

import { createIdentity } from "../contracts/common.ts";
import { GraphSnapshotSchema } from "../graph/types.ts";
import {
  ANALYTICS_ALGORITHM,
  ANALYTICS_VERSION,
  type AnalyticsBudget,
  type AnalyticsCommunity,
  type AnalyticsInput,
  type AnalyticsOptions,
  type CommunityLevel,
  type GraphAnalyticsResult,
  type NodeCentrality,
  PROJECTION_VERSION,
  type ProjectedEdge,
  type WeightedProjection,
} from "./types.ts";

const DEFAULT_BUDGET: AnalyticsBudget = Object.freeze({
  maxCentralitySources: 256,
  maxEdges: 1_000_000,
  maxIterations: 100,
  maxLevels: 16,
  maxNodes: 1_000_000,
  pagerankIterations: 100,
  tolerance: 1e-10,
});

const STATUS_WEIGHT = Object.freeze({
  ambiguous: 0.4,
  explicit: 1,
  inferred: 0.75,
  resolved: 0.95,
  unresolved: 0.2,
});

interface MutableEdge {
  edgeIds: string[];
  evidenceIds: string[];
  sourceNodeId: string;
  targetNodeId: string;
  weight: number;
}

interface LevelGraph {
  adjacency: ReadonlyMap<number, ReadonlyMap<number, number>>;
  members: readonly (readonly string[])[];
  strengths: readonly number[];
  totalWeight: number;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required<T>(value: T | undefined, context: string): T {
  if (value === undefined)
    throw new Error(`analytics invariant failed: ${context}`);
  return value;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function checkedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return result;
}

function options(input: AnalyticsOptions | undefined) {
  const budget = input?.budget;
  const tolerance = budget?.tolerance ?? DEFAULT_BUDGET.tolerance;
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1) {
    throw new TypeError("tolerance must be greater than zero and at most one");
  }
  const resolution = input?.resolution ?? 1;
  if (!Number.isFinite(resolution) || resolution <= 0 || resolution > 100) {
    throw new TypeError("resolution must be greater than zero and at most 100");
  }
  return {
    budget: {
      maxCentralitySources: checkedInteger(
        budget?.maxCentralitySources,
        DEFAULT_BUDGET.maxCentralitySources,
        1,
        10_000,
        "maxCentralitySources",
      ),
      maxEdges: checkedInteger(
        budget?.maxEdges,
        DEFAULT_BUDGET.maxEdges,
        1,
        1_000_000,
        "maxEdges",
      ),
      maxIterations: checkedInteger(
        budget?.maxIterations,
        DEFAULT_BUDGET.maxIterations,
        1,
        10_000,
        "maxIterations",
      ),
      maxLevels: checkedInteger(
        budget?.maxLevels,
        DEFAULT_BUDGET.maxLevels,
        1,
        100,
        "maxLevels",
      ),
      maxNodes: checkedInteger(
        budget?.maxNodes,
        DEFAULT_BUDGET.maxNodes,
        1,
        1_000_000,
        "maxNodes",
      ),
      pagerankIterations: checkedInteger(
        budget?.pagerankIterations,
        DEFAULT_BUDGET.pagerankIterations,
        1,
        10_000,
        "pagerankIterations",
      ),
      tolerance,
    },
    resolution,
    seed: checkedInteger(input?.seed, 0, 0, 0x7fffffff, "seed"),
  };
}

function edgeWeight(
  status: keyof typeof STATUS_WEIGHT,
  evidence: readonly { confidence: number }[],
): number {
  return (
    STATUS_WEIGHT[status] *
    evidence.reduce((sum, item) => sum + item.confidence, 0)
  );
}

export function projectGraph(
  snapshotInput: unknown,
  budgetInput: Pick<AnalyticsBudget, "maxEdges" | "maxNodes"> = DEFAULT_BUDGET,
): {
  coverage: GraphAnalyticsResult["coverage"];
  projection: WeightedProjection;
} {
  const snapshot = GraphSnapshotSchema.parse(snapshotInput);
  const maxEdges = checkedInteger(
    budgetInput.maxEdges,
    DEFAULT_BUDGET.maxEdges,
    1,
    1_000_000,
    "maxEdges",
  );
  const maxNodes = checkedInteger(
    budgetInput.maxNodes,
    DEFAULT_BUDGET.maxNodes,
    1,
    1_000_000,
    "maxNodes",
  );
  const nodeIds = snapshot.nodes
    .map(({ nodeId }) => nodeId)
    .sort()
    .slice(0, maxNodes);
  const selectedNodes = new Set(nodeIds);
  const evidenceByEdge = new Map<string, typeof snapshot.evidence>();
  for (const evidence of snapshot.evidence) {
    const items = evidenceByEdge.get(evidence.edgeId) ?? [];
    evidenceByEdge.set(evidence.edgeId, [...items, evidence]);
  }
  const selectedEdges = snapshot.edges
    .filter(
      (edge) =>
        selectedNodes.has(edge.sourceNodeId) &&
        selectedNodes.has(edge.targetNodeId),
    )
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId))
    .slice(0, maxEdges);
  const pairs = new Map<string, MutableEdge>();
  for (const edge of selectedEdges) {
    const [sourceNodeId, targetNodeId] =
      edge.sourceNodeId <= edge.targetNodeId
        ? [edge.sourceNodeId, edge.targetNodeId]
        : [edge.targetNodeId, edge.sourceNodeId];
    const key = `${sourceNodeId}\0${targetNodeId}`;
    const evidence = (evidenceByEdge.get(edge.edgeId) ?? []).sort(
      (left, right) => left.evidenceId.localeCompare(right.evidenceId),
    );
    const existing = pairs.get(key) ?? {
      edgeIds: [],
      evidenceIds: [],
      sourceNodeId,
      targetNodeId,
      weight: 0,
    };
    existing.edgeIds.push(edge.edgeId);
    existing.evidenceIds.push(...evidence.map(({ evidenceId }) => evidenceId));
    existing.weight += edgeWeight(edge.resolutionStatus, evidence);
    pairs.set(key, existing);
  }
  const edges: ProjectedEdge[] = [...pairs.values()]
    .map((edge) => ({
      ...edge,
      edgeIds: edge.edgeIds.sort(),
      evidenceIds: edge.evidenceIds.sort(),
      weight: edge.weight,
    }))
    .sort(
      (left, right) =>
        left.sourceNodeId.localeCompare(right.sourceNodeId) ||
        left.targetNodeId.localeCompare(right.targetNodeId),
    );
  const evidenceFingerprint = hash(
    stableJson(
      selectedEdges.map((edge) => ({
        edgeId: edge.edgeId,
        evidence: (evidenceByEdge.get(edge.edgeId) ?? [])
          .map((item) => ({
            confidence: item.confidence,
            evidenceId: item.evidenceId,
            extractorFingerprint: item.extractorFingerprint,
          }))
          .sort((left, right) =>
            left.evidenceId.localeCompare(right.evidenceId),
          ),
        resolutionStatus: edge.resolutionStatus,
      })),
    ),
  );
  const fingerprint = hash(
    stableJson({
      edges,
      evidenceFingerprint,
      nodeIds,
      version: PROJECTION_VERSION,
    }),
  );
  const reasons: GraphAnalyticsResult["coverage"]["reasons"][number][] = [];
  if (nodeIds.length < snapshot.nodes.length) reasons.push("node-budget");
  const eligibleEdges = snapshot.edges.filter(
    (edge) =>
      selectedNodes.has(edge.sourceNodeId) &&
      selectedNodes.has(edge.targetNodeId),
  ).length;
  if (selectedEdges.length < eligibleEdges) reasons.push("edge-budget");
  return {
    coverage: {
      consideredEdges: selectedEdges.length,
      consideredNodes: nodeIds.length,
      reasons,
      totalEdges: snapshot.edges.length,
      totalNodes: snapshot.nodes.length,
      truncated: reasons.length > 0,
    },
    projection: {
      edges,
      evidenceFingerprint,
      fingerprint,
      nodeIds,
    },
  };
}

function levelGraph(
  nodeIds: readonly string[],
  edges: readonly ProjectedEdge[],
): LevelGraph {
  const indexes = new Map(nodeIds.map((nodeId, index) => [nodeId, index]));
  const mutable = new Map<number, Map<number, number>>();
  const strengths = nodeIds.map(() => 0);
  let totalWeight = 0;
  for (const edge of edges) {
    const source = indexes.get(edge.sourceNodeId);
    const target = indexes.get(edge.targetNodeId);
    if (source === undefined || target === undefined || edge.weight <= 0)
      continue;
    const sourceMap = mutable.get(source) ?? new Map<number, number>();
    sourceMap.set(
      target,
      (sourceMap.get(target) ?? 0) + edge.weight * (source === target ? 2 : 1),
    );
    mutable.set(source, sourceMap);
    if (source !== target) {
      const targetMap = mutable.get(target) ?? new Map<number, number>();
      targetMap.set(source, (targetMap.get(source) ?? 0) + edge.weight);
      mutable.set(target, targetMap);
      strengths[source] += edge.weight;
      strengths[target] += edge.weight;
      totalWeight += edge.weight;
    } else {
      strengths[source] += 2 * edge.weight;
      totalWeight += edge.weight;
    }
  }
  return {
    adjacency: mutable,
    members: nodeIds.map((nodeId) => [nodeId]),
    strengths,
    totalWeight,
  };
}

function seededOrder(graph: LevelGraph, seed: number): number[] {
  return graph.members
    .map((members, index) => ({
      index,
      key: hash(`${seed}\0${members.join("\0")}`),
    }))
    .sort(
      (left, right) =>
        left.key.localeCompare(right.key) || left.index - right.index,
    )
    .map(({ index }) => index);
}

function selectCommunity(
  initial: number,
  candidates: readonly number[],
  weights: ReadonlyMap<number, number>,
  totals: readonly number[],
  resolution: number,
  strength: number,
  denominator: number,
  tolerance: number,
): number {
  let best = initial;
  let bestGain = 0;
  for (const candidate of candidates) {
    const gain =
      (weights.get(candidate) ?? 0) -
      (resolution * strength * (totals[candidate] ?? 0)) / denominator;
    if (
      gain > bestGain + tolerance ||
      (Math.abs(gain - bestGain) <= tolerance && candidate < best)
    ) {
      best = candidate;
      bestGain = gain;
    }
  }
  return best;
}

function localMove(
  graph: LevelGraph,
  seed: number,
  resolution: number,
  maxIterations: number,
  tolerance: number,
  initialPartition?: readonly number[],
): { iterations: number; limited: boolean; partition: number[] } {
  const partition =
    initialPartition?.length === graph.members.length
      ? [...initialPartition]
      : graph.members.map((_, index) => index);
  if (graph.totalWeight <= 0) {
    return { iterations: 0, limited: false, partition };
  }
  const totals = graph.members.map(() => 0);
  partition.forEach((community, node) => {
    totals[community] = (totals[community] ?? 0) + (graph.strengths[node] ?? 0);
  });
  const denominator = 2 * graph.totalWeight;
  const order = seededOrder(graph, seed);
  let iteration = 0;
  let moved = true;
  while (moved && iteration < maxIterations) {
    moved = false;
    iteration += 1;
    for (const node of order) {
      const current = partition[node] ?? node;
      const strength = graph.strengths[node] ?? 0;
      const weights = new Map<number, number>();
      for (const [neighbor, weight] of graph.adjacency.get(node) ?? []) {
        if (neighbor === node) continue;
        const community = partition[neighbor] ?? neighbor;
        weights.set(community, (weights.get(community) ?? 0) + weight);
      }
      totals[current] = (totals[current] ?? 0) - strength;
      const best = selectCommunity(
        current,
        [...new Set([current, ...weights.keys()])].sort(
          (left, right) => left - right,
        ),
        weights,
        totals,
        resolution,
        strength,
        denominator,
        tolerance,
      );
      partition[node] = best;
      totals[best] = (totals[best] ?? 0) + strength;
      if (best !== current) moved = true;
    }
  }
  return {
    iterations: iteration,
    limited: moved && iteration >= maxIterations,
    partition,
  };
}

function connectedRefinement(
  graph: LevelGraph,
  partition: readonly number[],
): number[] {
  const refined = partition.map(() => -1);
  let next = 0;
  const byCommunity = new Map<number, number[]>();
  partition.forEach((community, node) => {
    const items = byCommunity.get(community) ?? [];
    items.push(node);
    byCommunity.set(community, items);
  });
  for (const nodes of [...byCommunity.values()].sort(
    (left, right) =>
      required(left[0], "left community") -
      required(right[0], "right community"),
  )) {
    const allowed = new Set(nodes);
    for (const start of nodes) {
      if (refined[start] !== -1) continue;
      const queue = [start];
      refined[start] = next;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const node = required(queue[cursor], "refinement queue");
        for (const neighbor of graph.adjacency.get(node)?.keys() ?? []) {
          if (allowed.has(neighbor) && refined[neighbor] === -1) {
            refined[neighbor] = next;
            queue.push(neighbor);
          }
        }
      }
      next += 1;
    }
  }
  return refined;
}

function leidenRefinement(
  graph: LevelGraph,
  coarsePartition: readonly number[],
  seed: number,
  resolution: number,
  tolerance: number,
): number[] {
  const refined = graph.members.map((_, index) => index);
  const totals = [...graph.strengths];
  const sizes = graph.members.map(() => 1);
  if (graph.totalWeight <= 0) return refined;
  const denominator = 2 * graph.totalWeight;
  for (const node of seededOrder(graph, seed)) {
    const current = refined[node] ?? node;
    if ((sizes[current] ?? 0) !== 1) continue;
    const strength = graph.strengths[node] ?? 0;
    const weights = new Map<number, number>();
    for (const [neighbor, weight] of graph.adjacency.get(node) ?? []) {
      if (coarsePartition[neighbor] !== coarsePartition[node]) continue;
      const community = refined[neighbor] ?? neighbor;
      if (community === current) continue;
      weights.set(community, (weights.get(community) ?? 0) + weight);
    }
    const best = selectCommunity(
      current,
      [...weights.keys()].sort((left, right) => left - right),
      weights,
      totals,
      resolution,
      strength,
      denominator,
      tolerance,
    );
    if (best !== current) {
      refined[node] = best;
      totals[current] = (totals[current] ?? 0) - strength;
      totals[best] = (totals[best] ?? 0) + strength;
      sizes[current] = (sizes[current] ?? 1) - 1;
      sizes[best] = (sizes[best] ?? 0) + 1;
    }
  }
  return refined;
}

function groupedMembers(
  graph: LevelGraph,
  partition: readonly number[],
): string[][] {
  const groups = new Map<number, string[]>();
  partition.forEach((community, node) => {
    groups.set(community, [
      ...(groups.get(community) ?? []),
      ...(graph.members[node] ?? []),
    ]);
  });
  return [...groups.values()]
    .map((members) => members.sort())
    .sort((left, right) =>
      required(left[0], "left group").localeCompare(
        required(right[0], "right group"),
      ),
    );
}

function modularity(
  graph: LevelGraph,
  partition: readonly number[],
  resolution: number,
): number {
  if (graph.totalWeight <= 0) return 0;
  const internal = new Map<number, number>();
  const totals = new Map<number, number>();
  partition.forEach((community, node) => {
    totals.set(
      community,
      (totals.get(community) ?? 0) +
        required(graph.strengths[node], "node strength"),
    );
    for (const [neighbor, weight] of graph.adjacency.get(node) ?? []) {
      if (partition[neighbor] === community) {
        internal.set(community, (internal.get(community) ?? 0) + weight);
      }
    }
  });
  const denominator = 2 * graph.totalWeight;
  return [...totals].reduce((sum, [community, total]) => {
    const inside = (internal.get(community) ?? 0) / denominator;
    return sum + inside - resolution * (total / denominator) ** 2;
  }, 0);
}

function aggregate(
  graph: LevelGraph,
  groups: readonly (readonly string[])[],
): LevelGraph {
  const membership = new Map<string, number>();
  groups.forEach((members, group) => {
    members.forEach((member) => {
      membership.set(member, group);
    });
  });
  const oldGroup = graph.members.map((members) =>
    required(
      membership.get(required(members[0], "aggregate member")),
      "aggregate group",
    ),
  );
  const weights = new Map<string, number>();
  for (const [source, neighbors] of graph.adjacency) {
    for (const [target, weight] of neighbors) {
      if (source > target) continue;
      const a = required(oldGroup[source], "aggregate source");
      const b = required(oldGroup[target], "aggregate target");
      const [left, right] = a <= b ? [a, b] : [b, a];
      const key = `${left}:${right}`;
      weights.set(
        key,
        (weights.get(key) ?? 0) + (source === target ? weight / 2 : weight),
      );
    }
  }
  const projected: ProjectedEdge[] = [...weights].map(([key, weight]) => {
    const [left, right] = key.split(":").map(Number);
    return {
      edgeIds: [],
      evidenceIds: [],
      sourceNodeId: String(left),
      targetNodeId: String(right),
      weight,
    };
  });
  const result = levelGraph(
    groups.map((_, index) => String(index)),
    projected,
  );
  return { ...result, members: groups };
}

function partitionGraph(
  projection: WeightedProjection,
  budget: AnalyticsBudget,
  resolution: number,
  seed: number,
): {
  hierarchy: CommunityLevel[];
  iterationLimited: boolean;
  levelLimited: boolean;
} {
  let graph = levelGraph(projection.nodeIds, projection.edges);
  let initialPartition: readonly number[] | undefined;
  const hierarchy: CommunityLevel[] = [];
  let iterationLimited = false;
  let levelLimited = false;
  for (let level = 0; level < budget.maxLevels; level += 1) {
    const moved = localMove(
      graph,
      seed + level,
      resolution,
      budget.maxIterations,
      budget.tolerance,
      initialPartition,
    );
    iterationLimited ||= moved.limited;
    const coarse = connectedRefinement(graph, moved.partition);
    const coarseGroups = groupedMembers(graph, coarse);
    const refined = connectedRefinement(
      graph,
      leidenRefinement(
        graph,
        coarse,
        seed + level,
        resolution,
        budget.tolerance,
      ),
    );
    const refinedGroups = groupedMembers(graph, refined);
    hierarchy.push({
      communities: coarseGroups,
      level,
      modularity: modularity(graph, coarse, resolution),
    });
    if (
      refinedGroups.length === graph.members.length ||
      coarseGroups.length <= 1
    ) {
      break;
    }
    const coarseByMember = new Map<string, number>();
    coarse.forEach((community, node) => {
      for (const member of graph.members[node] ?? []) {
        coarseByMember.set(member, community);
      }
    });
    const normalized = new Map<number, number>();
    initialPartition = refinedGroups.map((members) => {
      const coarseCommunity = required(
        coarseByMember.get(required(members[0], "refined member")),
        "coarse community",
      );
      if (!normalized.has(coarseCommunity)) {
        normalized.set(coarseCommunity, normalized.size);
      }
      return required(
        normalized.get(coarseCommunity),
        "normalized coarse community",
      );
    });
    graph = aggregate(graph, refinedGroups);
    if (level + 1 === budget.maxLevels) levelLimited = true;
  }
  return { hierarchy, iterationLimited, levelLimited };
}

function betweenness(
  projection: WeightedProjection,
  maxSources: number,
): ReadonlyMap<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const nodeId of projection.nodeIds) adjacency.set(nodeId, []);
  for (const edge of projection.edges) {
    if (edge.weight <= 0 || edge.sourceNodeId === edge.targetNodeId) continue;
    adjacency.get(edge.sourceNodeId)?.push(edge.targetNodeId);
    adjacency.get(edge.targetNodeId)?.push(edge.sourceNodeId);
  }
  for (const neighbors of adjacency.values()) neighbors.sort();
  const scores = new Map(projection.nodeIds.map((nodeId) => [nodeId, 0]));
  const sources = projection.nodeIds.slice(0, maxSources);
  for (const source of sources) {
    const stack: string[] = [];
    const predecessors = new Map(
      projection.nodeIds.map((nodeId) => [nodeId, [] as string[]]),
    );
    const paths = new Map(projection.nodeIds.map((nodeId) => [nodeId, 0]));
    const distance = new Map(projection.nodeIds.map((nodeId) => [nodeId, -1]));
    paths.set(source, 1);
    distance.set(source, 0);
    const queue = [source];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const node = required(queue[cursor], "centrality queue");
      stack.push(node);
      for (const neighbor of adjacency.get(node) ?? []) {
        if (distance.get(neighbor) === -1) {
          distance.set(neighbor, (distance.get(node) ?? 0) + 1);
          queue.push(neighbor);
        }
        if (distance.get(neighbor) === (distance.get(node) ?? 0) + 1) {
          paths.set(
            neighbor,
            (paths.get(neighbor) ?? 0) + (paths.get(node) ?? 0),
          );
          predecessors.get(neighbor)?.push(node);
        }
      }
    }
    const dependency = new Map(projection.nodeIds.map((nodeId) => [nodeId, 0]));
    while (stack.length > 0) {
      const node = required(stack.pop(), "centrality stack");
      for (const predecessor of predecessors.get(node) ?? []) {
        const nodePaths = paths.get(node) ?? 0;
        if (nodePaths > 0) {
          dependency.set(
            predecessor,
            (dependency.get(predecessor) ?? 0) +
              ((paths.get(predecessor) ?? 0) / nodePaths) *
                (1 + (dependency.get(node) ?? 0)),
          );
        }
      }
      if (node !== source) {
        scores.set(node, (scores.get(node) ?? 0) + (dependency.get(node) ?? 0));
      }
    }
  }
  const denominator =
    projection.nodeIds.length > 2
      ? (projection.nodeIds.length - 1) * (projection.nodeIds.length - 2)
      : 1;
  const sampleScale =
    sources.length > 0 ? projection.nodeIds.length / sources.length : 1;
  for (const [nodeId, score] of scores) {
    scores.set(nodeId, (score * sampleScale) / denominator);
  }
  return scores;
}

function centrality(
  snapshot: ReturnType<typeof GraphSnapshotSchema.parse>,
  projection: WeightedProjection,
  budget: AnalyticsBudget,
): {
  betweennessLimited: boolean;
  pageRankLimited: boolean;
  values: NodeCentrality[];
} {
  const selected = new Set(projection.nodeIds);
  const evidence = new Map<string, number>();
  for (const item of snapshot.evidence) {
    evidence.set(
      item.edgeId,
      (evidence.get(item.edgeId) ?? 0) + item.confidence,
    );
  }
  const directed = snapshot.edges
    .filter(
      (edge) =>
        selected.has(edge.sourceNodeId) && selected.has(edge.targetNodeId),
    )
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId))
    .slice(0, budget.maxEdges);
  const out = new Map<string, Map<string, number>>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of directed) {
    const weight =
      (evidence.get(edge.edgeId) ?? 0) * STATUS_WEIGHT[edge.resolutionStatus];
    const targets = out.get(edge.sourceNodeId) ?? new Map<string, number>();
    targets.set(
      edge.targetNodeId,
      (targets.get(edge.targetNodeId) ?? 0) + weight,
    );
    out.set(edge.sourceNodeId, targets);
    incoming.set(edge.targetNodeId, (incoming.get(edge.targetNodeId) ?? 0) + 1);
    outgoing.set(edge.sourceNodeId, (outgoing.get(edge.sourceNodeId) ?? 0) + 1);
  }
  const size = Math.max(1, projection.nodeIds.length);
  let ranks = new Map(projection.nodeIds.map((nodeId) => [nodeId, 1 / size]));
  let pageRankConverged = projection.nodeIds.length === 0;
  for (
    let iteration = 0;
    iteration < budget.pagerankIterations;
    iteration += 1
  ) {
    const next = new Map(
      projection.nodeIds.map((nodeId) => [nodeId, 0.15 / size]),
    );
    let dangling = 0;
    for (const nodeId of projection.nodeIds) {
      const targets = out.get(nodeId);
      const total = [...(targets?.values() ?? [])].reduce(
        (sum, value) => sum + value,
        0,
      );
      if (!targets || total <= 0) {
        dangling += ranks.get(nodeId) ?? 0;
        continue;
      }
      for (const [target, weight] of targets) {
        next.set(
          target,
          (next.get(target) ?? 0) +
            0.85 * (ranks.get(nodeId) ?? 0) * (weight / total),
        );
      }
    }
    const danglingShare = (0.85 * dangling) / size;
    let delta = 0;
    for (const nodeId of projection.nodeIds) {
      const value = (next.get(nodeId) ?? 0) + danglingShare;
      delta += Math.abs(value - (ranks.get(nodeId) ?? 0));
      next.set(nodeId, value);
    }
    ranks = next;
    if (delta <= budget.tolerance) {
      pageRankConverged = true;
      break;
    }
  }
  const projectedNeighbors = new Map<string, Set<string>>();
  const weighted = new Map<string, number>();
  for (const edge of projection.edges) {
    projectedNeighbors.set(
      edge.sourceNodeId,
      new Set([
        ...(projectedNeighbors.get(edge.sourceNodeId) ?? []),
        edge.targetNodeId,
      ]),
    );
    projectedNeighbors.set(
      edge.targetNodeId,
      new Set([
        ...(projectedNeighbors.get(edge.targetNodeId) ?? []),
        edge.sourceNodeId,
      ]),
    );
    weighted.set(
      edge.sourceNodeId,
      (weighted.get(edge.sourceNodeId) ?? 0) + edge.weight,
    );
    if (edge.targetNodeId !== edge.sourceNodeId) {
      weighted.set(
        edge.targetNodeId,
        (weighted.get(edge.targetNodeId) ?? 0) + edge.weight,
      );
    }
  }
  const between = betweenness(projection, budget.maxCentralitySources);
  return {
    betweennessLimited: projection.nodeIds.length > budget.maxCentralitySources,
    pageRankLimited: !pageRankConverged,
    values: projection.nodeIds.map((nodeId) => ({
      betweenness: between.get(nodeId) ?? 0,
      degree: projectedNeighbors.get(nodeId)?.size ?? 0,
      inDegree: incoming.get(nodeId) ?? 0,
      nodeId,
      outDegree: outgoing.get(nodeId) ?? 0,
      pageRank: ranks.get(nodeId) ?? 0,
      weightedDegree: weighted.get(nodeId) ?? 0,
    })),
  };
}

function tokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((item) => item.toLowerCase())
    .filter(
      (item) => item.length > 1 && !["src", "index", "main"].includes(item),
    );
}

function communities(
  snapshot: ReturnType<typeof GraphSnapshotSchema.parse>,
  projection: WeightedProjection,
  hierarchy: readonly CommunityLevel[],
  resolution: number,
  seed: number,
): AnalyticsCommunity[] {
  const finalLevel = hierarchy.at(-1) ?? {
    communities: projection.nodeIds.map((nodeId) => [nodeId]),
    level: 0,
    modularity: 0,
  };
  const nodeById = new Map(snapshot.nodes.map((node) => [node.nodeId, node]));
  const adjacency = levelGraph(projection.nodeIds, projection.edges).adjacency;
  return finalLevel.communities.map((membersInput) => {
    const memberIds = [...membersInput].sort();
    const membershipFingerprint = hash(stableJson(memberIds));
    const communityId = createIdentity("community", {
      algorithm: ANALYTICS_ALGORITHM,
      algorithmVersion: ANALYTICS_VERSION,
      membershipFingerprint,
      projectionFingerprint: projection.fingerprint,
      resolution,
      seed,
    });
    const wordCounts = new Map<string, number>();
    const kindCounts = new Map<string, number>();
    for (const memberId of memberIds) {
      const node = nodeById.get(memberId);
      if (!node) continue;
      kindCounts.set(node.kind, (kindCounts.get(node.kind) ?? 0) + 1);
      for (const token of new Set(tokens(node.canonicalName))) {
        wordCounts.set(token, (wordCounts.get(token) ?? 0) + 1);
      }
    }
    const label =
      [...wordCounts]
        .sort(
          (left, right) =>
            right[1] - left[1] || left[0].localeCompare(right[0]),
        )
        .slice(0, 3)
        .map(([word]) => word)
        .join(" / ") ||
      [...kindCounts].sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )[0]?.[0] ||
      "empty";
    const kinds = [...kindCounts]
      .sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ");
    const relationKinds = new Map<string, number>();
    const memberSet = new Set(memberIds);
    const selectedEdgeIds = new Set(
      projection.edges.flatMap((edge) => edge.edgeIds),
    );
    for (const edge of snapshot.edges) {
      if (
        selectedEdgeIds.has(edge.edgeId) &&
        memberSet.has(edge.sourceNodeId) &&
        memberSet.has(edge.targetNodeId)
      ) {
        relationKinds.set(edge.kind, (relationKinds.get(edge.kind) ?? 0) + 1);
      }
    }
    const relations = [...relationKinds]
      .sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )
      .slice(0, 3)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ");
    const content = `${memberIds.length} nodes (${kinds || "no typed nodes"}); internal relations: ${relations || "none"}.`;
    const contentDigest = hash(content);
    const cacheKey = hash(
      stableJson({
        evidenceFingerprint: projection.evidenceFingerprint,
        membershipFingerprint,
        summaryVersion: 1,
      }),
    );
    const summaryId = createIdentity("summary", {
      cacheKey,
      communityId,
      contentDigest,
      kind: "deterministic-community",
    });
    const connected =
      memberIds.length <= 1 ||
      (() => {
        const start = required(memberIds[0], "community member");
        const visited = new Set([start]);
        const queue = [start];
        for (let cursor = 0; cursor < queue.length; cursor += 1) {
          for (const neighbor of adjacency
            .get(
              projection.nodeIds.indexOf(
                required(queue[cursor], "connectivity queue"),
              ),
            )
            ?.keys() ?? []) {
            const nodeId = required(
              projection.nodeIds[neighbor],
              "connectivity neighbor",
            );
            if (memberSet.has(nodeId) && !visited.has(nodeId)) {
              visited.add(nodeId);
              queue.push(nodeId);
            }
          }
        }
        return visited.size === memberIds.length;
      })();
    return {
      communityId,
      connected,
      label,
      level: finalLevel.level,
      memberIds,
      membershipFingerprint,
      summary: {
        cacheKey,
        content,
        contentDigest,
        evidenceFingerprint: projection.evidenceFingerprint,
        label,
        membershipFingerprint,
        summaryId,
      },
    };
  });
}

export function analyzeGraph(input: AnalyticsInput): GraphAnalyticsResult {
  const snapshot = GraphSnapshotSchema.parse(input.snapshot);
  const config = options(input.options);
  const projected = projectGraph(snapshot, config.budget);
  const partitioned = partitionGraph(
    projected.projection,
    config.budget,
    config.resolution,
    config.seed,
  );
  const central = centrality(snapshot, projected.projection, config.budget);
  const reasons = [...projected.coverage.reasons];
  if (central.betweennessLimited) reasons.push("centrality-budget");
  if (partitioned.iterationLimited || central.pageRankLimited) {
    reasons.push("iteration-budget");
  }
  if (partitioned.levelLimited) reasons.push("level-budget");
  const uniqueReasons = [...new Set(reasons)];
  return {
    algorithm: ANALYTICS_ALGORITHM,
    algorithmVersion: ANALYTICS_VERSION,
    centrality: central.values,
    communities: communities(
      snapshot,
      projected.projection,
      partitioned.hierarchy,
      config.resolution,
      config.seed,
    ),
    coverage: {
      ...projected.coverage,
      reasons: uniqueReasons,
      truncated: uniqueReasons.length > 0,
    },
    hierarchy: partitioned.hierarchy,
    projection: projected.projection,
    resolution: config.resolution,
    scope: snapshot.scope,
    seed: config.seed,
  };
}

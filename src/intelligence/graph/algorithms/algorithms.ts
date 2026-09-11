import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  GenerationIdSchema,
  RevisionIdSchema,
} from "../../contracts/common.ts";
import {
  GraphEdgeKindSchema,
  GraphNodeIdSchema,
  GraphNodeSchema,
  GraphRelationshipSchema,
  ResolutionStatusSchema,
  RevisionMembershipSchema,
} from "../../contracts/graph.ts";
import type {
  AlgorithmCoverage,
  AlgorithmMembership,
  AlgorithmNode,
  AlgorithmRelationship,
  BudgetReason,
  GraphAlgorithmBudget,
  GraphAlgorithmCursorCodec,
  GraphAlgorithmSnapshot,
  ImpactExpansionRequest,
  PageMetadata,
  ShortestPathRequest,
  ShortestPathResult,
  StronglyConnectedComponentsRequest,
  StronglyConnectedComponentsResult,
  TraversalRequest,
  TraversalResult,
} from "./types.ts";

type Item =
  | { kind: "node"; value: AlgorithmNode }
  | { kind: "relationship"; value: AlgorithmRelationship };

interface Prepared {
  digest: string;
  nodes: Map<string, AlgorithmNode>;
  relationships: AlgorithmRelationship[];
}

export interface GraphAlgorithmExecutionContext {
  deadline: number;
  exhaustedReasons: Set<BudgetReason>;
}

export function createGraphAlgorithmExecutionContext(
  budget: Pick<GraphAlgorithmBudget, "maxMilliseconds">,
  exhaustedReasons: Set<BudgetReason> = new Set(),
): GraphAlgorithmExecutionContext {
  return {
    deadline: performance.now() + budget.maxMilliseconds,
    exhaustedReasons,
  };
}

function isExpired(context: GraphAlgorithmExecutionContext): boolean {
  if (performance.now() < context.deadline) return false;
  context.exhaustedReasons.add("milliseconds");
  return true;
}

function compareNode(left: AlgorithmNode, right: AlgorithmNode): number {
  return (
    left.canonicalName.localeCompare(right.canonicalName) ||
    left.kind.localeCompare(right.kind) ||
    left.nodeId.localeCompare(right.nodeId)
  );
}

function compareRelationship(
  left: AlgorithmRelationship,
  right: AlgorithmRelationship,
): number {
  return (
    left.edge.sourceNodeId.localeCompare(right.edge.sourceNodeId) ||
    left.edge.targetNodeId.localeCompare(right.edge.targetNodeId) ||
    left.edge.kind.localeCompare(right.edge.kind) ||
    left.edge.discriminator.localeCompare(right.edge.discriminator) ||
    left.edge.edgeId.localeCompare(right.edge.edgeId)
  );
}

export class GraphAlgorithmInputError extends TypeError {
  readonly code = "invalid-graph-algorithm-request";

  constructor(message: string) {
    super(message);
    this.name = "GraphAlgorithmInputError";
  }
}

const budgetKeys = [
  "maxBytes",
  "maxDepth",
  "maxEdges",
  "maxMilliseconds",
  "maxNodes",
  "pageSize",
] as const;

function exactObject(
  value: unknown,
  required: readonly string[],
  allowed: readonly string[] = required,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.includes(key))
  );
}

function validateBudget(value: unknown): asserts value is GraphAlgorithmBudget {
  if (!exactObject(value, budgetKeys)) {
    throw new GraphAlgorithmInputError("Invalid graph algorithm budget shape");
  }
  for (const key of budgetKeys) {
    const entry = value[key];
    if (!Number.isSafeInteger(entry) || Number(entry) < 0)
      throw new GraphAlgorithmInputError(
        `${key} must be a nonnegative safe integer`,
      );
  }
  if (value.pageSize === 0)
    throw new GraphAlgorithmInputError("pageSize must be positive");
}

function validateSnapshot(
  value: unknown,
): asserts value is GraphAlgorithmSnapshot {
  if (
    !exactObject(value, [
      "generationId",
      "memberships",
      "nodes",
      "relationships",
      "revisionId",
    ]) ||
    !GenerationIdSchema.safeParse(value.generationId).success ||
    !RevisionIdSchema.safeParse(value.revisionId).success ||
    !Array.isArray(value.nodes) ||
    !value.nodes.every((entry) => GraphNodeSchema.safeParse(entry).success) ||
    !Array.isArray(value.relationships) ||
    !value.relationships.every(
      (entry) => GraphRelationshipSchema.safeParse(entry).success,
    ) ||
    !Array.isArray(value.memberships) ||
    !value.memberships.every(
      (entry) => RevisionMembershipSchema.safeParse(entry).success,
    )
  ) {
    throw new GraphAlgorithmInputError("Invalid graph algorithm snapshot");
  }
}

function validateStringArray(
  value: unknown,
  validator: { safeParse(value: unknown): { success: boolean } },
  label: string,
): void {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => validator.safeParse(entry).success)
  )
    throw new GraphAlgorithmInputError(`Invalid ${label}`);
}

function validatePublicRequest(
  value: unknown,
  kind: "impact" | "path" | "scc" | "traverse",
): void {
  const common = ["budget", "snapshot"];
  const optional = ["cursor", "edgeKinds", "resolutionStatuses"];
  const required =
    kind === "scc"
      ? common
      : kind === "path"
        ? [...common, "direction", "sourceNodeId", "targetNodeId"]
        : [
            ...common,
            "startNodeIds",
            ...(kind === "traverse" ? ["direction"] : []),
          ];
  const allowed = [
    ...required,
    ...optional,
    ...(kind === "impact" ? ["direction"] : []),
  ];
  if (!exactObject(value, required, allowed))
    throw new GraphAlgorithmInputError("Invalid graph algorithm request shape");
  validateBudget(value.budget);
  validateSnapshot(value.snapshot);
  if (
    value.cursor !== undefined &&
    (typeof value.cursor !== "string" || !value.cursor)
  )
    throw new GraphAlgorithmInputError("Invalid graph algorithm cursor");
  if (
    value.direction !== undefined &&
    value.direction !== "forward" &&
    value.direction !== "reverse"
  )
    throw new GraphAlgorithmInputError("Invalid graph direction");
  if (value.edgeKinds !== undefined)
    validateStringArray(value.edgeKinds, GraphEdgeKindSchema, "edge kinds");
  if (value.resolutionStatuses !== undefined)
    validateStringArray(
      value.resolutionStatuses,
      ResolutionStatusSchema,
      "resolution statuses",
    );
  if (value.startNodeIds !== undefined)
    validateStringArray(
      value.startNodeIds,
      GraphNodeIdSchema,
      "start node IDs",
    );
  for (const key of ["sourceNodeId", "targetNodeId"])
    if (
      value[key] !== undefined &&
      !GraphNodeIdSchema.safeParse(value[key]).success
    )
      throw new GraphAlgorithmInputError(`Invalid ${key}`);
}

function membershipSet(
  memberships: readonly AlgorithmMembership[],
  revisionId: string,
  generationId: string,
  kind: AlgorithmMembership["entityKind"],
  context: GraphAlgorithmExecutionContext,
): Set<string> {
  const entityIds = new Set<string>();
  for (const entry of memberships) {
    if (isExpired(context)) break;
    if (
      entry.revisionId === revisionId &&
      entry.generationId === generationId &&
      entry.entityKind === kind
    )
      entityIds.add(entry.entityId);
  }
  return entityIds;
}

function prepare(
  snapshot: GraphAlgorithmSnapshot,
  edgeKinds: readonly AlgorithmRelationship["edge"]["kind"][] | undefined,
  statuses:
    | readonly AlgorithmRelationship["edge"]["resolutionStatus"][]
    | undefined,
  context: GraphAlgorithmExecutionContext,
): Prepared {
  const activeNodes = membershipSet(
    snapshot.memberships,
    snapshot.revisionId,
    snapshot.generationId,
    "node",
    context,
  );
  const activeEdges = membershipSet(
    snapshot.memberships,
    snapshot.revisionId,
    snapshot.generationId,
    "edge",
    context,
  );
  const activeOccurrences = membershipSet(
    snapshot.memberships,
    snapshot.revisionId,
    snapshot.generationId,
    "occurrence",
    context,
  );
  const activeEvidence = membershipSet(
    snapshot.memberships,
    snapshot.revisionId,
    snapshot.generationId,
    "evidence",
    context,
  );
  const selectedNodes: AlgorithmNode[] = [];
  for (const node of snapshot.nodes) {
    if (isExpired(context)) break;
    if (activeNodes.has(node.nodeId)) selectedNodes.push(node);
  }
  if (!isExpired(context)) selectedNodes.sort(compareNode);
  const nodes = new Map<string, AlgorithmNode>();
  for (const node of selectedNodes) {
    if (isExpired(context)) break;
    nodes.set(node.nodeId, node);
  }
  const kinds = edgeKinds ? new Set(edgeKinds) : undefined;
  const resolutions = statuses ? new Set(statuses) : undefined;
  const relationships: AlgorithmRelationship[] = [];
  for (const relationship of snapshot.relationships) {
    if (isExpired(context)) break;
    const { edge } = relationship;
    if (
      !activeEdges.has(edge.edgeId) ||
      !nodes.has(edge.sourceNodeId) ||
      !nodes.has(edge.targetNodeId) ||
      (kinds && !kinds.has(edge.kind)) ||
      (resolutions && !resolutions.has(edge.resolutionStatus))
    )
      continue;
    const evidence: AlgorithmRelationship["evidence"] = [];
    for (const item of relationship.evidence) {
      if (isExpired(context)) break;
      if (activeEvidence.has(item.evidenceId)) evidence.push(item);
    }
    const occurrences: AlgorithmRelationship["occurrences"] = [];
    for (const item of relationship.occurrences) {
      if (isExpired(context)) break;
      if (activeOccurrences.has(item.occurrenceId)) occurrences.push(item);
    }
    if (isExpired(context)) break;
    if (evidence.length > 0 && occurrences.length > 0)
      relationships.push({ ...relationship, evidence, occurrences });
  }
  if (!isExpired(context)) relationships.sort(compareRelationship);
  const activeMemberships: AlgorithmMembership[] = [];
  for (const entry of snapshot.memberships) {
    if (isExpired(context)) break;
    if (
      entry.revisionId === snapshot.revisionId &&
      entry.generationId === snapshot.generationId
    )
      activeMemberships.push(entry);
  }
  if (!isExpired(context))
    activeMemberships.sort((left, right) =>
      left.membershipId.localeCompare(right.membershipId),
    );
  return {
    digest: isExpired(context)
      ? ""
      : fingerprint({
          memberships: activeMemberships,
          nodes: [...nodes.values()],
          relationships,
        }),
    nodes,
    relationships,
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const cursorDomain = "ast-mcp.graph-algorithm-cursor.v2";
const processCursorKey = randomBytes(32);

// The process-local key intentionally makes cursors expire after a process restart.
const processCursorCodec: GraphAlgorithmCursorCodec = {
  decode(cursor, binding) {
    const parts = cursor.split(".");
    if (parts.length !== 2) throw new Error("Invalid cursor envelope");
    const [payload, signature] = parts;
    if (!payload || !signature || !/^[a-f0-9]{64}$/.test(signature))
      throw new Error("Invalid cursor envelope");
    const expected = createHmac("sha256", processCursorKey)
      .update(cursorDomain)
      .update("\0")
      .update(binding)
      .update("\0")
      .update(payload)
      .digest();
    const received = Buffer.from(signature, "hex");
    if (
      received.byteLength !== expected.byteLength ||
      !timingSafeEqual(received, expected)
    )
      throw new Error("Invalid cursor authentication");
    return JSON.parse(Buffer.from(payload, "base64url").toString());
  },
  encode(value, binding) {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    const signature = createHmac("sha256", processCursorKey)
      .update(cursorDomain)
      .update("\0")
      .update(binding)
      .update("\0")
      .update(payload)
      .digest("hex");
    return `${payload}.${signature}`;
  },
};

function decodeCursor(
  cursor: string | undefined,
  expected: string,
  codec: GraphAlgorithmCursorCodec,
): number {
  if (!cursor) return 0;
  try {
    const value = codec.decode(cursor, expected);
    if (
      !exactObject(value, ["offset"]) ||
      !Number.isSafeInteger(value.offset) ||
      Number(value.offset) < 0
    )
      throw new Error("Invalid cursor payload");
    return Number(value.offset);
  } catch {
    throw new GraphAlgorithmInputError(
      "Invalid, tampered, or stale graph algorithm cursor",
    );
  }
}

function encodeCursor(
  fingerprintValue: string,
  offset: number,
  codec: GraphAlgorithmCursorCodec,
): string {
  return codec.encode({ offset }, fingerprintValue);
}

function coverage(
  snapshot: GraphAlgorithmSnapshot,
  discoveredNodes: number,
  consideredEdges: number,
  reasons: Set<BudgetReason>,
): AlgorithmCoverage {
  return {
    consideredEdges,
    discoveredNodes,
    exhaustedReasons: [...reasons].sort(),
    generationId: snapshot.generationId,
    revisionId: snapshot.revisionId,
  };
}

function paginate(
  items: readonly Item[],
  budget: GraphAlgorithmBudget,
  cursor: string | undefined,
  cursorFingerprint: string,
  reasons: Set<BudgetReason>,
  cursorCodec: GraphAlgorithmCursorCodec,
): { items: Item[]; page: PageMetadata } {
  const offset = decodeCursor(cursor, cursorFingerprint, cursorCodec);
  if (offset > items.length)
    throw new GraphAlgorithmInputError(
      "Graph algorithm cursor offset exceeds result bounds",
    );
  const end = Math.min(offset + budget.pageSize, items.length);
  const hasMore = end < items.length;
  if (hasMore) reasons.add("page");
  return {
    items: items.slice(offset, end),
    page: {
      cursor: hasMore
        ? encodeCursor(cursorFingerprint, end, cursorCodec)
        : null,
      exhaustive: reasons.size === 0,
      truncated: reasons.size > 0,
    },
  };
}

function traverseItems(
  request: TraversalRequest,
  context: GraphAlgorithmExecutionContext,
): {
  consideredEdges: number;
  discovered: Set<string>;
  items: Item[];
  prepared: Prepared;
} {
  validateBudget(request.budget);
  const prepared = prepare(
    request.snapshot,
    request.edgeKinds,
    request.resolutionStatuses,
    context,
  );
  const { exhaustedReasons: reasons } = context;
  const discovered = new Set<string>();
  const emittedEdges = new Set<string>();
  const items: Item[] = [];
  let consideredEdges = 0;
  let bytes = 0;
  const starts = new Set(request.startNodeIds);
  let frontier: string[] = [];
  for (const id of starts) {
    if (isExpired(context)) break;
    if (prepared.nodes.has(id)) frontier.push(id);
  }
  if (!isExpired(context)) frontier.sort();
  let depth = 0;
  const emit = (item: Item): boolean => {
    if (isExpired(context)) return false;
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > request.budget.maxBytes) {
      reasons.add("bytes");
      return false;
    }
    bytes += size;
    items.push(item);
    return true;
  };
  while (frontier.length > 0 && !isExpired(context)) {
    if (depth > request.budget.maxDepth) {
      reasons.add("depth");
      break;
    }
    const next = new Set<string>();
    for (const nodeId of frontier) {
      if (isExpired(context)) break;
      if (discovered.has(nodeId)) continue;
      if (discovered.size >= request.budget.maxNodes) {
        reasons.add("nodes");
        break;
      }
      const node = prepared.nodes.get(nodeId);
      if (!node || !emit({ kind: "node", value: node })) break;
      discovered.add(nodeId);
      for (const relationship of prepared.relationships) {
        if (isExpired(context)) break;
        const matches =
          request.direction === "forward"
            ? relationship.edge.sourceNodeId === nodeId
            : relationship.edge.targetNodeId === nodeId;
        if (!matches) continue;
        if (consideredEdges >= request.budget.maxEdges) {
          reasons.add("edges");
          break;
        }
        consideredEdges++;
        if (!emittedEdges.has(relationship.edge.edgeId)) {
          if (!emit({ kind: "relationship", value: relationship })) break;
          emittedEdges.add(relationship.edge.edgeId);
        }
        next.add(
          request.direction === "forward"
            ? relationship.edge.targetNodeId
            : relationship.edge.sourceNodeId,
        );
      }
      if (
        reasons.has("bytes") ||
        reasons.has("edges") ||
        reasons.has("milliseconds") ||
        reasons.has("nodes")
      )
        break;
    }
    if (
      reasons.has("bytes") ||
      reasons.has("edges") ||
      reasons.has("milliseconds") ||
      reasons.has("nodes")
    )
      break;
    frontier = [...next];
    if (!isExpired(context)) frontier.sort();
    depth++;
  }
  return { consideredEdges, discovered, items, prepared };
}

export function traverseGraph(
  request: TraversalRequest,
  cursorCodec: GraphAlgorithmCursorCodec = processCursorCodec,
  context: GraphAlgorithmExecutionContext = createGraphAlgorithmExecutionContext(
    request.budget,
  ),
): TraversalResult {
  if (isExpired(context))
    return {
      coverage: coverage(request.snapshot, 0, 0, context.exhaustedReasons),
      nodes: [],
      page: { cursor: null, exhaustive: false, truncated: true },
      relationships: [],
    };
  validatePublicRequest(request, "traverse");
  const traversal = traverseItems(request, context);
  const cursorFingerprint = fingerprint({
    activeDigest: traversal.prepared.digest,
    algorithm: "traverse",
    budget: request.budget,
    direction: request.direction,
    edgeKinds: request.edgeKinds,
    generationId: request.snapshot.generationId,
    resolutionStatuses: request.resolutionStatuses,
    resultDigest: fingerprint(traversal.items),
    revisionId: request.snapshot.revisionId,
    starts: [...request.startNodeIds].sort(),
  });
  const page = paginate(
    traversal.items,
    request.budget,
    request.cursor,
    cursorFingerprint,
    context.exhaustedReasons,
    cursorCodec,
  );
  const nodes: AlgorithmNode[] = [];
  const relationships: AlgorithmRelationship[] = [];
  for (const item of page.items) {
    if (isExpired(context)) break;
    if (item.kind === "node") nodes.push(item.value);
    else relationships.push(item.value);
  }
  return {
    coverage: coverage(
      request.snapshot,
      traversal.discovered.size,
      traversal.consideredEdges,
      context.exhaustedReasons,
    ),
    nodes,
    page: {
      ...page.page,
      exhaustive: context.exhaustedReasons.size === 0,
      truncated: context.exhaustedReasons.size > 0,
    },
    relationships,
  };
}

export function expandImpact(
  request: ImpactExpansionRequest,
  cursorCodec: GraphAlgorithmCursorCodec = processCursorCodec,
  context: GraphAlgorithmExecutionContext = createGraphAlgorithmExecutionContext(
    request.budget,
  ),
): TraversalResult {
  validatePublicRequest(request, "impact");
  return traverseGraph(
    {
      ...request,
      direction: request.direction ?? "reverse",
    },
    cursorCodec,
    context,
  );
}

export function shortestPath(
  request: ShortestPathRequest,
  context: GraphAlgorithmExecutionContext = createGraphAlgorithmExecutionContext(
    request.budget,
  ),
): ShortestPathResult {
  if (isExpired(context))
    return {
      coverage: coverage(request.snapshot, 0, 0, context.exhaustedReasons),
      found: false,
      nodes: [],
      page: { cursor: null, exhaustive: false, truncated: true },
      relationships: [],
    };
  validatePublicRequest(request, "path");
  const traversal = traverseItems(
    {
      ...request,
      direction: request.direction,
      startNodeIds: [request.sourceNodeId],
    },
    context,
  );
  const relationships: AlgorithmRelationship[] = [];
  for (const item of traversal.items) {
    if (isExpired(context)) break;
    if (item.kind === "relationship") relationships.push(item.value);
  }
  const byTarget = new Map<string, AlgorithmRelationship>();
  for (const relationship of relationships) {
    if (isExpired(context)) break;
    const target =
      request.direction === "forward"
        ? relationship.edge.targetNodeId
        : relationship.edge.sourceNodeId;
    if (traversal.discovered.has(target) && !byTarget.has(target))
      byTarget.set(target, relationship);
  }
  const path: AlgorithmRelationship[] = [];
  let current = request.targetNodeId;
  while (current !== request.sourceNodeId && !isExpired(context)) {
    const edge = byTarget.get(current);
    if (!edge) break;
    path.unshift(edge);
    current =
      request.direction === "forward"
        ? edge.edge.sourceNodeId
        : edge.edge.targetNodeId;
  }
  const found =
    traversal.prepared.nodes.has(request.sourceNodeId) &&
    traversal.prepared.nodes.has(request.targetNodeId) &&
    current === request.sourceNodeId &&
    !context.exhaustedReasons.has("milliseconds");
  const nodes: AlgorithmNode[] = [];
  if (found) {
    const nodeIds = [
      request.sourceNodeId,
      ...path.map((relationship) =>
        request.direction === "forward"
          ? relationship.edge.targetNodeId
          : relationship.edge.sourceNodeId,
      ),
    ];
    for (const id of nodeIds) {
      if (isExpired(context)) break;
      const node = traversal.prepared.nodes.get(id);
      if (node) nodes.push(node);
    }
  }
  return {
    coverage: coverage(
      request.snapshot,
      traversal.discovered.size,
      traversal.consideredEdges,
      context.exhaustedReasons,
    ),
    found: found && !context.exhaustedReasons.has("milliseconds"),
    nodes,
    page: {
      cursor: null,
      exhaustive: context.exhaustedReasons.size === 0,
      truncated: context.exhaustedReasons.size > 0,
    },
    relationships: found ? path : [],
  };
}

export function stronglyConnectedComponents(
  request: StronglyConnectedComponentsRequest,
  cursorCodec: GraphAlgorithmCursorCodec = processCursorCodec,
  context: GraphAlgorithmExecutionContext = createGraphAlgorithmExecutionContext(
    request.budget,
  ),
): StronglyConnectedComponentsResult {
  if (isExpired(context))
    return {
      components: [],
      coverage: coverage(request.snapshot, 0, 0, context.exhaustedReasons),
      page: { cursor: null, exhaustive: false, truncated: true },
    };
  validatePublicRequest(request, "scc");
  const prepared = prepare(
    request.snapshot,
    request.edgeKinds,
    request.resolutionStatuses,
    context,
  );
  const { exhaustedReasons: reasons } = context;
  const nodes: AlgorithmNode[] = [];
  for (const node of prepared.nodes.values()) {
    if (isExpired(context)) break;
    if (nodes.length >= request.budget.maxNodes) {
      reasons.add("nodes");
      break;
    }
    nodes.push(node);
  }
  if (!isExpired(context)) nodes.sort(compareNode);
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (isExpired(context)) break;
    nodeIds.add(node.nodeId);
  }
  const edges: AlgorithmRelationship[] = [];
  for (const relationship of prepared.relationships) {
    if (isExpired(context)) break;
    if (
      !nodeIds.has(relationship.edge.sourceNodeId) ||
      !nodeIds.has(relationship.edge.targetNodeId)
    )
      continue;
    if (edges.length >= request.budget.maxEdges) {
      reasons.add("edges");
      break;
    }
    edges.push(relationship);
  }
  const adjacency = new Map<string, string[]>();
  for (const { edge } of edges) {
    if (isExpired(context)) break;
    const targets = adjacency.get(edge.sourceNodeId) ?? [];
    targets.push(edge.targetNodeId);
    adjacency.set(edge.sourceNodeId, targets);
  }
  for (const targets of adjacency.values()) {
    if (isExpired(context)) break;
    targets.sort();
  }
  let index = 0;
  let visitedEdges = 0;
  let completedNodes = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: AlgorithmNode[][] = [];
  const abortVisit = (id: string): false => {
    const position = stack.lastIndexOf(id);
    if (position >= 0) stack.splice(position, 1);
    onStack.delete(id);
    return false;
  };
  const visit = (id: string, depth: number): boolean => {
    if (isExpired(context)) return false;
    if (depth > request.budget.maxDepth) {
      reasons.add("depth");
      return false;
    }
    indices.set(id, index);
    low.set(id, index++);
    stack.push(id);
    onStack.add(id);
    for (const target of adjacency.get(id) ?? []) {
      if (isExpired(context)) return abortVisit(id);
      visitedEdges++;
      if (!indices.has(target)) {
        if (!visit(target, depth + 1)) return abortVisit(id);
        const targetLow = low.get(target);
        if (targetLow === undefined) return abortVisit(id);
        low.set(id, Math.min(low.get(id) ?? 0, targetLow));
      } else if (onStack.has(target)) {
        low.set(id, Math.min(low.get(id) ?? 0, indices.get(target) ?? 0));
      }
    }
    completedNodes++;
    if (low.get(id) !== indices.get(id)) return true;
    const component: AlgorithmNode[] = [];
    let member: string | undefined;
    do {
      if (isExpired(context)) return abortVisit(id);
      member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      const node = prepared.nodes.get(member);
      if (node) component.push(node);
    } while (member !== id);
    if (!isExpired(context)) component.sort(compareNode);
    components.push(component);
    return true;
  };
  for (const { nodeId } of nodes) {
    if (isExpired(context) || reasons.has("depth")) break;
    if (!indices.has(nodeId)) visit(nodeId, 0);
  }
  if (!isExpired(context))
    components.sort((left, right) =>
      (left[0]?.nodeId ?? "").localeCompare(right[0]?.nodeId ?? ""),
    );
  const cursorFingerprint = fingerprint({
    activeDigest: prepared.digest,
    algorithm: "scc",
    budget: request.budget,
    edgeKinds: request.edgeKinds,
    generationId: request.snapshot.generationId,
    resolutionStatuses: request.resolutionStatuses,
    resultDigest: fingerprint(components),
    revisionId: request.snapshot.revisionId,
  });
  const offset = decodeCursor(request.cursor, cursorFingerprint, cursorCodec);
  if (offset > components.length)
    throw new GraphAlgorithmInputError(
      "Graph algorithm cursor offset exceeds result bounds",
    );
  const selected: AlgorithmNode[][] = [];
  let serializedBytes = 0;
  let next = offset;
  while (
    next < components.length &&
    selected.length < request.budget.pageSize &&
    !isExpired(context)
  ) {
    const component = components[next];
    if (!component) break;
    const size = Buffer.byteLength(JSON.stringify(component));
    if (serializedBytes + size > request.budget.maxBytes) {
      reasons.add("bytes");
      break;
    }
    serializedBytes += size;
    selected.push(component);
    next++;
  }
  const hasMore =
    next < components.length &&
    !reasons.has("bytes") &&
    !reasons.has("milliseconds");
  if (hasMore) reasons.add("page");
  return {
    components: selected,
    coverage: coverage(request.snapshot, completedNodes, visitedEdges, reasons),
    page: {
      cursor: hasMore
        ? encodeCursor(cursorFingerprint, next, cursorCodec)
        : null,
      exhaustive: reasons.size === 0,
      truncated: reasons.size > 0,
    },
  };
}

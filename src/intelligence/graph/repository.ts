import {
  GraphEdgeSchema,
  GraphEvidenceSchema,
  GraphNodeSchema,
  GraphOccurrenceSchema,
  graphEdgeIdentity,
  graphEvidenceIdentity,
  graphNodeIdentity,
  graphOccurrenceIdentity,
  RevisionMembershipSchema,
  revisionMembershipIdentity,
} from "../contracts/graph.ts";
import type { PublicationReservation } from "../contracts/storage.ts";
import type {
  LanceIntelligenceStore,
  PinnedGenerationReader,
} from "../storage/store.ts";
import type { WorkspaceHandle } from "../workspace/context.ts";
import {
  assertWorkspaceWritable,
  currentWorkspace,
} from "../workspace/context.ts";
import type { BudgetReason } from "./algorithms/types.ts";
import type {
  GraphEdge,
  GraphEvidence,
  GraphNode,
  GraphScope,
  GraphSnapshot,
  RevisionMembership,
} from "./types.ts";
import { GraphScopeSchema, GraphSnapshotSchema } from "./types.ts";

type Row = Readonly<Record<string, unknown>>;

const legacyStorageNodeVersionPrefix = "graph-node-version:v1:";
const storageNodeVersionPrefix = "graph-node-version:v2:";

function encodeStoredNode(node: GraphNode): GraphNode {
  const logicalNodeId = Buffer.from(node.nodeId).toString("base64url");
  const logicalName = Buffer.from(node.canonicalName).toString("base64url");
  const canonicalName = `${storageNodeVersionPrefix}${logicalNodeId}:${node.contentFingerprint}:${logicalName}`;
  return GraphNodeSchema.parse({
    ...node,
    canonicalName,
    nodeId: graphNodeIdentity({ canonicalName, kind: node.kind }),
  });
}

function decodeStoredNode(node: GraphNode): GraphNode {
  if (node.canonicalName.startsWith(storageNodeVersionPrefix)) {
    const suffix = node.canonicalName.slice(storageNodeVersionPrefix.length);
    const fingerprintSeparator = suffix.indexOf(":");
    const nameSeparator = suffix.indexOf(":", fingerprintSeparator + 1);
    if (
      fingerprintSeparator < 1 ||
      nameSeparator < fingerprintSeparator + 2 ||
      suffix.slice(fingerprintSeparator + 1, nameSeparator) !==
        node.contentFingerprint
    )
      throw new Error("invalid_stored_graph_node_version");
    try {
      return GraphNodeSchema.parse({
        ...node,
        canonicalName: Buffer.from(
          suffix.slice(nameSeparator + 1),
          "base64url",
        ).toString(),
        nodeId: Buffer.from(
          suffix.slice(0, fingerprintSeparator),
          "base64url",
        ).toString(),
      });
    } catch {
      throw new Error("invalid_stored_graph_node_version");
    }
  }
  if (!node.canonicalName.startsWith(legacyStorageNodeVersionPrefix))
    return node;
  const suffix = node.canonicalName.slice(
    legacyStorageNodeVersionPrefix.length,
  );
  const separator = suffix.lastIndexOf(":");
  if (separator < 1 || suffix.slice(separator + 1) !== node.contentFingerprint)
    throw new Error("invalid_stored_graph_node_version");
  let coordinates: unknown;
  try {
    coordinates = JSON.parse(
      Buffer.from(suffix.slice(0, separator), "base64url").toString(),
    );
  } catch {
    throw new Error("invalid_stored_graph_node_version");
  }
  if (
    !Array.isArray(coordinates) ||
    coordinates.length !== 2 ||
    !coordinates.every((value) => typeof value === "string")
  )
    throw new Error("invalid_stored_graph_node_version");
  return GraphNodeSchema.parse({
    ...node,
    canonicalName: coordinates[0],
    nodeId: coordinates[1],
  });
}

function remapMemberships(
  memberships: readonly RevisionMembership[],
  entityIds: Readonly<
    Record<RevisionMembership["entityKind"], ReadonlyMap<string, string>>
  >,
): RevisionMembership[] {
  return memberships.map((membership) => {
    const entityId = entityIds[membership.entityKind].get(membership.entityId);
    if (!entityId) throw new Error("graph_storage_identity_missing");
    return RevisionMembershipSchema.parse({
      ...membership,
      entityId,
      membershipId: revisionMembershipIdentity({
        entityId,
        entityKind: membership.entityKind,
        generationId: membership.generationId,
        revisionId: membership.revisionId,
      }),
    });
  });
}

function encodeStoredSnapshot(snapshot: GraphSnapshot): GraphSnapshot {
  const nodeRecords = new Map(
    snapshot.nodes.map((node) => [node.nodeId, encodeStoredNode(node)]),
  );
  const occurrenceRecords = new Map(
    snapshot.occurrences.map((occurrence) => {
      const nodeId = nodeRecords.get(occurrence.nodeId)?.nodeId;
      if (!nodeId) throw new Error("graph_node_storage_identity_missing");
      const stored = GraphOccurrenceSchema.parse({
        ...occurrence,
        nodeId,
        occurrenceId: graphOccurrenceIdentity({
          nodeId,
          path: occurrence.path,
          range: occurrence.range,
          role: occurrence.role,
          sourceArtifactId: occurrence.sourceArtifactId,
        }),
      });
      return [occurrence.occurrenceId, stored];
    }),
  );
  const edgeRecords = new Map(
    snapshot.edges.map((edge) => {
      const sourceNodeId = nodeRecords.get(edge.sourceNodeId)?.nodeId;
      const targetNodeId = nodeRecords.get(edge.targetNodeId)?.nodeId;
      if (!sourceNodeId || !targetNodeId)
        throw new Error("graph_node_storage_identity_missing");
      const stored = GraphEdgeSchema.parse({
        ...edge,
        edgeId: graphEdgeIdentity({
          discriminator: edge.discriminator,
          kind: edge.kind,
          sourceNodeId,
          targetNodeId,
        }),
        sourceNodeId,
        targetNodeId,
      });
      return [edge.edgeId, stored];
    }),
  );
  const evidenceRecords = new Map(
    snapshot.evidence.map((evidence) => {
      const edgeId = edgeRecords.get(evidence.edgeId)?.edgeId;
      const occurrenceId = occurrenceRecords.get(
        evidence.occurrenceId,
      )?.occurrenceId;
      if (!edgeId || !occurrenceId)
        throw new Error("graph_storage_identity_missing");
      const stored = GraphEvidenceSchema.parse({
        ...evidence,
        edgeId,
        evidenceId: graphEvidenceIdentity({
          edgeId,
          extractionMethod: evidence.extractionMethod,
          extractionVersion: evidence.extractionVersion,
          extractorFingerprint: evidence.extractorFingerprint,
          occurrenceId,
          path: evidence.path,
          range: evidence.range,
          sourceArtifactId: evidence.sourceArtifactId,
        }),
        occurrenceId,
      });
      return [evidence.evidenceId, stored];
    }),
  );
  const entityIds = {
    edge: new Map(
      [...edgeRecords].map(([logical, stored]) => [logical, stored.edgeId]),
    ),
    evidence: new Map(
      [...evidenceRecords].map(([logical, stored]) => [
        logical,
        stored.evidenceId,
      ]),
    ),
    node: new Map(
      [...nodeRecords].map(([logical, stored]) => [logical, stored.nodeId]),
    ),
    occurrence: new Map(
      [...occurrenceRecords].map(([logical, stored]) => [
        logical,
        stored.occurrenceId,
      ]),
    ),
  };
  return GraphSnapshotSchema.parse({
    edges: [...edgeRecords.values()],
    evidence: [...evidenceRecords.values()],
    memberships: remapMemberships(snapshot.memberships, entityIds).sort(
      (left, right) => left.membershipId.localeCompare(right.membershipId),
    ),
    nodes: [...nodeRecords.values()],
    occurrences: [...occurrenceRecords.values()],
    scope: snapshot.scope,
  });
}

function decodeStoredSnapshot(snapshot: GraphSnapshot): GraphSnapshot {
  const nodeRecords = new Map(
    snapshot.nodes.map((stored) => [stored.nodeId, decodeStoredNode(stored)]),
  );
  const occurrenceRecords = new Map(
    snapshot.occurrences.map((stored) => {
      const nodeId = nodeRecords.get(stored.nodeId)?.nodeId;
      if (!nodeId) throw new Error("graph_node_storage_identity_missing");
      const logical = GraphOccurrenceSchema.parse({
        ...stored,
        nodeId,
        occurrenceId: graphOccurrenceIdentity({
          nodeId,
          path: stored.path,
          range: stored.range,
          role: stored.role,
          sourceArtifactId: stored.sourceArtifactId,
        }),
      });
      return [stored.occurrenceId, logical];
    }),
  );
  const edgeRecords = new Map(
    snapshot.edges.map((stored) => {
      const sourceNodeId = nodeRecords.get(stored.sourceNodeId)?.nodeId;
      const targetNodeId = nodeRecords.get(stored.targetNodeId)?.nodeId;
      if (!sourceNodeId || !targetNodeId)
        throw new Error("graph_node_storage_identity_missing");
      const logical = GraphEdgeSchema.parse({
        ...stored,
        edgeId: graphEdgeIdentity({
          discriminator: stored.discriminator,
          kind: stored.kind,
          sourceNodeId,
          targetNodeId,
        }),
        sourceNodeId,
        targetNodeId,
      });
      return [stored.edgeId, logical];
    }),
  );
  const evidenceRecords = new Map(
    snapshot.evidence.map((stored) => {
      const edgeId = edgeRecords.get(stored.edgeId)?.edgeId;
      const occurrenceId = occurrenceRecords.get(
        stored.occurrenceId,
      )?.occurrenceId;
      if (!edgeId || !occurrenceId)
        throw new Error("graph_storage_identity_missing");
      const logical = GraphEvidenceSchema.parse({
        ...stored,
        edgeId,
        evidenceId: graphEvidenceIdentity({
          edgeId,
          extractionMethod: stored.extractionMethod,
          extractionVersion: stored.extractionVersion,
          extractorFingerprint: stored.extractorFingerprint,
          occurrenceId,
          path: stored.path,
          range: stored.range,
          sourceArtifactId: stored.sourceArtifactId,
        }),
        occurrenceId,
      });
      return [stored.evidenceId, logical];
    }),
  );
  const entityIds = {
    edge: new Map(
      [...edgeRecords].map(([stored, logical]) => [stored, logical.edgeId]),
    ),
    evidence: new Map(
      [...evidenceRecords].map(([stored, logical]) => [
        stored,
        logical.evidenceId,
      ]),
    ),
    node: new Map(
      [...nodeRecords].map(([stored, logical]) => [stored, logical.nodeId]),
    ),
    occurrence: new Map(
      [...occurrenceRecords].map(([stored, logical]) => [
        stored,
        logical.occurrenceId,
      ]),
    ),
  };
  return GraphSnapshotSchema.parse({
    edges: [...edgeRecords.values()],
    evidence: [...evidenceRecords.values()],
    memberships: remapMemberships(snapshot.memberships, entityIds).sort(
      (left, right) => left.membershipId.localeCompare(right.membershipId),
    ),
    nodes: [...nodeRecords.values()],
    occurrences: [...occurrenceRecords.values()],
    scope: snapshot.scope,
  });
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("invalid_graph_json");
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("invalid_graph_json");
  }
}

function assertAuthorized(
  scopeInput: GraphScope,
  workspace: WorkspaceHandle,
): GraphScope {
  const scope = GraphScopeSchema.parse(scopeInput);
  if (
    scope.workspaceId !== workspace.workspaceId ||
    scope.repositoryId !== workspace.repositoryId ||
    scope.revisionId !== workspace.selectedRevision.revisionId
  ) {
    throw new Error("graph_scope_unauthorized");
  }
  return scope;
}

export interface GraphLoadBudget {
  deadline: number;
  maxBytes: number;
  maxEdges: number;
  maxNodes: number;
}

export interface GraphLoadState {
  bytes: number;
  exhaustedReasons: Set<BudgetReason>;
}

export function createGraphLoadState(): GraphLoadState {
  return { bytes: 0, exhaustedReasons: new Set() };
}

export interface GraphLoadOptions {
  budget: GraphLoadBudget;
  direction?: "both" | "forward" | "reverse";
  edgeKinds?: readonly GraphEdge["kind"][];
  maxDepth?: number;
  nodeIds?: readonly string[];
  resolutionStatuses?: readonly GraphEdge["resolutionStatus"][];
  state: GraphLoadState;
}

const defaultLoadLimits = {
  maxBytes: 1_000_000,
  maxEdges: 10_000,
  maxNodes: 5_000,
};

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function inPredicate(column: string, values: readonly string[]): string {
  return `${column} IN (${values.map(sql).join(", ")})`;
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(0, Math.floor(deadline - performance.now()));
}

export class LanceGraphRepository {
  constructor(private readonly store: LanceIntelligenceStore) {}

  async persist(
    snapshotInput: GraphSnapshot,
    workspaceInput?: WorkspaceHandle,
    options: {
      allowReadOnlySource?: boolean;
      reservation?: PublicationReservation;
    } = {},
  ): Promise<void> {
    const snapshot = GraphSnapshotSchema.parse(snapshotInput);
    const workspace = workspaceInput ?? currentWorkspace();
    if (!workspace) throw new Error("workspace_context_required");
    assertAuthorized(snapshot.scope, workspace);
    if (!options.allowReadOnlySource) assertWorkspaceWritable();
    if (!workspace.writeEligibility.eligible && !options.allowReadOnlySource)
      throw new Error("workspace_read_only");
    const storedSnapshot = encodeStoredSnapshot(snapshot);
    const persistedAt = this.store.currentTimestamp();
    const putRows = (
      tableName:
        | "graph_edges"
        | "graph_evidence"
        | "graph_nodes"
        | "graph_occurrences"
        | "revision_membership",
      rows: readonly Record<string, unknown>[],
    ) =>
      options.reservation
        ? this.store.putReservedRows(options.reservation, tableName, rows)
        : this.store.putRows(tableName, rows);
    await putRows(
      "graph_nodes",
      storedSnapshot.nodes.map((node) => ({
        canonical_name: node.canonicalName,
        content_fingerprint: node.contentFingerprint,
        created_at: persistedAt,
        kind: node.kind,
        node_id: node.nodeId,
        properties_json: json(node.properties),
      })),
    );
    await putRows(
      "graph_occurrences",
      storedSnapshot.occurrences.map((occurrence) => ({
        created_at: persistedAt,
        node_id: occurrence.nodeId,
        occurrence_id: occurrence.occurrenceId,
        path: occurrence.path,
        range_json: json(occurrence.range),
        role: occurrence.role,
        source_artifact_id: occurrence.sourceArtifactId,
      })),
    );
    await putRows(
      "graph_edges",
      storedSnapshot.edges.map((edge) => ({
        content_fingerprint: edge.contentFingerprint,
        created_at: persistedAt,
        discriminator: edge.discriminator,
        edge_id: edge.edgeId,
        environment_fingerprint: edge.environmentFingerprint,
        kind: edge.kind,
        properties_json: json(edge.properties),
        resolution_status: edge.resolutionStatus,
        source_node_id: edge.sourceNodeId,
        target_node_id: edge.targetNodeId,
      })),
    );
    await putRows(
      "graph_evidence",
      storedSnapshot.evidence.map((evidence) => ({
        confidence: evidence.confidence,
        created_at: persistedAt,
        edge_id: evidence.edgeId,
        evidence_id: evidence.evidenceId,
        extraction_method: evidence.extractionMethod,
        extraction_version: evidence.extractionVersion,
        extractor_fingerprint: evidence.extractorFingerprint,
        occurrence_id: evidence.occurrenceId,
        path: evidence.path,
        range_json: json(evidence.range),
        source_artifact_id: evidence.sourceArtifactId,
      })),
    );
    await putRows(
      "revision_membership",
      storedSnapshot.memberships.map((membership) => {
        return {
          created_at: persistedAt,
          entity_id: membership.entityId,
          entity_kind: membership.entityKind,
          generation_id: membership.generationId,
          membership_id: membership.membershipId,
          revision_id: membership.revisionId,
        };
      }),
    );
  }

  async load(
    reader: PinnedGenerationReader,
    scopeInput: GraphScope,
    workspaceInput?: WorkspaceHandle,
    optionsInput?: GraphLoadOptions,
  ): Promise<GraphSnapshot> {
    const workspace = workspaceInput ?? currentWorkspace();
    if (!workspace) throw new Error("workspace_context_required");
    const scope = assertAuthorized(scopeInput, workspace);
    if (
      reader.pin.generationId !== scope.generationId ||
      reader.pin.workspaceId !== scope.workspaceId ||
      reader.pin.revisionId !== scope.revisionId
    ) {
      throw new Error("graph_reader_pin_unauthorized");
    }

    const options =
      optionsInput ??
      ({
        budget: {
          deadline: performance.now() + 5_000,
          ...defaultLoadLimits,
        },
        state: createGraphLoadState(),
      } satisfies GraphLoadOptions);
    const { budget, state } = options;
    const timeout = (): number => {
      const milliseconds = remainingMilliseconds(budget.deadline);
      if (milliseconds === 0) state.exhaustedReasons.add("milliseconds");
      return milliseconds;
    };
    const accept = <T>(value: T): T | undefined => {
      const size = Buffer.byteLength(JSON.stringify(value));
      if (state.bytes + size > budget.maxBytes) {
        state.exhaustedReasons.add("bytes");
        return undefined;
      }
      state.bytes += size;
      return value;
    };
    const membershipPredicate = (kind: RevisionMembership["entityKind"]) =>
      [
        `generation_id = ${sql(scope.generationId)}`,
        `revision_id = ${sql(scope.revisionId)}`,
        `entity_kind = ${sql(kind)}`,
      ].join(" AND ");
    const readMemberships = async (
      kind: RevisionMembership["entityKind"],
      limit: number,
      requiredIds: readonly string[] = [],
      fill = requiredIds.length === 0,
    ): Promise<RevisionMembership[]> => {
      const orderedRequiredIds = [...new Set(requiredIds)];
      const required = new Set(orderedRequiredIds);
      const isSelected = (membership: RevisionMembership): boolean =>
        membership.entityKind === kind &&
        membership.generationId === scope.generationId &&
        membership.revisionId === scope.revisionId &&
        (required.size === 0 || required.has(membership.entityId));
      if (timeout() === 0 || limit === 0) return [];
      const selected = new Map<string, RevisionMembership>();
      if (orderedRequiredIds.length > 0) {
        for (
          let offset = 0;
          offset < orderedRequiredIds.length;
          offset += 128
        ) {
          if (timeout() === 0 || selected.size >= limit) break;
          const chunk = orderedRequiredIds.slice(
            offset,
            Math.min(orderedRequiredIds.length, offset + 128),
          );
          const rows = await reader.rows(
            "revision_membership",
            `${membershipPredicate(kind)} AND ${inPredicate("entity_id", chunk)}`,
            { limit: chunk.length, timeoutMs: timeout() },
          );
          const order = new Map(
            chunk.map((entityId, index) => [entityId, index]),
          );
          const memberships = rows
            .map(decodeMembership)
            .filter(isSelected)
            .sort(
              (left, right) =>
                (order.get(left.entityId) ?? Number.MAX_SAFE_INTEGER) -
                (order.get(right.entityId) ?? Number.MAX_SAFE_INTEGER),
            );
          for (const membership of memberships) {
            if (selected.size >= limit) break;
            const accepted = accept(membership);
            if (accepted) selected.set(accepted.entityId, accepted);
          }
        }
      }
      if (fill && selected.size < limit && timeout() > 0) {
        const rows = await reader.rows(
          "revision_membership",
          membershipPredicate(kind),
          { limit: limit + 1, timeoutMs: timeout() },
        );
        if (rows.length > limit) {
          state.exhaustedReasons.add(kind === "node" ? "nodes" : "edges");
        }
        for (const row of rows) {
          if (selected.size >= limit) break;
          const membership = decodeMembership(row);
          if (!isSelected(membership) || selected.has(membership.entityId))
            continue;
          const accepted = accept(membership);
          if (accepted) selected.set(accepted.entityId, accepted);
        }
      }
      return [...selected.values()];
    };
    const readEntities = async <T>(
      table:
        | "graph_edges"
        | "graph_evidence"
        | "graph_nodes"
        | "graph_occurrences",
      idColumn: string,
      ids: readonly string[],
      decode: (row: Row) => T,
      preserveIdOrder = false,
    ): Promise<T[]> => {
      const values: T[] = [];
      const seen = new Set<string>();
      for (let offset = 0; offset < ids.length; offset += 128) {
        if (timeout() === 0 || state.exhaustedReasons.has("bytes")) break;
        const chunk = ids.slice(offset, offset + 128);
        const rows = await reader.rows(table, inPredicate(idColumn, chunk), {
          limit: chunk.length,
          timeoutMs: timeout(),
        });
        const requested = new Set(chunk);
        const rowsById = new Map<string, Row>();
        for (const row of rows) {
          const id = String(row[idColumn]);
          if (requested.has(id) && !rowsById.has(id)) rowsById.set(id, row);
        }
        const orderedRows = preserveIdOrder
          ? chunk
              .map((id) => rowsById.get(id))
              .filter((row): row is Row => row !== undefined)
          : rows;
        for (const row of orderedRows) {
          const id = String(row[idColumn]);
          if (!requested.has(id) || seen.has(id)) continue;
          const accepted = accept(decode(row));
          if (!accepted) break;
          seen.add(id);
          values.push(accepted);
        }
      }
      return values;
    };

    const requestedNodeIds = [...new Set(options.nodeIds ?? [])];
    if (requestedNodeIds.length > budget.maxNodes) {
      requestedNodeIds.length = budget.maxNodes;
      state.exhaustedReasons.add("nodes");
    }
    let initialNodes: GraphNode[];
    let initialNodeMemberships: RevisionMembership[];
    if (requestedNodeIds.length > 0 && timeout() > 0) {
      const rows = await reader.rows(
        "graph_nodes",
        requestedNodeIds
          .map(
            (nodeId) =>
              `canonical_name LIKE ${sql(`${storageNodeVersionPrefix}${Buffer.from(nodeId).toString("base64url")}:%`)}`,
          )
          .join(" OR "),
        { timeoutMs: timeout() },
      );
      const requested = new Set(requestedNodeIds);
      const storedNodes = new Map<string, GraphNode>();
      for (const row of rows) {
        if (timeout() === 0) break;
        const stored = decodeNode(row);
        const logical = decodeStoredNode(stored);
        if (!requested.has(logical.nodeId) || storedNodes.has(stored.nodeId))
          continue;
        storedNodes.set(stored.nodeId, stored);
      }
      const candidateMemberships = await readMemberships(
        "node",
        storedNodes.size,
        [...storedNodes.keys()].sort((left, right) =>
          left.localeCompare(right),
        ),
        false,
      );
      const candidateMembershipsById = new Map(
        candidateMemberships.map((membership) => [
          membership.entityId,
          membership,
        ]),
      );
      initialNodes = [];
      initialNodeMemberships = [];
      for (const stored of [...storedNodes.values()].sort((left, right) =>
        left.nodeId.localeCompare(right.nodeId),
      )) {
        const membership = candidateMembershipsById.get(stored.nodeId);
        if (!membership) continue;
        const accepted = accept(stored);
        if (!accepted) break;
        initialNodes.push(accepted);
        initialNodeMemberships.push(membership);
      }
      if (
        initialNodes.length === 0 &&
        !state.exhaustedReasons.has("bytes") &&
        timeout() > 0
      ) {
        const legacyMemberships = await readMemberships(
          "node",
          budget.maxNodes,
        );
        const legacyNodes = await readEntities(
          "graph_nodes",
          "node_id",
          legacyMemberships.map(({ entityId }) => entityId),
          decodeNode,
        );
        const legacyMatches = new Set(
          legacyNodes
            .filter((stored) => requested.has(decodeStoredNode(stored).nodeId))
            .map(({ nodeId }) => nodeId),
        );
        initialNodes = legacyNodes.filter(({ nodeId }) =>
          legacyMatches.has(nodeId),
        );
        initialNodeMemberships = legacyMemberships.filter(({ entityId }) =>
          legacyMatches.has(entityId),
        );
      }
      const selectedActiveNodeIds = new Set(
        initialNodeMemberships.map(({ entityId }) => entityId),
      );
      initialNodes = initialNodes.filter(({ nodeId }) =>
        selectedActiveNodeIds.has(nodeId),
      );
    } else {
      initialNodeMemberships = await readMemberships("node", budget.maxNodes);
      initialNodes = await readEntities(
        "graph_nodes",
        "node_id",
        initialNodeMemberships.map(({ entityId }) => entityId),
        decodeNode,
      );
    }
    const nodeMemberships = new Map(
      initialNodeMemberships.map((membership) => [
        membership.entityId,
        membership,
      ]),
    );
    const nodesById = new Map(initialNodes.map((node) => [node.nodeId, node]));
    const edgeMemberships = new Map<string, RevisionMembership>();
    const edgesById = new Map<string, GraphEdge>();
    let globallyTruncatedEdges = false;
    const edgePredicate = (frontier: readonly string[]): string => {
      const endpoint =
        options.direction === "forward"
          ? inPredicate("source_node_id", frontier)
          : options.direction === "reverse"
            ? inPredicate("target_node_id", frontier)
            : `(${inPredicate("source_node_id", frontier)} OR ${inPredicate("target_node_id", frontier)})`;
      const filters = [endpoint];
      if (options.edgeKinds?.length)
        filters.push(inPredicate("kind", options.edgeKinds));
      if (options.resolutionStatuses?.length)
        filters.push(
          inPredicate("resolution_status", options.resolutionStatuses),
        );
      return filters.join(" AND ");
    };
    const loadEdgesFrom = async (
      frontier: readonly string[],
    ): Promise<GraphEdge[]> => {
      const remaining = budget.maxEdges - edgesById.size;
      if (remaining <= 0 || frontier.length === 0 || timeout() === 0) {
        if (frontier.length > 0 && remaining <= 0)
          state.exhaustedReasons.add("edges");
        return [];
      }
      const candidates = new Map<string, GraphEdge>();
      const frontierIds = new Set(frontier);
      for (
        let frontierOffset = 0;
        frontierOffset < frontier.length;
        frontierOffset += 128
      ) {
        if (timeout() === 0) break;
        const rows = await reader.rows(
          "graph_edges",
          edgePredicate(frontier.slice(frontierOffset, frontierOffset + 128)),
          { timeoutMs: timeout() },
        );
        for (const row of rows) {
          if (timeout() === 0) break;
          const edge = decodeEdge(row);
          const endpointMatches =
            options.direction === "forward"
              ? frontierIds.has(edge.sourceNodeId)
              : options.direction === "reverse"
                ? frontierIds.has(edge.targetNodeId)
                : frontierIds.has(edge.sourceNodeId) ||
                  frontierIds.has(edge.targetNodeId);
          if (
            edgesById.has(edge.edgeId) ||
            !endpointMatches ||
            (options.edgeKinds?.length &&
              !options.edgeKinds.includes(edge.kind)) ||
            (options.resolutionStatuses?.length &&
              !options.resolutionStatuses.includes(edge.resolutionStatus))
          )
            continue;
          candidates.set(edge.edgeId, edge);
        }
      }
      const candidateEdgeIds = [...candidates.keys()];
      const limitApplied = candidateEdgeIds.length > remaining;
      if (limitApplied) globallyTruncatedEdges = true;
      const preserveEdgeOrder = requestedNodeIds.length > 0 || limitApplied;
      if (preserveEdgeOrder)
        candidateEdgeIds.sort((left, right) => left.localeCompare(right));
      const memberships = await readMemberships(
        "edge",
        remaining,
        candidateEdgeIds,
        false,
      );
      const selected = await readEntities(
        "graph_edges",
        "edge_id",
        memberships.map(({ entityId }) => entityId),
        decodeEdge,
        preserveEdgeOrder,
      );
      const membershipsById = new Map(
        memberships.map((membership) => [membership.entityId, membership]),
      );
      for (const edge of selected) {
        const membership = membershipsById.get(edge.edgeId);
        if (membership) edgeMemberships.set(edge.edgeId, membership);
      }
      if (selected.length >= remaining && candidates.size > selected.length)
        state.exhaustedReasons.add("edges");
      return selected;
    };
    if (requestedNodeIds.length > 0) {
      let frontier = [...nodesById.keys()];
      const visited = new Set<string>();
      const maxDepth = Math.max(0, options.maxDepth ?? 0);
      for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
        if (timeout() === 0) break;
        const activeEdges = await loadEdgesFrom(frontier);
        const endpointIds = new Set<string>();
        for (const edge of activeEdges) {
          if (timeout() === 0) break;
          endpointIds.add(edge.sourceNodeId);
          endpointIds.add(edge.targetNodeId);
        }
        const missing = [...endpointIds].filter((id) => !nodesById.has(id));
        const remainingNodes = budget.maxNodes - nodesById.size;
        if (missing.length > remainingNodes)
          state.exhaustedReasons.add("nodes");
        const memberships = await readMemberships(
          "node",
          remainingNodes,
          missing.slice(0, remainingNodes),
          false,
        );
        for (const membership of memberships)
          nodeMemberships.set(membership.entityId, membership);
        const loaded = await readEntities(
          "graph_nodes",
          "node_id",
          memberships.map(({ entityId }) => entityId),
          decodeNode,
          true,
        );
        for (const node of loaded) nodesById.set(node.nodeId, node);
        const next = new Set<string>();
        for (const edge of activeEdges) {
          if (timeout() === 0) break;
          if (
            nodesById.has(edge.sourceNodeId) &&
            nodesById.has(edge.targetNodeId)
          ) {
            edgesById.set(edge.edgeId, edge);
            const nextId =
              options.direction === "reverse"
                ? edge.sourceNodeId
                : edge.targetNodeId;
            if (!visited.has(nextId)) next.add(nextId);
          }
        }
        for (const id of frontier) visited.add(id);
        frontier = [...next];
      }
    } else {
      const loaded = await loadEdgesFrom([...nodesById.keys()]);
      for (const edge of loaded) {
        if (
          nodesById.has(edge.sourceNodeId) &&
          nodesById.has(edge.targetNodeId)
        )
          edgesById.set(edge.edgeId, edge);
      }
    }
    const candidateEdges = [...edgesById.values()];
    const edgeIds = [...edgesById.keys()];
    const dependentLimit = Math.max(1, budget.maxEdges * 4);
    const candidateEvidence = new Map<string, GraphEvidence>();
    for (let offset = 0; offset < edgeIds.length; offset += 128) {
      if (timeout() === 0) break;
      const edgeChunk = edgeIds.slice(offset, offset + 128);
      const selectedEdgeIds = new Set(edgeChunk);
      const rows = await reader.rows(
        "graph_evidence",
        inPredicate("edge_id", edgeChunk),
        { timeoutMs: timeout() },
      );
      for (const row of rows) {
        if (timeout() === 0) break;
        const evidence = decodeEvidence(row);
        if (selectedEdgeIds.has(evidence.edgeId))
          candidateEvidence.set(evidence.evidenceId, evidence);
      }
    }
    const candidateEvidenceIds = [...candidateEvidence.keys()];
    const preserveEvidenceOrder =
      requestedNodeIds.length > 0 ||
      globallyTruncatedEdges ||
      candidateEvidenceIds.length > dependentLimit;
    if (preserveEvidenceOrder)
      candidateEvidenceIds.sort((left, right) => left.localeCompare(right));
    const evidenceMemberships = await readMemberships(
      "evidence",
      dependentLimit,
      candidateEvidenceIds,
      false,
    );
    const activeEvidence = await readEntities(
      "graph_evidence",
      "evidence_id",
      evidenceMemberships.map(({ entityId }) => entityId),
      decodeEvidence,
      preserveEvidenceOrder,
    );
    if (
      activeEvidence.length >= dependentLimit &&
      candidateEvidence.size > activeEvidence.length
    )
      state.exhaustedReasons.add("edges");
    const occurrenceMemberships = await readMemberships(
      "occurrence",
      dependentLimit,
      activeEvidence.map(({ occurrenceId }) => occurrenceId),
      false,
    );
    const occurrences = await readEntities(
      "graph_occurrences",
      "occurrence_id",
      occurrenceMemberships.map(({ entityId }) => entityId),
      decodeOccurrence,
      requestedNodeIds.length > 0 || globallyTruncatedEdges,
    );
    const occurrenceIds = new Set(
      occurrences.map(({ occurrenceId }) => occurrenceId),
    );
    const evidence: GraphEvidence[] = [];
    for (const item of activeEvidence) {
      if (timeout() === 0) break;
      if (!occurrenceIds.has(item.occurrenceId)) continue;
      evidence.push(item);
    }
    const evidencedEdgeIds = new Set(evidence.map(({ edgeId }) => edgeId));
    const edges = candidateEdges.filter(({ edgeId }) =>
      evidencedEdgeIds.has(edgeId),
    );
    const referencedOccurrenceIds = new Set(
      evidence.map(({ occurrenceId }) => occurrenceId),
    );
    const prunedOccurrences = occurrences.filter(({ occurrenceId }) =>
      referencedOccurrenceIds.has(occurrenceId),
    );
    const nodes = [...nodesById.values()];
    if (globallyTruncatedEdges)
      nodes.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    const selectedIds = new Set([
      ...nodes.map(({ nodeId }) => nodeId),
      ...edges.map(({ edgeId }) => edgeId),
      ...prunedOccurrences.map(({ occurrenceId }) => occurrenceId),
      ...evidence.map(({ evidenceId }) => evidenceId),
    ]);
    const memberships = [
      ...new Map(
        [
          ...nodeMemberships.values(),
          ...edgeMemberships.values(),
          ...occurrenceMemberships,
          ...evidenceMemberships,
        ]
          .filter(({ entityId }) => selectedIds.has(entityId))
          .map((membership) => [membership.membershipId, membership]),
      ).values(),
    ].sort((left, right) =>
      left.membershipId.localeCompare(right.membershipId),
    );
    const storedSnapshot = GraphSnapshotSchema.parse({
      edges,
      evidence,
      memberships,
      nodes,
      occurrences: prunedOccurrences,
      scope,
    });
    return decodeStoredSnapshot(storedSnapshot);
  }
}

export function decodeNode(row: Row) {
  return GraphNodeSchema.parse({
    canonicalName: row.canonical_name,
    contentFingerprint: row.content_fingerprint,
    kind: row.kind,
    nodeId: row.node_id,
    properties: parsedJson(row.properties_json),
  });
}

export function decodeOccurrence(row: Row) {
  return GraphOccurrenceSchema.parse({
    nodeId: row.node_id,
    occurrenceId: row.occurrence_id,
    path: row.path,
    range: parsedJson(row.range_json),
    role: row.role,
    sourceArtifactId: row.source_artifact_id,
  });
}

export function decodeEdge(row: Row) {
  return GraphEdgeSchema.parse({
    contentFingerprint: row.content_fingerprint,
    direction: "directed",
    discriminator: row.discriminator,
    edgeId: row.edge_id,
    environmentFingerprint: row.environment_fingerprint,
    kind: row.kind,
    properties: parsedJson(row.properties_json),
    resolutionStatus: row.resolution_status,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
  });
}

export function decodeEvidence(row: Row) {
  return GraphEvidenceSchema.parse({
    confidence: row.confidence,
    edgeId: row.edge_id,
    evidenceId: row.evidence_id,
    extractionMethod: row.extraction_method,
    extractionVersion: row.extraction_version,
    extractorFingerprint: row.extractor_fingerprint,
    occurrenceId: row.occurrence_id,
    path: row.path,
    range: parsedJson(row.range_json),
    sourceArtifactId: row.source_artifact_id,
  });
}

export function decodeMembership(row: Row) {
  return RevisionMembershipSchema.parse({
    entityId: row.entity_id,
    entityKind: row.entity_kind,
    generationId: row.generation_id,
    membershipId: row.membership_id,
    revisionId: row.revision_id,
  });
}

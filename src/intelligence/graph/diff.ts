import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { BudgetReason } from "./algorithms/types.ts";
import type { GraphDiff, GraphSnapshot } from "./types.ts";
import { GraphSnapshotSchema } from "./types.ts";

type Kind = "edge" | "evidence" | "node" | "occurrence";
type Change = {
  id: string;
  kind: Kind;
  operation: "added" | "changed" | "removed";
};

export interface GraphDiffCursorCodec {
  decode(cursor: string, binding: string): unknown;
  encode(payload: { offset: number }, binding: string): string;
}

export class GraphDiffInputError extends TypeError {
  readonly code = "invalid-graph-diff-request";

  constructor(message: string) {
    super(message);
    this.name = "GraphDiffInputError";
  }
}

const cursorDomain = "ast-mcp.graph-diff-cursor.v1";
const processCursorKey = randomBytes(32);

// Process-local authentication intentionally expires cursors after a restart.
const processCursorCodec: GraphDiffCursorCodec = {
  decode(cursor, binding) {
    const parts = cursor.split(".");
    if (parts.length !== 2) throw new Error("invalid envelope");
    const [payload, signature] = parts;
    if (!payload || !signature || !/^[a-f0-9]{64}$/u.test(signature))
      throw new Error("invalid envelope");
    const expected = cursorMac(payload, binding);
    const received = Buffer.from(signature, "hex");
    if (
      received.byteLength !== expected.byteLength ||
      !timingSafeEqual(received, expected)
    )
      throw new Error("invalid authentication");
    return JSON.parse(Buffer.from(payload, "base64url").toString());
  },
  encode(value, binding) {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${cursorMac(payload, binding).toString("hex")}`;
  },
};

function cursorMac(payload: string, binding: string): Buffer {
  return createHmac("sha256", processCursorKey)
    .update(cursorDomain)
    .update("\0")
    .update(binding)
    .update("\0")
    .update(payload)
    .digest();
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

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

function offset(
  cursor: string | undefined,
  binding: string,
  codec: GraphDiffCursorCodec,
): number {
  if (!cursor) return 0;
  try {
    const value = codec.decode(cursor, binding);
    if (
      !exactObject(value, ["offset"]) ||
      !Number.isSafeInteger(value.offset) ||
      Number(value.offset) < 0
    )
      throw new Error("invalid payload");
    return Number(value.offset);
  } catch {
    throw new GraphDiffInputError("invalid_graph_cursor");
  }
}

function membershipSets(snapshot: GraphSnapshot): Record<Kind, Set<string>> {
  const result: Record<Kind, Set<string>> = {
    edge: new Set(),
    evidence: new Set(),
    node: new Set(),
    occurrence: new Set(),
  };
  for (const membership of snapshot.memberships)
    result[membership.entityKind].add(membership.entityId);
  return result;
}

function entityMaps(
  snapshot: GraphSnapshot,
): Record<Kind, Map<string, unknown>> {
  return {
    edge: new Map(snapshot.edges.map((value) => [value.edgeId, value])),
    evidence: new Map(
      snapshot.evidence.map((value) => [value.evidenceId, value]),
    ),
    node: new Map(snapshot.nodes.map((value) => [value.nodeId, value])),
    occurrence: new Map(
      snapshot.occurrences.map((value) => [value.occurrenceId, value]),
    ),
  };
}

function emptyBuckets(): GraphDiff["added"] {
  return { edges: [], evidence: [], nodes: [], occurrences: [] };
}

export function diffRevisionGraphs(
  fromInput: GraphSnapshot,
  toInput: GraphSnapshot,
  options: {
    cursor?: string;
    exhaustedReasons?: readonly BudgetReason[];
    pageSize: number;
  },
  cursorCodec: GraphDiffCursorCodec = processCursorCodec,
): GraphDiff {
  const from = GraphSnapshotSchema.parse(fromInput);
  const to = GraphSnapshotSchema.parse(toInput);
  if (from.scope.repositoryId !== to.scope.repositoryId)
    throw new GraphDiffInputError("cross_repository_graph_diff");
  if (
    !exactObject(
      options,
      ["pageSize"],
      ["cursor", "exhaustedReasons", "pageSize"],
    ) ||
    (options.exhaustedReasons !== undefined &&
      (!Array.isArray(options.exhaustedReasons) ||
        options.exhaustedReasons.some(
          (reason) =>
            ![
              "bytes",
              "depth",
              "edges",
              "milliseconds",
              "nodes",
              "page",
            ].includes(reason),
        ))) ||
    !Number.isSafeInteger(options.pageSize) ||
    options.pageSize <= 0 ||
    options.pageSize > 10_000 ||
    (options.cursor !== undefined &&
      (typeof options.cursor !== "string" || options.cursor.length === 0))
  )
    throw new GraphDiffInputError("invalid_graph_page_size");

  const before = membershipSets(from);
  const after = membershipSets(to);
  const beforeEntities = entityMaps(from);
  const afterEntities = entityMaps(to);
  const changes: Change[] = [];
  for (const kind of ["node", "occurrence", "edge", "evidence"] as const) {
    for (const id of after[kind]) {
      if (!before[kind].has(id)) {
        changes.push({ id, kind, operation: "added" });
      } else if (
        digest(beforeEntities[kind].get(id)) !==
        digest(afterEntities[kind].get(id))
      ) {
        changes.push({ id, kind, operation: "changed" });
      }
    }
    for (const id of before[kind])
      if (!after[kind].has(id))
        changes.push({ id, kind, operation: "removed" });
  }
  changes.sort((left, right) =>
    `${left.operation}:${left.kind}:${left.id}`.localeCompare(
      `${right.operation}:${right.kind}:${right.id}`,
    ),
  );
  const resultDigest = digest(
    changes.map((change) => ({
      ...change,
      after:
        change.operation === "removed"
          ? undefined
          : afterEntities[change.kind].get(change.id),
      before:
        change.operation === "added"
          ? undefined
          : beforeEntities[change.kind].get(change.id),
    })),
  );
  const binding = digest({
    from: from.scope,
    resultDigest,
    to: to.scope,
  });
  const start = offset(options.cursor, binding, cursorCodec);
  if (start > changes.length)
    throw new GraphDiffInputError("graph_cursor_offset_out_of_range");
  const page = changes.slice(start, start + options.pageSize);
  const added = emptyBuckets();
  const changed = emptyBuckets();
  const removed = emptyBuckets();
  const plural = {
    edge: "edges",
    evidence: "evidence",
    node: "nodes",
    occurrence: "occurrences",
  } as const;
  for (const change of page)
    ({ added, changed, removed })[change.operation][plural[change.kind]].push(
      change.id,
    );
  const next = start + page.length;
  const pageTruncated = next < changes.length;
  const exhaustedReasons = new Set(options.exhaustedReasons ?? []);
  if (pageTruncated) exhaustedReasons.add("page");
  const sortedExhaustedReasons = [...exhaustedReasons].sort();
  const truncated = sortedExhaustedReasons.length > 0;
  return {
    added,
    changed,
    coverage: {
      consideredChanges: page.length,
      exhaustedReasons: sortedExhaustedReasons,
      exhaustive: !truncated,
      totalChanges: changes.length,
      truncated,
    },
    fromRevisionId: from.scope.revisionId,
    nextCursor: pageTruncated
      ? cursorCodec.encode({ offset: next }, binding)
      : null,
    removed,
    toRevisionId: to.scope.revisionId,
    truncated,
  };
}

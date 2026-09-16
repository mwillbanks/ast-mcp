import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  graphEdgeIdentity,
  graphEvidenceIdentity,
  graphNodeIdentity,
  graphOccurrenceIdentity,
  revisionMembershipIdentity,
} from "../src/intelligence/contracts/graph.ts";
import type {
  AlgorithmMembership,
  AlgorithmNode,
  AlgorithmRelationship,
  GraphAlgorithmBudget,
  GraphAlgorithmCursorCodec,
  GraphAlgorithmSnapshot,
} from "../src/intelligence/graph/algorithms/index.ts";
import {
  createGraphAlgorithmExecutionContext,
  expandImpact,
  GraphAlgorithmInputError,
  shortestPath,
  stronglyConnectedComponents,
  traverseGraph,
} from "../src/intelligence/graph/algorithms/index.ts";

const id = (namespace: string, value: string) =>
  `${namespace}:v1:${value.repeat(64)}`;
const revisionId = id("revision", "1");
const generationId = id("generation", "2");
const sourceId = id("source", "3");
const range = {
  end: { column: 1, line: 0 },
  endByte: 1,
  start: { column: 0, line: 0 },
  startByte: 0,
};
const node = (
  key: string,
  name: string,
  kind: AlgorithmNode["kind"] = "function",
): AlgorithmNode => ({
  canonicalName: name,
  contentFingerprint: key.repeat(64),
  kind,
  nodeId: graphNodeIdentity({ canonicalName: name, kind }),
  properties: [],
});
const a = node("a", "same");
const b = node("b", "same", "method");
const c = node("c", "cycle");
const d = node("d", "excluded");
const nodes = [a, b, c, d];
const relationship = (
  key: string,
  source: AlgorithmNode,
  target: AlgorithmNode,
  status: AlgorithmRelationship["edge"]["resolutionStatus"] = "explicit",
): AlgorithmRelationship => {
  const edge = {
    contentFingerprint: key.repeat(64),
    direction: "directed" as const,
    discriminator: key,
    edgeId: "",
    environmentFingerprint: null,
    kind: "calls" as const,
    properties: [],
    resolutionStatus: status,
    sourceNodeId: source.nodeId,
    targetNodeId: target.nodeId,
  };
  edge.edgeId = graphEdgeIdentity({
    discriminator: edge.discriminator,
    kind: edge.kind,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
  });
  const occurrence = {
    nodeId: source.nodeId,
    occurrenceId: "",
    path: "src/example.ts",
    range,
    role: "call" as const,
    sourceArtifactId: sourceId,
  };
  occurrence.occurrenceId = graphOccurrenceIdentity({
    nodeId: occurrence.nodeId,
    path: occurrence.path,
    range: occurrence.range,
    role: occurrence.role,
    sourceArtifactId: occurrence.sourceArtifactId,
  });
  const evidence = {
    confidence: 1,
    edgeId: edge.edgeId,
    evidenceId: "",
    extractionMethod: "ast" as const,
    extractionVersion: "1",
    extractorFingerprint: key.repeat(64),
    occurrenceId: occurrence.occurrenceId,
    path: occurrence.path,
    range,
    sourceArtifactId: sourceId,
  };
  evidence.evidenceId = graphEvidenceIdentity({
    edgeId: evidence.edgeId,
    extractionMethod: evidence.extractionMethod,
    extractionVersion: evidence.extractionVersion,
    extractorFingerprint: evidence.extractorFingerprint,
    occurrenceId: evidence.occurrenceId,
    path: evidence.path,
    range: evidence.range,
    sourceArtifactId: evidence.sourceArtifactId,
  });
  return { edge, evidence: [evidence], occurrences: [occurrence] };
};
const relationships = [
  relationship("e", a, b),
  relationship("f", a, b, "ambiguous"),
  relationship("7", b, c),
  relationship("8", c, a),
  relationship("9", a, c, "unresolved"),
  relationship("0", c, d),
];
const member = (
  entityKind: AlgorithmMembership["entityKind"],
  entityId: string,
  _key: string,
  revision = revisionId,
  generation = generationId,
): AlgorithmMembership => {
  const value = {
    entityId,
    entityKind,
    generationId: generation,
    membershipId: "",
    revisionId: revision,
  };
  value.membershipId = revisionMembershipIdentity({
    entityId: value.entityId,
    entityKind: value.entityKind,
    generationId: value.generationId,
    revisionId: value.revisionId,
  });
  return value as AlgorithmMembership;
};
const memberships: AlgorithmMembership[] = [];
for (const [index, value] of nodes.slice(0, 3).entries())
  memberships.push(member("node", value.nodeId, String(index + 1)));
memberships.push(
  member("node", nodes[3]?.nodeId, "4", revisionId, id("generation", "5")),
);
for (const [index, value] of relationships.entries()) {
  memberships.push(member("edge", value.edge.edgeId, String(index + 5)));
  memberships.push(
    member(
      "occurrence",
      value.occurrences[0]?.occurrenceId,
      String.fromCharCode(107 + index),
    ),
  );
  memberships.push(
    member(
      "evidence",
      value.evidence[0]?.evidenceId,
      String.fromCharCode(113 + index),
    ),
  );
}
const snapshot: GraphAlgorithmSnapshot = {
  generationId,
  memberships,
  nodes,
  relationships,
  revisionId,
};
const budget: GraphAlgorithmBudget = {
  maxBytes: 1_000_000,
  maxDepth: 20,
  maxEdges: 100,
  maxMilliseconds: 10_000,
  maxNodes: 100,
  pageSize: 100,
};

function controlledCursorCodec() {
  const secret = Buffer.from("cursor-test-secret");
  let binding = "";
  const sign = (payload: string, value: string) =>
    createHmac("sha256", secret)
      .update(value)
      .update("\0")
      .update(payload)
      .digest("hex");
  const encodeUnknown = (value: unknown, selectedBinding = binding) => {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${sign(payload, selectedBinding)}`;
  };
  const codec: GraphAlgorithmCursorCodec = {
    decode(cursor, selectedBinding) {
      const [payload, signature] = cursor.split(".");
      if (
        !payload ||
        !signature ||
        signature !== sign(payload, selectedBinding)
      )
        throw new Error("Invalid test cursor");
      return JSON.parse(Buffer.from(payload, "base64url").toString());
    },
    encode(value, selectedBinding) {
      binding = selectedBinding;
      return encodeUnknown(value, selectedBinding);
    },
  };
  return { codec, encodeUnknown };
}

describe("bounded graph algorithms", () => {
  test("traverses forward and reverse deterministically with parallel evidence", () => {
    const request = {
      budget,
      direction: "forward" as const,
      snapshot,
      startNodeIds: [nodes[0]?.nodeId],
    };
    const first = traverseGraph(request);
    expect(traverseGraph(request)).toEqual(first);
    expect(first.nodes.map(({ nodeId }) => nodeId)).toEqual(
      nodes.slice(0, 3).map(({ nodeId }) => nodeId),
    );
    expect(first.relationships.map(({ edge }) => edge.edgeId)).toEqual(
      [
        relationships[0],
        relationships[1],
        relationships[4],
        relationships[2],
        relationships[3],
      ].map(({ edge }) => edge.edgeId),
    );
    expect(first.relationships[0]?.evidence).toEqual(
      relationships[0]?.evidence,
    );
    expect(first.nodes).not.toContainEqual(nodes[3]);
    expect(first.page).toEqual({
      cursor: null,
      exhaustive: true,
      truncated: false,
    });
    const reverse = traverseGraph({
      ...request,
      direction: "reverse",
      startNodeIds: [nodes[2]?.nodeId],
    });
    expect(reverse.nodes.map(({ nodeId }) => nodeId)).toContain(
      nodes[0]?.nodeId,
    );
  });

  test("finds shortest paths with stable tie-breaking and filtering", () => {
    const result = shortestPath({
      budget,
      direction: "forward",
      resolutionStatuses: ["explicit"],
      snapshot,
      sourceNodeId: nodes[0]?.nodeId,
      targetNodeId: nodes[2]?.nodeId,
    });
    expect(result.found).toBe(true);
    expect(result.relationships.map(({ edge }) => edge.edgeId)).toEqual([
      relationships[0]?.edge.edgeId,
      relationships[2]?.edge.edgeId,
    ]);
    expect(
      shortestPath({
        budget: { ...budget, maxDepth: 0 },
        direction: "forward",
        snapshot,
        sourceNodeId: nodes[0]?.nodeId,
        targetNodeId: nodes[2]?.nodeId,
      }),
    ).toMatchObject({ found: false, page: { exhaustive: false } });
  });

  test("computes stable strongly connected components and pages continuously", () => {
    const full = stronglyConnectedComponents({ budget, snapshot });
    expect(
      full.components.map((component) => component.map((x) => x.nodeId)),
    ).toEqual([[nodes[2]?.nodeId, nodes[0]?.nodeId, nodes[1]?.nodeId]]);
    const pagedSnapshot = {
      ...snapshot,
      relationships: [],
    };
    const first = stronglyConnectedComponents({
      budget: { ...budget, pageSize: 1 },
      snapshot: pagedSnapshot,
    });
    expect(first.page.cursor).not.toBeNull();
    const second = stronglyConnectedComponents({
      budget: { ...budget, pageSize: 1 },
      cursor: first.page.cursor ?? undefined,
      snapshot: pagedSnapshot,
    });
    expect(first.components[0]).not.toEqual(second.components[0]);
    expect(() =>
      stronglyConnectedComponents({
        budget,
        cursor: "invalid",
        snapshot,
      }),
    ).toThrow("tampered");
  });

  test("expands reverse impact and reports every hard budget honestly", () => {
    const impact = expandImpact({
      budget,
      snapshot,
      startNodeIds: [nodes[2]?.nodeId],
    });
    expect(impact.nodes.map(({ nodeId }) => nodeId)).toContain(
      nodes[0]?.nodeId,
    );
    for (const [key, value] of [
      ["maxBytes", 0],
      ["maxDepth", 0],
      ["maxEdges", 0],
      ["maxMilliseconds", 0],
      ["maxNodes", 0],
    ] as const) {
      const result = traverseGraph({
        budget: { ...budget, [key]: value },
        direction: "forward",
        snapshot,
        startNodeIds: [nodes[0]?.nodeId],
      });
      expect(result.page.exhaustive).toBe(false);
      expect(result.page.truncated).toBe(true);
      expect(result.coverage.exhaustedReasons.length).toBeGreaterThan(0);
    }
    expect(() =>
      traverseGraph({
        budget: { ...budget, pageSize: 0 },
        direction: "forward",
        snapshot,
        startNodeIds: [],
      }),
    ).toThrow("pageSize");
  });

  test("protects cursors and binds active snapshot content", () => {
    const first = traverseGraph({
      budget: { ...budget, pageSize: 1 },
      direction: "forward",
      snapshot,
      startNodeIds: [a.nodeId],
    });
    const cursor = first.page.cursor;
    if (!cursor) throw new Error("Expected cursor");
    const [payload, signature] = cursor.split(".");
    expect(() =>
      traverseGraph({
        budget: { ...budget, pageSize: 1 },
        cursor: `${payload ?? ""}A.${signature ?? ""}`,
        direction: "forward",
        snapshot,
        startNodeIds: [a.nodeId],
      }),
    ).toThrow("tampered");
    const changed = structuredClone(snapshot);
    const changedNode = changed.nodes[0];
    if (!changedNode) throw new Error("Expected active node");
    changedNode.contentFingerprint = "0".repeat(64);
    expect(() =>
      traverseGraph({
        budget: { ...budget, pageSize: 1 },
        cursor,
        direction: "forward",
        snapshot: changed,
        startNodeIds: [a.nodeId],
      }),
    ).toThrow("stale");
  });

  test("rejects forged and malformed authenticated cursor payloads", () => {
    const request = {
      budget: { ...budget, pageSize: 1 },
      direction: "forward" as const,
      snapshot,
      startNodeIds: [a.nodeId],
    };
    const valid = traverseGraph(request).page.cursor;
    if (!valid) throw new Error("Expected cursor");
    const [encoded] = valid.split(".");
    if (!encoded) throw new Error("Expected cursor payload");
    const changedPayload = Buffer.from(JSON.stringify({ offset: 2 })).toString(
      "base64url",
    );
    const publicDigestForgery = createHash("sha256")
      .update(JSON.stringify(request))
      .update(JSON.stringify(snapshot))
      .update(changedPayload)
      .digest("hex");
    expect(() =>
      traverseGraph({
        ...request,
        cursor: `${changedPayload}.${publicDigestForgery}`,
      }),
    ).toThrow(GraphAlgorithmInputError);

    const controlled = controlledCursorCodec();
    const controlledValid = traverseGraph(request, controlled.codec).page
      .cursor;
    if (!controlledValid) throw new Error("Expected controlled cursor");
    for (const payload of [
      { extra: true, offset: 1 },
      { offset: Number.MAX_SAFE_INTEGER },
    ]) {
      expect(() =>
        traverseGraph(
          { ...request, cursor: controlled.encodeUnknown(payload) },
          controlled.codec,
        ),
      ).toThrow(GraphAlgorithmInputError);
    }
    const sccRequest = {
      budget: { ...budget, pageSize: 1 },
      snapshot: { ...snapshot, relationships: [] },
    };
    const sccCursor = stronglyConnectedComponents(sccRequest, controlled.codec)
      .page.cursor;
    if (!sccCursor) throw new Error("Expected SCC cursor");
    expect(() =>
      stronglyConnectedComponents(
        {
          ...sccRequest,
          cursor: controlled.encodeUnknown({ offset: 100 }),
        },
        controlled.codec,
      ),
    ).toThrow(GraphAlgorithmInputError);
  });

  test("rejects inactive trivial paths and malformed public requests", () => {
    expect(
      shortestPath({
        budget,
        direction: "forward",
        snapshot,
        sourceNodeId: d.nodeId,
        targetNodeId: d.nodeId,
      }),
    ).toMatchObject({ found: false, nodes: [], relationships: [] });
    for (const invalid of [
      { budget, direction: "sideways", snapshot, startNodeIds: [a.nodeId] },
      {
        budget: { ...budget, extra: 1 },
        direction: "forward",
        snapshot,
        startNodeIds: [],
      },
      { budget, direction: "forward", extra: true, snapshot, startNodeIds: [] },
      { budget, direction: "forward", snapshot, startNodeIds: ["bad"] },
      {
        budget,
        direction: "forward",
        snapshot: { ...snapshot, extra: true },
        startNodeIds: [],
      },
      {
        budget,
        direction: "forward",
        snapshot: { ...snapshot, nodes: [{}] },
        startNodeIds: [],
      },
      {
        budget,
        direction: "forward",
        resolutionStatuses: ["invalid"],
        snapshot,
        startNodeIds: [],
      },
    ]) {
      expect(() => traverseGraph(invalid as never)).toThrow(
        GraphAlgorithmInputError,
      );
    }
  });

  test("returns only transactional SCC work under interruption", () => {
    const timed = stronglyConnectedComponents({
      budget: { ...budget, maxMilliseconds: 0 },
      snapshot,
    });
    expect(timed.components).toEqual([]);
    expect(timed.coverage).toMatchObject({
      consideredEdges: 0,
      discoveredNodes: 0,
      exhaustedReasons: ["milliseconds"],
    });
    const shallow = stronglyConnectedComponents({
      budget: { ...budget, maxDepth: 0 },
      snapshot,
    });
    expect(shallow.components).toEqual([]);
    expect(shallow.coverage.discoveredNodes).toBe(0);
    expect(shallow.coverage.exhaustedReasons).toContain("depth");
  });

  test("stops no-match inner loops at one shared absolute deadline", () => {
    const largeSnapshot = {
      ...snapshot,
      relationships: Array.from({ length: 10_000 }, () => relationships[0]),
    };
    const reasons = new Set<"milliseconds">();
    const context = createGraphAlgorithmExecutionContext(
      { maxMilliseconds: 0 },
      reasons,
    );
    const startedAt = performance.now();
    const traversal = traverseGraph(
      {
        budget,
        direction: "forward",
        snapshot: largeSnapshot,
        startNodeIds: [d.nodeId],
      },
      undefined,
      context,
    );
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(traversal.nodes).toEqual([]);
    expect(traversal.relationships).toEqual([]);
    expect(traversal.coverage.exhaustedReasons).toEqual(["milliseconds"]);

    const path = shortestPath(
      {
        budget,
        direction: "forward",
        snapshot: largeSnapshot,
        sourceNodeId: d.nodeId,
        targetNodeId: a.nodeId,
      },
      context,
    );
    expect(path).toMatchObject({
      found: false,
      nodes: [],
      page: { exhaustive: false, truncated: true },
      relationships: [],
    });
    const components = stronglyConnectedComponents(
      { budget, snapshot: largeSnapshot },
      undefined,
      context,
    );
    expect(components.components).toEqual([]);
    expect(components.coverage.exhaustedReasons).toEqual(["milliseconds"]);
  });

  test("continues traversal cursors without loss and rejects stale cursors", () => {
    const small = { ...budget, pageSize: 2 };
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const result = traverseGraph({
        budget: small,
        cursor,
        direction: "forward",
        snapshot,
        startNodeIds: [nodes[0]?.nodeId],
      });
      collected.push(
        ...result.nodes.map(({ nodeId }) => nodeId),
        ...result.relationships.map(({ edge }) => edge.edgeId),
      );
      cursor = result.page.cursor ?? undefined;
    } while (cursor);
    expect(new Set(collected).size).toBe(collected.length);
    expect(() =>
      traverseGraph({
        budget: { ...small, pageSize: 3 },
        cursor:
          traverseGraph({
            budget: small,
            direction: "forward",
            snapshot,
            startNodeIds: [nodes[0]?.nodeId],
          }).page.cursor ?? undefined,
        direction: "forward",
        snapshot,
        startNodeIds: [nodes[0]?.nodeId],
      }),
    ).toThrow("stale");
  });
});

import { describe, expect, test } from "bun:test";

import {
  analyzeGraph,
  projectGraph,
} from "../src/intelligence/analytics/analytics.ts";
import { analyticsFixture } from "./fixtures/intelligence/analytics/fixture.ts";

const clusteredEdges = [
  { confidence: 1, source: "alphaOne", target: "alphaTwo" },
  { confidence: 1, source: "alphaTwo", target: "alphaThree" },
  { confidence: 1, source: "alphaThree", target: "alphaOne" },
  { confidence: 1, source: "betaOne", target: "betaTwo" },
  { confidence: 1, source: "betaTwo", target: "betaThree" },
  { confidence: 1, source: "betaThree", target: "betaOne" },
  {
    confidence: 0.1,
    source: "alphaThree",
    status: "unresolved" as const,
    target: "betaOne",
  },
  {
    confidence: 0.5,
    discriminator: "parallel",
    source: "alphaOne",
    status: "ambiguous" as const,
    target: "alphaTwo",
  },
];

describe("graph analytics", () => {
  test("handles empty, singleton, and disconnected graphs deterministically", () => {
    const empty = analyzeGraph({ snapshot: analyticsFixture([], []) });
    expect(empty.communities).toEqual([]);
    expect(empty.centrality).toEqual([]);
    expect(empty.hierarchy).toEqual([
      { communities: [], level: 0, modularity: 0 },
    ]);

    const snapshot = analyticsFixture(["alpha", "beta"], []);
    const first = analyzeGraph({ options: { seed: 17 }, snapshot });
    const second = analyzeGraph({ options: { seed: 17 }, snapshot });
    expect(first).toEqual(second);
    expect(first.communities).toHaveLength(2);
    expect(first.communities.every((community) => community.connected)).toBe(
      true,
    );
    expect(first.centrality.map(({ pageRank }) => pageRank)).toEqual([
      0.5, 0.5,
    ]);
  });

  test("clusters a directed multigraph through an evidence-weighted projection", () => {
    const snapshot = analyticsFixture(
      ["alphaOne", "alphaTwo", "alphaThree", "betaOne", "betaTwo", "betaThree"],
      clusteredEdges,
    );
    const frozen = JSON.stringify(snapshot);
    const result = analyzeGraph({
      options: { resolution: 1, seed: 29 },
      snapshot,
    });
    expect(JSON.stringify(snapshot)).toBe(frozen);
    expect(result.projection.edges).toHaveLength(7);
    const parallel = result.projection.edges.find(
      (edge) => edge.edgeIds.length === 2,
    );
    expect(parallel?.weight).toBeCloseTo(1.15);
    expect(parallel?.evidenceIds).toHaveLength(2);
    expect(result.communities).toHaveLength(2);
    expect(result.communities.every((community) => community.connected)).toBe(
      true,
    );
    expect(result.hierarchy.length).toBeGreaterThan(1);
    expect(result.hierarchy[0]?.modularity).toBeGreaterThan(0);
    expect(
      result.centrality.find(
        ({ nodeId }) => nodeId === snapshot.edges[0]?.sourceNodeId,
      )?.outDegree,
    ).toBeGreaterThan(0);
  });

  test("binds identities and summaries to seed, projection, membership, and evidence", () => {
    const snapshot = analyticsFixture(
      ["alphaOne", "alphaTwo", "betaOne", "betaTwo"],
      [
        { confidence: 1, source: "alphaOne", target: "alphaTwo" },
        { confidence: 1, source: "betaOne", target: "betaTwo" },
      ],
    );
    const first = analyzeGraph({ options: { seed: 7 }, snapshot });
    const repeat = analyzeGraph({ options: { seed: 7 }, snapshot });
    const otherSeed = analyzeGraph({ options: { seed: 8 }, snapshot });
    expect(first.communities).toEqual(repeat.communities);
    expect(first.communities.map(({ communityId }) => communityId)).not.toEqual(
      otherSeed.communities.map(({ communityId }) => communityId),
    );
    expect(
      first.communities.every(
        ({ summary }) =>
          summary.cacheKey.length === 64 &&
          !("modelId" in summary) &&
          summary.content.length > 0,
      ),
    ).toBe(true);

    const changedEvidence = analyticsFixture(
      ["alphaOne", "alphaTwo", "betaOne", "betaTwo"],
      [
        { confidence: 0.5, source: "alphaOne", target: "alphaTwo" },
        { confidence: 1, source: "betaOne", target: "betaTwo" },
      ],
    );
    const changed = analyzeGraph({
      options: { seed: 7 },
      snapshot: changedEvidence,
    });
    expect(changed.projection.evidenceFingerprint).not.toBe(
      first.projection.evidenceFingerprint,
    );
    expect(changed.communities[0]?.summary.cacheKey).not.toBe(
      first.communities[0]?.summary.cacheKey,
    );
  });

  test("reports deterministic coverage for node, edge, iteration, and level budgets", () => {
    const names = Array.from({ length: 40 }, (_, index) => `node${index}`);
    const edges = names.slice(1).map((name, index) => ({
      source: names[index] ?? name,
      target: name,
    }));
    const snapshot = analyticsFixture(names, edges);
    const nodeBound = projectGraph(snapshot, { maxEdges: 3, maxNodes: 10 });
    expect(nodeBound.coverage).toMatchObject({
      consideredEdges: 0,
      consideredNodes: 10,
      totalEdges: 39,
      totalNodes: 40,
      truncated: true,
    });
    expect(nodeBound.coverage.reasons).toEqual(["node-budget"]);
    const edgeBound = projectGraph(snapshot, { maxEdges: 3, maxNodes: 40 });
    expect(edgeBound.coverage.consideredEdges).toBe(3);
    expect(edgeBound.coverage.reasons).toEqual(["edge-budget"]);
    const result = analyzeGraph({
      options: {
        budget: {
          maxEdges: 20,
          maxIterations: 1,
          maxLevels: 1,
          maxNodes: 20,
          pagerankIterations: 1,
        },
      },
      snapshot,
    });
    expect(result.coverage.truncated).toBe(true);
    expect(result.coverage.reasons).toContain("node-budget");
    expect(result.coverage.reasons).toContain("iteration-budget");
    const centralityBound = analyzeGraph({
      options: { budget: { maxCentralitySources: 1 } },
      snapshot: analyticsFixture(
        ["one", "two", "three"],
        [
          { source: "one", target: "two" },
          { source: "two", target: "three" },
        ],
      ),
    });
    expect(centralityBound.coverage.reasons).toContain("centrality-budget");
    expect(() => projectGraph(snapshot, { maxEdges: 0, maxNodes: 40 })).toThrow(
      "maxEdges",
    );
    expect(() =>
      analyzeGraph({
        options: { budget: { maxNodes: 0 } },
        snapshot,
      }),
    ).toThrow("maxNodes");
  });

  test("summarizes mixed kinds, relations, and repeated evidence", () => {
    const snapshot = analyticsFixture(
      ["alpha", "docGuide"],
      [
        {
          confidences: [0.6, 0.4],
          kind: "calls",
          source: "alpha",
          target: "docGuide",
        },
        {
          confidence: 0.5,
          discriminator: "parallel-import",
          kind: "imports",
          source: "alpha",
          target: "docGuide",
        },
      ],
    );
    const result = analyzeGraph({ snapshot });
    expect(result.projection.edges[0]?.evidenceIds).toHaveLength(3);
    expect(result.communities[0]?.summary.content).toContain("document");
    expect(result.communities[0]?.summary.content).toContain("imports");
  });

  test("computes bounded centrality on paths and cycles", () => {
    const path = analyticsFixture(
      ["left", "center", "right"],
      [
        { source: "left", target: "center" },
        { source: "center", target: "right" },
      ],
    );
    const pathResult = analyzeGraph({ snapshot: path });
    const centerId = path.nodes.find((node) =>
      node.canonicalName.endsWith(".center"),
    )?.nodeId;
    expect(
      pathResult.centrality.find(({ nodeId }) => nodeId === centerId)
        ?.betweenness,
    ).toBe(1);
    expect(
      pathResult.centrality
        .filter(({ nodeId }) => nodeId !== centerId)
        .every(({ betweenness }) => betweenness === 0),
    ).toBe(true);

    const cycle = analyticsFixture(
      ["one", "two", "three"],
      [
        { source: "one", target: "two" },
        { source: "two", target: "three" },
        { source: "three", target: "one" },
      ],
    );
    const cycleScores = analyzeGraph({ snapshot: cycle }).centrality.map(
      ({ betweenness }) => betweenness,
    );
    expect(new Set(cycleScores).size).toBe(1);
  });

  test("does not let self loops prevent connected nodes from merging", () => {
    const snapshot = analyticsFixture(
      ["left", "right"],
      [
        { source: "left", target: "left" },
        { source: "left", target: "right" },
      ],
    );
    const first = analyzeGraph({ options: { seed: 23 }, snapshot });
    const repeat = analyzeGraph({ options: { seed: 23 }, snapshot });

    expect(first).toEqual(repeat);
    expect(first.communities).toHaveLength(1);
    expect(first.communities[0]?.memberIds).toHaveLength(2);
  });

  test("excludes nonpositive edges from default betweenness paths", () => {
    const snapshot = analyticsFixture(
      ["left", "center", "right"],
      [
        { confidence: 0, source: "left", target: "center" },
        { confidence: 0.5, source: "center", target: "right" },
      ],
    );
    const first = analyzeGraph({ snapshot });
    const repeat = analyzeGraph({ snapshot });

    expect(first.centrality).toEqual(repeat.centrality);
    expect(first.centrality.every(({ betweenness }) => betweenness === 0)).toBe(
      true,
    );
  });

  test("rejects malformed analytic controls", () => {
    const snapshot = analyticsFixture(["one"], []);
    expect(() =>
      analyzeGraph({ options: { resolution: 0 }, snapshot }),
    ).toThrow("resolution");
    expect(() =>
      analyzeGraph({
        options: { budget: { tolerance: Number.NaN } },
        snapshot,
      }),
    ).toThrow("tolerance");
    expect(() => analyzeGraph({ options: { seed: -1 }, snapshot })).toThrow(
      "seed",
    );
  });

  test("accounts for self loops without changing the directed source graph", () => {
    const snapshot = analyticsFixture(
      ["recursive"],
      [{ source: "recursive", target: "recursive" }],
    );
    const result = analyzeGraph({ snapshot });
    expect(result.projection.edges[0]?.weight).toBeCloseTo(0.95);
    expect(result.centrality[0]).toMatchObject({
      degree: 1,
      inDegree: 1,
      outDegree: 1,
      weightedDegree: 0.95,
    });
    expect(result.hierarchy[0]?.modularity).toBeCloseTo(0);
  });

  test("includes every resolution state and preserves exact parallel evidence", () => {
    const statuses = [
      "explicit",
      "resolved",
      "inferred",
      "ambiguous",
      "unresolved",
    ] as const;
    const snapshot = analyticsFixture(
      ["source", "target"],
      statuses.map((status, index) => ({
        confidence: 1,
        discriminator: String(index),
        source: index % 2 === 0 ? "source" : "target",
        status,
        target: index % 2 === 0 ? "target" : "source",
      })),
    );
    const result = analyzeGraph({ snapshot });
    expect(result.projection.edges).toHaveLength(1);
    expect(result.projection.edges[0]?.edgeIds).toHaveLength(5);
    expect(result.projection.edges[0]?.evidenceIds).toHaveLength(5);
    expect(result.projection.edges[0]?.weight).toBeCloseTo(3.3);
    expect(
      result.centrality.reduce((sum, node) => sum + node.inDegree, 0),
    ).toBe(5);
    expect(
      result.centrality.reduce((sum, node) => sum + node.outDegree, 0),
    ).toBe(5);
  });
});

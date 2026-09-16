import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sourceArtifactIdentity } from "../src/intelligence/contracts/artifacts.ts";
import { createIdentity } from "../src/intelligence/contracts/common.ts";
import { revisionMembershipIdentity } from "../src/intelligence/contracts/graph.ts";
import { analyzeDocument } from "../src/intelligence/documents/core.ts";
import {
  diffRevisionGraphs,
  type GraphDiffCursorCodec,
  GraphDiffInputError,
} from "../src/intelligence/graph/diff.ts";
import { materializeGraph } from "../src/intelligence/graph/materializer.ts";
import { GraphSnapshotSchema } from "../src/intelligence/graph/types.ts";
import { parseSource } from "../src/intelligence/parser/parser.ts";

const HASH = "a".repeat(64);

function controlledDiffCodec(secretValue: string) {
  const secret = Buffer.from(secretValue);
  let binding = "";
  const sign = (payload: string, selectedBinding: string) =>
    createHmac("sha256", secret)
      .update(selectedBinding)
      .update("\0")
      .update(payload)
      .digest("hex");
  const encodeUnknown = (value: unknown, selectedBinding = binding) => {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${sign(payload, selectedBinding)}`;
  };
  const codec: GraphDiffCursorCodec = {
    decode(cursor, selectedBinding) {
      const [payload, signature] = cursor.split(".");
      if (
        !payload ||
        !signature ||
        signature !== sign(payload, selectedBinding)
      )
        throw new Error("invalid test cursor");
      return JSON.parse(Buffer.from(payload, "base64url").toString());
    },
    encode(value, selectedBinding) {
      binding = selectedBinding;
      return encodeUnknown(value, selectedBinding);
    },
  };
  return { codec, encodeUnknown };
}

function scope(suffix: string) {
  return {
    generationId: createIdentity("generation", { suffix }),
    repositoryId: createIdentity("repository", { root: "/repo" }),
    revisionId: createIdentity("revision", { suffix }),
    workspaceId: createIdentity("workspace", { suffix }),
  };
}

async function corpus() {
  return JSON.parse(
    await readFile(
      join(import.meta.dir, "fixtures/intelligence/graph/corpus.json"),
      "utf8",
    ),
  ) as {
    code: Array<{ path: string; source: string }>;
    document: { path: string; source: string };
  };
}

describe("graph materialization", () => {
  test("preserves scoped duplicate declarations, parallel evidence, and honest ambiguity", async () => {
    const fixture = await corpus();
    const code = fixture.code.map((item) => ({
      facts: parseSource({ languageId: "typescript", source: item.source }),
      kind: "syntax" as const,
      path: item.path,
      sourceArtifactId: sourceArtifactIdentity({
        contentDigest: Bun.SHA256.hash(item.source, "hex"),
      }),
    }));
    const document = await analyzeDocument({
      format: "markdown",
      source: fixture.document.source,
    });
    const input = {
      environmentFingerprint: HASH,
      extractorVersion: "wp08-test-v1",
      scope: scope("one"),
      units: [
        ...code,
        {
          facts: document,
          kind: "document" as const,
          path: fixture.document.path,
          sourceArtifactId: sourceArtifactIdentity({
            contentDigest: document.sourceDigest,
          }),
        },
      ],
    };
    const graph = materializeGraph(input);
    expect(GraphSnapshotSchema.parse(graph)).toEqual(graph);
    const duplicateNodes = graph.nodes.filter((node) =>
      node.properties.some(
        (property) => property.key === "name" && property.value === "duplicate",
      ),
    );
    expect(duplicateNodes).toHaveLength(2);
    expect(new Set(duplicateNodes.map((node) => node.nodeId)).size).toBe(2);
    const calls = graph.edges.filter((edge) => edge.kind === "calls");
    expect(calls).toHaveLength(2);
    expect(calls.every((edge) => edge.resolutionStatus === "ambiguous")).toBe(
      true,
    );
    expect(new Set(calls.map((edge) => edge.edgeId)).size).toBe(2);
    expect(
      graph.evidence.filter((item) =>
        calls.some((edge) => edge.edgeId === item.edgeId),
      ),
    ).toHaveLength(2);
    expect(graph.memberships).toHaveLength(
      graph.nodes.length +
        graph.occurrences.length +
        graph.edges.length +
        graph.evidence.length,
    );

    const reordered = materializeGraph({
      ...input,
      units: [...input.units].reverse(),
    });
    expect(reordered).toEqual(graph);
    const reorderedDocument = materializeGraph({
      ...input,
      units: [
        ...code,
        {
          facts: {
            ...document,
            nodes: [...document.nodes].reverse(),
          },
          kind: "document" as const,
          path: fixture.document.path,
          sourceArtifactId: sourceArtifactIdentity({
            contentDigest: document.sourceDigest,
          }),
        },
      ],
    });
    expect(reorderedDocument).toEqual(graph);
    const otherEnvironment = materializeGraph({
      ...input,
      environmentFingerprint: "f".repeat(64),
    });
    expect(otherEnvironment.nodes.map((node) => node.nodeId)).toEqual(
      graph.nodes.map((node) => node.nodeId),
    );
    expect(otherEnvironment.edges.map((edge) => edge.edgeId)).not.toEqual(
      graph.edges.map((edge) => edge.edgeId),
    );
  });

  test("uses zero coordinates when a graph unit has no source range", () => {
    const sourceDigest = "d".repeat(64);
    const sourceArtifactId = sourceArtifactIdentity({
      contentDigest: sourceDigest,
    });
    const graph = materializeGraph({
      environmentFingerprint: null,
      extractorVersion: "wp08-test-v1",
      scope: scope("missing-range"),
      units: [
        {
          facts: {
            diagnostics: [],
            format: "dotnet-project",
            nodes: [],
            parserFingerprint: "c".repeat(64),
            partial: false,
            relationships: [],
            rewriteSupported: false,
            schemaVersion: "ast-mcp.project-facts.v1",
            sourceArtifactId,
            sourceByteLength: 0,
            sourceDigest,
            syntaxFactsArtifactId: createIdentity("syntax-facts", {
              empty: true,
            }),
          },
          kind: "project",
          path: "Empty.csproj",
          sourceArtifactId,
        },
      ],
    });

    const fileNode = graph.nodes.find((node) => node.kind === "file");
    const containment = graph.occurrences.find(
      (occurrence) => occurrence.nodeId === fileNode?.nodeId,
    );
    expect(containment?.range).toEqual({
      end: { column: 0, line: 0 },
      endByte: 0,
      start: { column: 0, line: 0 },
      startByte: 0,
    });
  });

  test("diffs exact revision membership with stable pagination", async () => {
    const fixture = await corpus();
    const firstFacts = parseSource({
      languageId: "typescript",
      source: fixture.code[0]?.source,
    });
    const secondFacts = parseSource({
      languageId: "typescript",
      source: fixture.code[1]?.source,
    });
    const unit = (facts: typeof firstFacts, path: string) => ({
      facts,
      kind: "syntax" as const,
      path,
      sourceArtifactId: facts.sourceArtifactId,
    });
    const from = materializeGraph({
      environmentFingerprint: HASH,
      extractorVersion: "wp08-test-v1",
      scope: scope("from"),
      units: [unit(firstFacts, fixture.code[0]?.path)],
    });
    const to = materializeGraph({
      environmentFingerprint: HASH,
      extractorVersion: "wp08-test-v1",
      scope: scope("to"),
      units: [
        unit(firstFacts, fixture.code[0]?.path),
        unit(secondFacts, fixture.code[1]?.path),
      ],
    });
    const first = diffRevisionGraphs(from, to, { pageSize: 2 });
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/u);
    expect(first.coverage.consideredChanges).toBe(2);
    expect(first.coverage.totalChanges).toBeGreaterThan(2);
    const loadTruncated = diffRevisionGraphs(from, to, {
      exhaustedReasons: ["nodes"],
      pageSize: 10_000,
    });
    expect(loadTruncated.coverage).toMatchObject({
      exhaustedReasons: ["nodes"],
      exhaustive: false,
      truncated: true,
    });
    expect(loadTruncated.truncated).toBeTrue();
    expect(loadTruncated.nextCursor).toBeNull();
    if (!first.nextCursor) throw new Error("expected graph diff cursor");
    const second = diffRevisionGraphs(from, to, {
      cursor: first.nextCursor,
      pageSize: 10_000,
    });
    expect(second.toRevisionId).toBe(to.scope.revisionId);
    expect(
      first.added.nodes.length +
        first.added.occurrences.length +
        first.added.edges.length +
        first.added.evidence.length +
        second.added.nodes.length +
        second.added.occurrences.length +
        second.added.edges.length +
        second.added.evidence.length,
    ).toBeGreaterThan(0);
    expect(() =>
      diffRevisionGraphs(
        from,
        {
          ...to,
          scope: {
            ...to.scope,
            repositoryId: createIdentity("repository", { root: "/other" }),
          },
        },
        { pageSize: 1 },
      ),
    ).toThrow("cross_repository_graph_diff");
    expect(() =>
      diffRevisionGraphs(from, to, { cursor: "01", pageSize: 1 }),
    ).toThrow("invalid_graph_cursor");
    expect(() => diffRevisionGraphs(from, to, { pageSize: 0 })).toThrow(
      "invalid_graph_page_size",
    );

    const cursor = first.nextCursor;
    if (!cursor) throw new Error("expected authenticated cursor");
    const [payload] = cursor.split(".");
    if (!payload) throw new Error("expected cursor payload");
    const changedPayload = Buffer.from(JSON.stringify({ offset: 3 })).toString(
      "base64url",
    );
    const publicDigestForgery = createHash("sha256")
      .update(JSON.stringify(from.scope))
      .update(JSON.stringify(to.scope))
      .update(changedPayload)
      .digest("hex");
    expect(() =>
      diffRevisionGraphs(from, to, {
        cursor: `${changedPayload}.${publicDigestForgery}`,
        pageSize: 2,
      }),
    ).toThrow(GraphDiffInputError);

    const stale = structuredClone(to);
    const staleNode = stale.nodes[0];
    if (!staleNode) throw new Error("expected graph node");
    staleNode.contentFingerprint = "0".repeat(64);
    expect(() =>
      diffRevisionGraphs(from, stale, { cursor, pageSize: 2 }),
    ).toThrow("invalid_graph_cursor");
    expect(() => diffRevisionGraphs(to, from, { cursor, pageSize: 2 })).toThrow(
      "invalid_graph_cursor",
    );

    const controlled = controlledDiffCodec("first-process");
    const controlledCursor = diffRevisionGraphs(
      from,
      to,
      { pageSize: 1 },
      controlled.codec,
    ).nextCursor;
    if (!controlledCursor) throw new Error("expected controlled cursor");
    for (const invalidPayload of [
      { extra: true, offset: 1 },
      { offset: Number.MAX_SAFE_INTEGER },
    ]) {
      expect(() =>
        diffRevisionGraphs(
          from,
          to,
          {
            cursor: controlled.encodeUnknown(invalidPayload),
            pageSize: 1,
          },
          controlled.codec,
        ),
      ).toThrow(GraphDiffInputError);
    }
    const restarted = controlledDiffCodec("second-process");
    expect(() =>
      diffRevisionGraphs(
        from,
        to,
        { cursor: controlledCursor, pageSize: 1 },
        restarted.codec,
      ),
    ).toThrow("invalid_graph_cursor");

    const edited = structuredClone(from);
    edited.scope = to.scope;
    edited.memberships = edited.memberships.map((membership) => {
      const updated = {
        ...membership,
        generationId: to.scope.generationId,
        revisionId: to.scope.revisionId,
      };
      return {
        ...updated,
        membershipId: revisionMembershipIdentity({
          entityId: updated.entityId,
          entityKind: updated.entityKind,
          generationId: updated.generationId,
          revisionId: updated.revisionId,
        }),
      };
    });
    const editedNode = edited.nodes[0];
    if (!editedNode) throw new Error("expected edited node");
    editedNode.contentFingerprint = "0".repeat(64);
    const contentDiff = diffRevisionGraphs(from, edited, {
      pageSize: 10_000,
    });
    expect(contentDiff.changed.nodes).toEqual([editedNode.nodeId]);
    expect(contentDiff.added.nodes).toEqual([]);
    expect(contentDiff.removed.nodes).toEqual([]);
  });

  test("materializes project dependencies and every structural relationship category", () => {
    const facts = parseSource({
      languageId: "typescript",
      source: "class Child extends Base { method() { value = helper(); } }",
    });
    const range = facts.nodes[0]?.range;
    const symbolId = facts.symbols[0]?.id ?? "synthetic-child";
    const enriched = {
      ...facts,
      implementations: [
        {
          id: "impl-1",
          range,
          sourceSymbolId: symbolId,
          targetName: "Contract",
        },
      ],
      inheritance: [
        {
          id: "inherit-1",
          range,
          sourceSymbolId: symbolId,
          targetName: "Base",
        },
      ],
      references: [
        {
          enclosingSymbolId: symbolId,
          id: "write-1",
          name: "value",
          range,
          role: "write" as const,
        },
        {
          enclosingSymbolId: symbolId,
          id: "type-1",
          name: "UnknownType",
          range,
          role: "type" as const,
        },
      ],
      symbols: [
        ...facts.symbols,
        ...(["interface", "method", "namespace", "type"] as const).map(
          (kind, index) => ({
            declarationRange: range,
            exported: false,
            id: `synthetic-${kind}`,
            kind,
            name: `${kind}${index}`,
            qualifiedName: `Child.${kind}${index}`,
            range,
          }),
        ),
      ],
    };
    const projectFacts = {
      diagnostics: [],
      format: "dotnet-project" as const,
      nodes: [
        {
          attributes: {},
          childIds: ["package-node"],
          id: "project-node",
          kind: "project" as const,
          name: "Example",
          parentId: null,
          range,
        },
        {
          attributes: {},
          childIds: [],
          id: "package-node",
          kind: "package" as const,
          name: "Dependency",
          parentId: "project-node",
          range,
        },
      ],
      parserFingerprint: "c".repeat(64),
      partial: false,
      relationships: [
        {
          id: "dependency-1",
          kind: "dependency" as const,
          range,
          sourceNodeId: "project-node",
          target: "pkg:one",
        },
        {
          id: "reference-1",
          kind: "reference" as const,
          range,
          sourceNodeId: null,
          target: "external:thing",
        },
      ],
      rewriteSupported: false as const,
      schemaVersion: "ast-mcp.project-facts.v1" as const,
      sourceArtifactId: sourceArtifactIdentity({
        contentDigest: "d".repeat(64),
      }),
      sourceByteLength: 10,
      sourceDigest: "d".repeat(64),
      syntaxFactsArtifactId: createIdentity("syntax-facts", { project: true }),
    };
    const graph = materializeGraph({
      environmentFingerprint: null,
      extractorVersion: "wp08-test-v1",
      scope: scope("relationships"),
      units: [
        {
          facts: enriched,
          kind: "syntax",
          path: "src/relationships.ts",
          sourceArtifactId: facts.sourceArtifactId,
        },
        {
          facts: projectFacts,
          kind: "project",
          path: "Example.csproj",
          sourceArtifactId: projectFacts.sourceArtifactId,
        },
      ],
    });
    expect(new Set(graph.edges.map((edge) => edge.kind))).toEqual(
      expect.objectContaining(
        new Set([
          "contains",
          "declares",
          "depends-on",
          "references",
          "inherits",
          "implements",
          "writes",
        ]),
      ),
    );
    expect(graph.nodes.some((node) => node.kind === "package")).toBe(true);
    const reorderedProject = materializeGraph({
      environmentFingerprint: null,
      extractorVersion: "wp08-test-v1",
      scope: scope("relationships"),
      units: [
        {
          facts: enriched,
          kind: "syntax",
          path: "src/relationships.ts",
          sourceArtifactId: facts.sourceArtifactId,
        },
        {
          facts: {
            ...projectFacts,
            nodes: [...projectFacts.nodes].reverse(),
          },
          kind: "project",
          path: "Example.csproj",
          sourceArtifactId: projectFacts.sourceArtifactId,
        },
      ],
    });
    expect(reorderedProject).toEqual(graph);
    const projectParent = graph.nodes.find((node) =>
      node.canonicalName.endsWith(":project-node"),
    );
    const projectChild = graph.nodes.find((node) =>
      node.canonicalName.endsWith(":package-node"),
    );
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "contains" &&
          edge.sourceNodeId === projectParent?.nodeId &&
          edge.targetNodeId === projectChild?.nodeId,
      ),
    ).toBe(true);
    expect(() =>
      materializeGraph({
        environmentFingerprint: null,
        extractorVersion: " ",
        scope: scope("invalid"),
        units: [],
      }),
    ).toThrow("invalid_extractor_version");
    expect(() =>
      materializeGraph({
        environmentFingerprint: null,
        extractorVersion: "wp08-test-v1",
        scope: scope("content-mismatch"),
        units: [
          {
            facts,
            kind: "syntax",
            path: "src/mismatch.ts",
            sourceArtifactId: sourceArtifactIdentity({
              contentDigest: "f".repeat(64),
            }),
          },
        ],
      }),
    ).toThrow("source_artifact_content_mismatch");
  });
});

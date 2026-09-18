import { createHash } from "node:crypto";

import { sourceArtifactIdentity } from "../contracts/artifacts.ts";
import type { EvidenceRange } from "../contracts/common.ts";
import {
  GraphEdgeSchema,
  GraphEvidenceSchema,
  GraphNodeSchema,
  GraphOccurrenceSchema,
  graphEdgeIdentity,
  graphEvidenceIdentity,
  graphNodeIdentity,
  graphOccurrenceIdentity,
} from "../contracts/graph.ts";
import type { DocumentFacts } from "../documents/types.ts";
import type { ProjectFacts } from "../languages/project/types.ts";
import type { ExactSourceRange, SyntaxFacts } from "../parser/types.ts";
import { createGraphMemberships } from "./shared.ts";
import type {
  GraphEdge,
  GraphEvidence,
  GraphNode,
  GraphOccurrence,
  GraphScope,
  GraphSnapshot,
} from "./types.ts";
import { GraphScopeSchema, GraphSnapshotSchema } from "./types.ts";

type Unit =
  | {
      facts: SyntaxFacts;
      kind: "syntax";
      path: string;
      sourceArtifactId: string;
    }
  | {
      facts: DocumentFacts;
      kind: "document";
      path: string;
      sourceArtifactId: string;
    }
  | {
      facts: ProjectFacts;
      kind: "project";
      path: string;
      sourceArtifactId: string;
    };

export interface GraphMaterializationInput {
  environmentFingerprint: string | null;
  extractorVersion: string;
  scope: GraphScope;
  units: readonly Unit[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceRange(range: ExactSourceRange | undefined): EvidenceRange {
  return range
    ? {
        end: { column: range.end.column, line: range.end.line },
        endByte: range.endByte,
        start: { column: range.start.column, line: range.start.line },
        startByte: range.startByte,
      }
    : zeroRange();
}

function zeroRange(): EvidenceRange {
  return {
    end: { column: 0, line: 0 },
    endByte: 0,
    start: { column: 0, line: 0 },
    startByte: 0,
  };
}

function symbolKind(kind: string): GraphNode["kind"] {
  if (
    kind === "class" ||
    kind === "interface" ||
    kind === "enum" ||
    kind === "type"
  )
    return "type";
  if (kind === "function") return "function";
  if (kind === "method") return "method";
  if (kind === "namespace") return "namespace";
  if (kind === "parameter") return "parameter";
  return "variable";
}

function sorted<T extends { [key: string]: unknown }>(
  values: Iterable<T>,
  key: keyof T,
): T[] {
  return [...values].sort((left, right) =>
    String(left[key]).localeCompare(String(right[key])),
  );
}

export function materializeGraph(
  input: GraphMaterializationInput,
): GraphSnapshot {
  const scope = GraphScopeSchema.parse(input.scope);
  if (!input.extractorVersion.trim())
    throw new Error("invalid_extractor_version");
  for (const unit of input.units) {
    const expectedSourceArtifactId = sourceArtifactIdentity({
      contentDigest: unit.facts.sourceDigest,
    });
    if (
      unit.sourceArtifactId !== expectedSourceArtifactId ||
      (unit.kind !== "document" &&
        unit.facts.sourceArtifactId !== expectedSourceArtifactId)
    ) {
      throw new Error("source_artifact_content_mismatch");
    }
  }
  const nodes = new Map<string, GraphNode>();
  const occurrences = new Map<string, GraphOccurrence>();
  const edges = new Map<string, GraphEdge>();
  const evidence = new Map<string, GraphEvidence>();
  const fileNodes = new Map<string, GraphNode>();
  const symbolNodes = new Map<string, GraphNode>();
  const symbolCandidates = new Map<
    string,
    Array<{ node: GraphNode; path: string }>
  >();

  const addNode = (
    canonicalName: string,
    kind: GraphNode["kind"],
    contentFingerprint: string,
    properties: GraphNode["properties"] = [],
  ): GraphNode => {
    const node = GraphNodeSchema.parse({
      canonicalName,
      contentFingerprint,
      kind,
      nodeId: graphNodeIdentity({ canonicalName, kind }),
      properties,
    });
    const existing = nodes.get(node.nodeId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(node)) {
      throw new Error("graph_node_identity_collision");
    }
    nodes.set(node.nodeId, node);
    return node;
  };

  const addOccurrence = (
    nodeId: string,
    path: string,
    range: EvidenceRange,
    role: GraphOccurrence["role"],
    sourceArtifactId: string,
  ): GraphOccurrence => {
    const occurrence = GraphOccurrenceSchema.parse({
      nodeId,
      occurrenceId: graphOccurrenceIdentity({
        nodeId,
        path,
        range,
        role,
        sourceArtifactId,
      }),
      path,
      range,
      role,
      sourceArtifactId,
    });
    occurrences.set(occurrence.occurrenceId, occurrence);
    return occurrence;
  };

  const addRelationship = (details: {
    confidence?: number;
    contentFingerprint: string;
    discriminator: string;
    extractionMethod:
      | "ast"
      | "structured-parser"
      | "resolver"
      | "text-pattern"
      | "tree-sitter-query";
    extractorFingerprint: string;
    kind: GraphEdge["kind"];
    occurrence: GraphOccurrence;
    properties?: GraphEdge["properties"];
    resolutionStatus: GraphEdge["resolutionStatus"];
    sourceNodeId: string;
    targetNodeId: string;
  }): void => {
    const discriminator = [
      details.discriminator,
      details.contentFingerprint,
      input.environmentFingerprint ?? "no-environment",
    ].join(":");
    const edge = GraphEdgeSchema.parse({
      contentFingerprint: details.contentFingerprint,
      direction: "directed",
      discriminator,
      edgeId: graphEdgeIdentity({
        discriminator,
        kind: details.kind,
        sourceNodeId: details.sourceNodeId,
        targetNodeId: details.targetNodeId,
      }),
      environmentFingerprint: input.environmentFingerprint,
      kind: details.kind,
      properties: details.properties ?? [],
      resolutionStatus: details.resolutionStatus,
      sourceNodeId: details.sourceNodeId,
      targetNodeId: details.targetNodeId,
    });
    const item = GraphEvidenceSchema.parse({
      confidence: details.confidence ?? 1,
      edgeId: edge.edgeId,
      evidenceId: graphEvidenceIdentity({
        edgeId: edge.edgeId,
        extractionMethod: details.extractionMethod,
        extractionVersion: input.extractorVersion,
        extractorFingerprint: details.extractorFingerprint,
        occurrenceId: details.occurrence.occurrenceId,
        path: details.occurrence.path,
        range: details.occurrence.range,
        sourceArtifactId: details.occurrence.sourceArtifactId,
      }),
      extractionMethod: details.extractionMethod,
      extractionVersion: input.extractorVersion,
      extractorFingerprint: details.extractorFingerprint,
      occurrenceId: details.occurrence.occurrenceId,
      path: details.occurrence.path,
      range: details.occurrence.range,
      sourceArtifactId: details.occurrence.sourceArtifactId,
    });
    edges.set(edge.edgeId, edge);
    evidence.set(item.evidenceId, item);
  };

  const repository = addNode(
    `repository:${scope.repositoryId}`,
    "repository",
    sha256(scope.repositoryId),
  );

  for (const unit of [...input.units].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    const contentFingerprint = unit.facts.sourceDigest;
    const file = addNode(
      `repository:${scope.repositoryId}:file:${unit.path}`,
      unit.kind === "document" ? "document" : "file",
      contentFingerprint,
      [{ key: "path", value: unit.path }],
    );
    fileNodes.set(unit.path, file);
    const rootRange =
      unit.kind === "syntax"
        ? evidenceRange(
            unit.facts.nodes.find((node) => node.id === unit.facts.rootNodeId)
              ?.range ?? unit.facts.nodes[0]?.range,
          )
        : unit.kind === "document"
          ? evidenceRange(unit.facts.nodes[0]?.range)
          : evidenceRange(unit.facts.nodes[0]?.range);
    const containment = addOccurrence(
      file.nodeId,
      unit.path,
      rootRange,
      unit.kind === "document" ? "document" : "containment",
      unit.sourceArtifactId,
    );
    addRelationship({
      contentFingerprint,
      discriminator: `repository-file:${unit.path}`,
      extractionMethod: "structured-parser",
      extractorFingerprint:
        unit.kind === "syntax"
          ? unit.facts.extractorFingerprint
          : unit.kind === "project"
            ? unit.facts.parserFingerprint
            : unit.facts.sourceDigest,
      kind: "contains",
      occurrence: containment,
      resolutionStatus: "explicit",
      sourceNodeId: repository.nodeId,
      targetNodeId: file.nodeId,
    });

    if (unit.kind !== "syntax") continue;
    for (const symbol of unit.facts.symbols) {
      const range = evidenceRange(symbol.declarationRange);
      const canonicalName = [
        "symbol",
        scope.repositoryId,
        unit.path,
        symbol.kind,
        symbol.qualifiedName,
        range.startByte,
        range.endByte,
      ].join(":");
      const node = addNode(
        canonicalName,
        symbolKind(symbol.kind),
        contentFingerprint,
        [
          { key: "name", value: symbol.name },
          { key: "qualifiedName", value: symbol.qualifiedName },
          { key: "exported", value: symbol.exported },
        ],
      );
      symbolNodes.set(`${unit.path}:${symbol.id}`, node);
      for (const name of new Set([symbol.name, symbol.qualifiedName])) {
        const bucket = symbolCandidates.get(name) ?? [];
        bucket.push({ node, path: unit.path });
        symbolCandidates.set(name, bucket);
      }
      const declaration = addOccurrence(
        node.nodeId,
        unit.path,
        range,
        "declaration",
        unit.sourceArtifactId,
      );
      addRelationship({
        contentFingerprint,
        discriminator: `declaration:${unit.path}:${symbol.id}`,
        extractionMethod: "ast",
        extractorFingerprint: unit.facts.extractorFingerprint,
        kind: "declares",
        occurrence: declaration,
        resolutionStatus: "explicit",
        sourceNodeId: file.nodeId,
        targetNodeId: node.nodeId,
      });
    }
  }

  const resolveTarget = (
    name: string,
    path: string,
    contentFingerprint: string,
  ): {
    node: GraphNode;
    properties: GraphEdge["properties"];
    status: GraphEdge["resolutionStatus"];
  } => {
    const candidates = [...(symbolCandidates.get(name) ?? [])].sort((a, b) =>
      a.node.nodeId.localeCompare(b.node.nodeId),
    );
    const local = candidates.filter((candidate) => candidate.path === path);
    const preferred = local.length ? local : candidates;
    if (preferred.length === 1) {
      return { node: preferred[0]?.node, properties: [], status: "resolved" };
    }
    if (preferred.length > 1) {
      const ids = preferred.map((candidate) => candidate.node.nodeId);
      return {
        node: addNode(
          `ambiguous:${scope.repositoryId}:${path}:${name}:${ids.join(",")}`,
          "concept",
          contentFingerprint,
          [
            { key: "target", value: name },
            { key: "candidateNodeIds", value: ids },
          ],
        ),
        properties: [{ key: "candidateNodeIds", value: ids }],
        status: "ambiguous",
      };
    }
    return {
      node: addNode(`external:${name}`, "external-reference", sha256(name), [
        { key: "target", value: name },
      ]),
      properties: [{ key: "target", value: name }],
      status: "unresolved",
    };
  };

  for (const unit of [...input.units].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    const file = fileNodes.get(unit.path);
    if (!file) throw new Error("graph_file_node_missing");
    const contentFingerprint = unit.facts.sourceDigest;
    if (unit.kind === "syntax") {
      const fingerprint = unit.facts.extractorFingerprint;
      const sourceFor = (symbolId: string | null): GraphNode =>
        symbolId ? (symbolNodes.get(`${unit.path}:${symbolId}`) ?? file) : file;
      const relation = (
        record: { id: string; range: ExactSourceRange },
        targetName: string,
        kind: GraphEdge["kind"],
        role: GraphOccurrence["role"],
        source: GraphNode,
      ) => {
        const target = resolveTarget(targetName, unit.path, contentFingerprint);
        const occurrence = addOccurrence(
          source.nodeId,
          unit.path,
          evidenceRange(record.range),
          role,
          unit.sourceArtifactId,
        );
        addRelationship({
          confidence:
            target.status === "resolved"
              ? 1
              : target.status === "ambiguous"
                ? 0.5
                : 0,
          contentFingerprint,
          discriminator: `${kind}:${unit.path}:${record.id}`,
          extractionMethod: "resolver",
          extractorFingerprint: fingerprint,
          kind,
          occurrence,
          properties: target.properties,
          resolutionStatus: target.status,
          sourceNodeId: source.nodeId,
          targetNodeId: target.node.nodeId,
        });
      };
      for (const item of unit.facts.imports)
        relation(
          item,
          item.importedName || item.source,
          "imports",
          "import",
          file,
        );
      for (const item of unit.facts.exports) {
        const source = item.localName
          ? resolveTarget(item.localName, unit.path, contentFingerprint)
          : { node: file, properties: [], status: "explicit" as const };
        const occurrence = addOccurrence(
          source.node.nodeId,
          unit.path,
          evidenceRange(item.range),
          "export",
          unit.sourceArtifactId,
        );
        addRelationship({
          contentFingerprint,
          discriminator: `exports:${unit.path}:${item.id}`,
          extractionMethod: "ast",
          extractorFingerprint: fingerprint,
          kind: "exports",
          occurrence,
          properties: source.properties,
          resolutionStatus: source.status,
          sourceNodeId: file.nodeId,
          targetNodeId: source.node.nodeId,
        });
      }
      for (const item of unit.facts.calls)
        relation(
          item,
          item.callee,
          "calls",
          "call",
          sourceFor(item.enclosingSymbolId),
        );
      for (const item of unit.facts.inheritance)
        relation(
          item,
          item.targetName,
          "inherits",
          "inheritance",
          sourceFor(item.sourceSymbolId),
        );
      for (const item of unit.facts.implementations)
        relation(
          item,
          item.targetName,
          "implements",
          "inheritance",
          sourceFor(item.sourceSymbolId),
        );
      for (const item of unit.facts.references)
        relation(
          item,
          item.name,
          item.role === "read"
            ? "reads"
            : item.role === "write"
              ? "writes"
              : "references",
          "reference",
          sourceFor(item.enclosingSymbolId),
        );
      continue;
    }

    if (unit.kind === "document") {
      const documentNodes = new Map<string, GraphNode>();
      for (const item of unit.facts.nodes) {
        const node = addNode(
          `document:${scope.repositoryId}:${unit.path}:${item.id}`,
          item.kind === "heading" || item.kind === "section"
            ? "section"
            : "chunk",
          contentFingerprint,
          [
            { key: "name", value: item.name },
            { key: "value", value: item.value },
          ],
        );
        documentNodes.set(item.id, node);
      }
      for (const item of unit.facts.nodes) {
        const node = documentNodes.get(item.id);
        if (!node) throw new Error("document_node_materialization_failed");
        const occurrence = addOccurrence(
          node.nodeId,
          unit.path,
          evidenceRange(item.range),
          "document",
          unit.sourceArtifactId,
        );
        addRelationship({
          contentFingerprint,
          discriminator: `document-node:${unit.path}:${item.id}`,
          extractionMethod: "structured-parser",
          extractorFingerprint: unit.facts.sourceDigest,
          kind: "contains",
          occurrence,
          resolutionStatus: "explicit",
          sourceNodeId: item.parentId
            ? (documentNodes.get(item.parentId)?.nodeId ?? file.nodeId)
            : file.nodeId,
          targetNodeId: node.nodeId,
        });
      }
      for (const item of unit.facts.references) {
        const target = item.resolvedSymbolId
          ? symbolNodes.get(`${unit.path}:${item.resolvedSymbolId}`)
          : undefined;
        const resolved =
          target ??
          resolveTarget(item.target, unit.path, contentFingerprint).node;
        const occurrence = addOccurrence(
          file.nodeId,
          unit.path,
          evidenceRange(item.range),
          "reference",
          unit.sourceArtifactId,
        );
        addRelationship({
          confidence: target ? 1 : 0,
          contentFingerprint,
          discriminator: `document-reference:${unit.path}:${item.id}`,
          extractionMethod: "structured-parser",
          extractorFingerprint: unit.facts.sourceDigest,
          kind:
            item.kind === "link" || item.kind === "wikilink"
              ? "links"
              : "documents",
          occurrence,
          resolutionStatus: target ? "resolved" : "unresolved",
          sourceNodeId: file.nodeId,
          targetNodeId: resolved.nodeId,
        });
      }
      continue;
    }

    const projectNodes = new Map<string, GraphNode>();
    for (const item of unit.facts.nodes) {
      const node = addNode(
        `project:${scope.repositoryId}:${unit.path}:${item.id}`,
        item.kind === "package" ? "package" : "module",
        contentFingerprint,
        [{ key: "name", value: item.name }],
      );
      projectNodes.set(item.id, node);
    }
    for (const item of unit.facts.nodes) {
      const node = projectNodes.get(item.id);
      if (!node) throw new Error("project_node_materialization_failed");
      const occurrence = addOccurrence(
        node.nodeId,
        unit.path,
        evidenceRange(item.range),
        "declaration",
        unit.sourceArtifactId,
      );
      addRelationship({
        contentFingerprint,
        discriminator: `project-node:${unit.path}:${item.id}`,
        extractionMethod: "structured-parser",
        extractorFingerprint: unit.facts.parserFingerprint,
        kind: "contains",
        occurrence,
        resolutionStatus: "explicit",
        sourceNodeId: item.parentId
          ? (projectNodes.get(item.parentId)?.nodeId ?? file.nodeId)
          : file.nodeId,
        targetNodeId: node.nodeId,
      });
    }
    for (const item of unit.facts.relationships) {
      const source = item.sourceNodeId
        ? (projectNodes.get(item.sourceNodeId) ?? file)
        : file;
      const target = addNode(
        `package:${item.target}`,
        item.kind === "dependency" ? "package" : "external-reference",
        sha256(item.target),
        [{ key: "target", value: item.target }],
      );
      const occurrence = addOccurrence(
        source.nodeId,
        unit.path,
        evidenceRange(item.range),
        "reference",
        unit.sourceArtifactId,
      );
      addRelationship({
        contentFingerprint,
        discriminator: `project-relation:${unit.path}:${item.id}`,
        extractionMethod: "structured-parser",
        extractorFingerprint: unit.facts.parserFingerprint,
        kind: item.kind === "dependency" ? "depends-on" : "references",
        occurrence,
        resolutionStatus: "explicit",
        sourceNodeId: source.nodeId,
        targetNodeId: target.nodeId,
      });
    }
  }

  const memberships = createGraphMemberships(scope, {
    edges: edges.keys(),
    evidence: evidence.keys(),
    nodes: nodes.keys(),
    occurrences: occurrences.keys(),
  });

  return GraphSnapshotSchema.parse({
    edges: sorted(edges.values(), "edgeId"),
    evidence: sorted(evidence.values(), "evidenceId"),
    memberships: sorted(memberships, "membershipId"),
    nodes: sorted(nodes.values(), "nodeId"),
    occurrences: sorted(occurrences.values(), "occurrenceId"),
    scope,
  });
}

import {
  type Language,
  Parser,
  type Node as SyntaxNode,
} from "web-tree-sitter";

import {
  SourceCoordinateIndex,
  type SyntaxDiagnostic,
  type SyntaxFacts,
  sha256,
  stableNodeId,
} from "../../parser/index.ts";

type SyntaxRange = SyntaxFacts["nodes"][number]["range"];

export function createTreeSitterTraversal(includeAnonymous = false): {
  descendants: (node: SyntaxNode) => SyntaxNode[];
  fieldOrFirst: (
    node: SyntaxNode,
    field: string,
    types: readonly string[],
  ) => SyntaxNode | undefined;
  first: (node: SyntaxNode, types: readonly string[]) => SyntaxNode | undefined;
} {
  const descendants = (node: SyntaxNode): SyntaxNode[] => {
    const result: SyntaxNode[] = [];
    const visit = (current: SyntaxNode) => {
      result.push(current);
      const children = includeAnonymous
        ? current.children
        : current.namedChildren;
      for (const child of children) visit(child);
    };
    visit(node);
    return result;
  };
  const first = (node: SyntaxNode, types: readonly string[]) =>
    descendants(node).find((candidate) => types.includes(candidate.type));
  return {
    descendants,
    fieldOrFirst: (node, field, types) =>
      node.childForFieldName(field) ?? first(node, types),
    first,
  };
}

export function createTreeSitterFactContext(source: string): {
  exactRange: (node: SyntaxNode) => SyntaxRange;
  id: (kind: string, node: SyntaxNode, name: string) => string;
  sourceDigest: string;
} {
  const sourceDigest = sha256(source);
  const coordinates = new SourceCoordinateIndex(source);
  return {
    exactRange: (node) => coordinates.range(node.startIndex, node.endIndex),
    id: (kind, node, name) =>
      sha256(JSON.stringify([sourceDigest, kind, name, node.startIndex])),
    sourceDigest,
  };
}

export function treeSitterDiagnostics(
  nodes: readonly SyntaxNode[],
  exactRange: (node: SyntaxNode) => SyntaxRange,
): SyntaxDiagnostic[] {
  return nodes
    .filter((node) => node.type === "ERROR" || node.isMissing)
    .map((node) => ({
      code: node.isMissing ? "missing-node" : "parse-error",
      message: node.isMissing
        ? "Tree-sitter inserted a missing node"
        : "Tree-sitter recovered from malformed source",
      range: exactRange(node),
      severity: "error",
    }));
}

export function normalizeTreeSitterNodes(
  nodes: readonly SyntaxNode[],
  sourceDigest: string,
  exactRange: (node: SyntaxNode) => SyntaxRange,
  restrictLinks = false,
): SyntaxFacts["nodes"] {
  const nodeIds = restrictLinks ? new Set(nodes.map((node) => node.id)) : null;
  return nodes.map((node) => ({
    childIds: node.namedChildren
      .filter((child) => !nodeIds || nodeIds.has(child.id))
      .map((child) =>
        stableNodeId(
          sourceDigest,
          child.type,
          child.startIndex,
          child.endIndex,
        ),
      ),
    id: stableNodeId(sourceDigest, node.type, node.startIndex, node.endIndex),
    kind: node.type,
    named: node.isNamed,
    parentId:
      node.parent && (!nodeIds || nodeIds.has(node.parent.id))
        ? stableNodeId(
            sourceDigest,
            node.parent.type,
            node.parent.startIndex,
            node.parent.endIndex,
          )
        : null,
    range: exactRange(node),
  }));
}

export async function parseTreeSitter(
  grammar: Language,
  source: string,
  buildFacts: (root: SyntaxNode) => SyntaxFacts,
): Promise<SyntaxFacts> {
  const parser = new Parser();
  try {
    parser.setLanguage(grammar);
    const tree = parser.parse(source);
    if (!tree) throw new Error("Tree-sitter returned no syntax tree");
    try {
      return buildFacts(tree.rootNode);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

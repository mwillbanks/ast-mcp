import type { Node as SyntaxNode } from "web-tree-sitter";
import {
  type SyntaxCall,
  type SyntaxDiagnostic,
  type SyntaxExport,
  type SyntaxFacts,
  type SyntaxImport,
  type SyntaxReference,
  type SyntaxRelationship,
  type SyntaxSymbol,
  type SyntaxSymbolKind,
  sha256,
  stableNodeId,
} from "../../parser/index.ts";

type SyntaxRange = SyntaxFacts["nodes"][number]["range"];
type FactId = (kind: string, node: SyntaxNode, name: string) => string;

export const TREE_SITTER_CALL_NODE_TYPES = [
  "call",
  "function_call_expression",
  "member_call_expression",
  "scoped_call_expression",
  "function_call",
  "call_expression",
] as const;

export function createTreeSitterSymbol(options: {
  exactRange: (node: SyntaxNode) => SyntaxRange;
  exported: boolean;
  id: FactId;
  kind: SyntaxSymbolKind;
  nameNode: SyntaxNode;
  node: SyntaxNode;
}): SyntaxSymbol {
  const name = options.nameNode.text;
  return {
    declarationRange: options.exactRange(options.nameNode),
    exported: options.exported,
    id: options.id("symbol", options.nameNode, name),
    kind: options.kind,
    name,
    qualifiedName: name,
    range: options.exactRange(options.node),
  };
}

export function createTreeSitterSymbolLookup(
  symbols: readonly SyntaxSymbol[],
): (node: SyntaxNode) => string | null {
  return (node) => {
    const owner = [...symbols]
      .reverse()
      .find(
        (symbol) =>
          symbol.range.startCoordinate.utf16Offset <= node.startIndex &&
          symbol.range.endCoordinate.utf16Offset >= node.endIndex,
      );
    return owner?.id ?? null;
  };
}

export function appendTreeSitterImport(options: {
  exactRange: (node: SyntaxNode) => SyntaxRange;
  id: FactId;
  importedName: string;
  imports: SyntaxImport[];
  localNode?: SyntaxNode;
  node: SyntaxNode;
  sourceName: string;
  sourceNode: SyntaxNode;
}): void {
  const localName =
    options.localNode?.text ??
    options.sourceName.split(/[.:/\\]/).at(-1) ??
    options.sourceName;
  options.imports.push({
    id: options.id(
      "import",
      options.sourceNode,
      `${options.sourceName}:${localName}`,
    ),
    importedName: options.importedName,
    localName,
    range: options.exactRange(options.node),
    source: options.sourceName,
    typeOnly: false,
  });
}

export function createTreeSitterCall(options: {
  callee: SyntaxNode;
  exactRange: (node: SyntaxNode) => SyntaxRange;
  id: FactId;
  node: SyntaxNode;
  symbolAt: (node: SyntaxNode) => string | null;
}): SyntaxCall {
  const name = options.callee.text;
  return {
    callee: name,
    enclosingSymbolId: options.symbolAt(options.node),
    id: options.id("call", options.callee, name),
    range: options.exactRange(options.node),
  };
}

export function treeSitterSymbolKind(node: SyntaxNode): SyntaxSymbolKind {
  if (node.type.includes("class") || node.type.includes("struct"))
    return "class";
  if (node.type.includes("interface") || node.type.includes("protocol")) {
    return "interface";
  }
  if (node.type.includes("module")) return "namespace";
  if (node.type.includes("type")) return "type";
  if (node.type.includes("enum")) return "enum";
  return node.type.includes("method") ? "method" : "function";
}

export function collectTreeSitterExports(options: {
  exactRange: (node: SyntaxNode) => SyntaxRange;
  id: FactId;
  first: (node: SyntaxNode, types: readonly string[]) => SyntaxNode | undefined;
  imports: readonly SyntaxImport[];
  languageId: string;
  linkImportSources?: boolean;
  nodes: readonly SyntaxNode[];
  symbols: readonly SyntaxSymbol[];
}): SyntaxExport[] {
  const exports: SyntaxExport[] = [];
  for (const node of options.nodes) {
    if (options.languageId === "julia" && node.type === "export_statement") {
      for (const nameNode of node.namedChildren.filter(
        (child) => child.type === "identifier",
      )) {
        exports.push({
          exportedName: nameNode.text,
          id: options.id("export", nameNode, nameNode.text),
          localName: nameNode.text,
          range: options.exactRange(nameNode),
          source: null,
          typeOnly: false,
        });
      }
    }
    if (
      (options.languageId === "lua" || options.languageId === "luau") &&
      node.type === "return_statement"
    ) {
      const nameNode = options.first(node, ["identifier"]);
      if (nameNode) {
        exports.push({
          exportedName: nameNode.text,
          id: options.id("export", nameNode, nameNode.text),
          localName: nameNode.text,
          range: options.exactRange(nameNode),
          source: null,
          typeOnly: false,
        });
      }
    }
  }
  for (const symbol of options.symbols.filter(
    (candidate) => candidate.exported,
  )) {
    exports.push({
      exportedName: symbol.name,
      id: sha256(JSON.stringify([symbol.id, "export"])),
      localName: symbol.name,
      range: symbol.declarationRange,
      source: null,
      typeOnly: symbol.kind === "type",
    });
  }
  if (options.linkImportSources) {
    for (const item of exports) {
      const imported = options.imports.find(
        (candidate) => candidate.localName === item.localName,
      );
      if (imported) item.source = imported.source;
    }
  }
  return exports;
}

export function assembleTreeSitterFacts(options: {
  calls: SyntaxCall[];
  diagnostics: SyntaxDiagnostic[];
  exports: SyntaxExport[];
  extractorFingerprint: string;
  grammarFingerprint: string;
  implementations: SyntaxRelationship[];
  imports: SyntaxImport[];
  inheritance: SyntaxRelationship[];
  languageId: string;
  nodes: SyntaxFacts["nodes"];
  parserFingerprint: string;
  partial: boolean;
  references: SyntaxReference[];
  sourceDigest: string;
  symbols: SyntaxSymbol[];
  includeImplementationsInArtifact?: boolean;
}): SyntaxFacts {
  const artifactParts: unknown[] = [
    options.sourceDigest,
    options.extractorFingerprint,
    options.symbols.map((item) => item.id),
    options.imports.map((item) => item.id),
    options.calls.map((item) => item.id),
    options.inheritance.map((item) => item.id),
  ];
  if (options.includeImplementationsInArtifact) {
    artifactParts.push(options.implementations.map((item) => item.id));
  }
  artifactParts.push(options.exports.map((item) => item.id));
  return {
    calls: options.calls,
    diagnostics: options.diagnostics,
    exports: options.exports,
    extractorFingerprint: options.extractorFingerprint,
    grammarFingerprint: options.grammarFingerprint,
    implementations: options.implementations,
    imports: options.imports,
    inheritance: options.inheritance,
    languageId: options.languageId,
    nodes: options.nodes,
    parserFingerprint: options.parserFingerprint,
    partial: options.partial,
    references: options.references,
    rootNodeId:
      options.nodes[0]?.id ?? stableNodeId(options.sourceDigest, "root", 0, 0),
    schemaVersion: "ast-mcp.syntax-facts.v1",
    sourceArtifactId: sha256(JSON.stringify(["source", options.sourceDigest])),
    sourceDigest: options.sourceDigest,
    symbols: options.symbols,
    syntaxFactsArtifactId: sha256(JSON.stringify(artifactParts)),
  };
}

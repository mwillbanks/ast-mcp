import { parse, type SgNode } from "@ast-grep/napi";
import {
  sourceArtifactIdentity,
  syntaxFactsArtifactIdentity,
} from "../contracts/artifacts.ts";
import { SourceCoordinateIndex, sha256, stableNodeId } from "./coordinates.ts";
import {
  DEFAULT_EXTRACTOR_VERSION,
  defaultLanguageRegistry,
  type GrammarDescriptor,
  type LanguageRegistry,
} from "./registry.ts";
import {
  type ExactSourceRange,
  type NormalizedSyntaxNode,
  ParserError,
  type ParseSourceRequest,
  type SyntaxCall,
  type SyntaxDiagnostic,
  type SyntaxExport,
  type SyntaxFacts,
  type SyntaxImport,
  type SyntaxReference,
  type SyntaxRelationship,
  type SyntaxSymbol,
  type SyntaxSymbolKind,
} from "./types.ts";

interface ExtractorState {
  calls: SyntaxCall[];
  coordinates: SourceCoordinateIndex;
  diagnostics: SyntaxDiagnostic[];
  exports: SyntaxExport[];
  implementations: SyntaxRelationship[];
  imports: SyntaxImport[];
  inheritance: SyntaxRelationship[];
  maxNodes: number;
  nodes: NormalizedSyntaxNode[];
  references: SyntaxReference[];
  sourceDigest: string;
  symbols: SyntaxSymbol[];
  truncated: boolean;
}

const symbolKinds = new Map<string, SyntaxSymbolKind>([
  ["class_declaration", "class"],
  ["abstract_class_declaration", "class"],
  ["interface_declaration", "interface"],
  ["function_declaration", "function"],
  ["generator_function_declaration", "function"],
  ["method_definition", "method"],
  ["method_signature", "method"],
  ["type_alias_declaration", "type"],
  ["enum_declaration", "enum"],
  ["internal_module", "namespace"],
  ["module", "namespace"],
]);

const identifierKinds = new Set([
  "identifier",
  "type_identifier",
  "property_identifier",
  "shorthand_property_identifier",
]);

function idFor(sourceDigest: string, kind: string, values: unknown[]): string {
  return sha256(JSON.stringify([sourceDigest, kind, ...values]));
}

function unquote(value: string): string {
  return value.trim().slice(1, -1);
}

function nodeRange(
  state: Pick<ExtractorState, "coordinates">,
  node: SgNode,
): ExactSourceRange {
  return state.coordinates.fromAstRange(node.range());
}

const kindOf = (node: SgNode): string => String(node.kind());

function firstNamed(node: SgNode, kinds: readonly string[]): SgNode | null {
  for (const child of node.namedChildren()) {
    if (kinds.includes(kindOf(child))) return child;
  }
  return null;
}

function declarationName(node: SgNode): SgNode | null {
  const fieldName = node.field("name");
  if (fieldName) return fieldName;
  return firstNamed(node, [
    "identifier",
    "type_identifier",
    "property_identifier",
  ]);
}

function bindingIdentifiers(pattern: SgNode): SgNode[] {
  const kind = kindOf(pattern);
  if (
    kind === "identifier" ||
    kind === "shorthand_property_identifier_pattern"
  ) {
    return [pattern];
  }
  if (kind === "pair_pattern") {
    const value = pattern.field("value") ?? pattern.namedChildren().at(-1);
    return value ? bindingIdentifiers(value) : [];
  }
  if (kind === "assignment_pattern" || kind === "object_assignment_pattern") {
    const left = pattern.field("left") ?? pattern.namedChildren()[0];
    return left ? bindingIdentifiers(left) : [];
  }
  if (kind === "rest_pattern") {
    const argument = pattern.field("argument") ?? pattern.namedChildren()[0];
    return argument ? bindingIdentifiers(argument) : [];
  }
  return pattern.namedChildren().flatMap((child) => bindingIdentifiers(child));
}

function isExported(node: SgNode): boolean {
  let current = node.parent();
  while (current) {
    const kind = kindOf(current);
    if (kind === "export_statement") return true;
    if (kind === "program" || kind === "class_body") return false;
    current = current.parent();
  }
  return false;
}

function symbolsFromNode(
  state: ExtractorState,
  node: SgNode,
  enclosingSymbol: SyntaxSymbol | null,
): SyntaxSymbol[] {
  const declaredKind = symbolKinds.get(kindOf(node));
  const nameNodes =
    node.kind() === "variable_declarator"
      ? bindingIdentifiers(
          node.field("name") ?? node.namedChildren()[0] ?? node,
        )
      : declaredKind
        ? [declarationName(node)].filter(
            (candidate): candidate is SgNode => candidate !== null,
          )
        : [];
  const symbolKind =
    node.kind() === "variable_declarator" ? "variable" : declaredKind;
  if (!symbolKind || nameNodes.length === 0) return [];
  const range = nodeRange(state, node);
  return nameNodes.map((nameNode) => {
    const name = nameNode.text();
    const qualifiedName = enclosingSymbol
      ? `${enclosingSymbol.qualifiedName}.${name}`
      : name;
    return {
      declarationRange: nodeRange(state, nameNode),
      exported: isExported(node),
      id: idFor(state.sourceDigest, "symbol", [
        symbolKind,
        qualifiedName,
        range.startCoordinate.utf16Offset,
        range.endCoordinate.utf16Offset,
      ]),
      kind: symbolKind,
      name,
      qualifiedName,
      range,
    };
  });
}

function extractImport(state: ExtractorState, node: SgNode): void {
  const sourceNode = [...node.namedChildren()]
    .reverse()
    .find((child) => child.kind() === "string");
  if (!sourceNode) return;
  const source = unquote(sourceNode.text());
  const text = node.text();
  const typeOnly = /^import\s+type\b/.test(text);
  const clause = node
    .namedChildren()
    .find((child) => child.kind() === "import_clause");
  const entries: Array<{ importedName: string; localName: string }> = [];
  if (!clause) {
    entries.push({ importedName: "*side-effect*", localName: "*side-effect*" });
  } else {
    const defaultName = clause
      .namedChildren()
      .find((child) => child.kind() === "identifier");
    if (defaultName) {
      entries.push({ importedName: "default", localName: defaultName.text() });
    }
    const namespace = clause
      .namedChildren()
      .find((child) => child.kind() === "namespace_import");
    if (namespace) {
      const local = namespace
        .namedChildren()
        .find((child) => child.kind() === "identifier");
      if (local) entries.push({ importedName: "*", localName: local.text() });
    }
    const named = clause
      .namedChildren()
      .find((child) => child.kind() === "named_imports");
    for (const specifier of named?.namedChildren() ?? []) {
      if (specifier.kind() !== "import_specifier") continue;
      const identifiers = specifier
        .namedChildren()
        .filter((child) => identifierKinds.has(kindOf(child)));
      const importedName = identifiers[0]?.text();
      if (!importedName) continue;
      entries.push({
        importedName,
        localName: identifiers.at(-1)?.text() ?? importedName,
      });
    }
  }
  const range = nodeRange(state, node);
  for (const entry of entries) {
    state.imports.push({
      id: idFor(state.sourceDigest, "import", [
        source,
        entry.importedName,
        entry.localName,
        range.startCoordinate.utf16Offset,
      ]),
      importedName: entry.importedName,
      localName: entry.localName,
      range,
      source,
      typeOnly,
    });
  }
}

function extractExport(state: ExtractorState, node: SgNode): void {
  const range = nodeRange(state, node);
  const sourceNode = [...node.namedChildren()]
    .reverse()
    .find((child) => child.kind() === "string");
  const source = sourceNode ? unquote(sourceNode.text()) : null;
  const typeOnly = /^export\s+type\b/.test(node.text());
  const declaration = node
    .namedChildren()
    .find((child) =>
      [
        ...symbolKinds.keys(),
        "lexical_declaration",
        "variable_declaration",
      ].includes(kindOf(child)),
    );
  const entries: Array<{ exportedName: string; localName: string | null }> = [];
  if (declaration) {
    if (
      ["lexical_declaration", "variable_declaration"].includes(
        kindOf(declaration),
      )
    ) {
      for (const child of declaration.namedChildren()) {
        const name = declarationName(child)?.text();
        if (name) entries.push({ exportedName: name, localName: name });
      }
    } else {
      const name = declarationName(declaration)?.text();
      if (name) entries.push({ exportedName: name, localName: name });
    }
  }
  const clause = node
    .namedChildren()
    .find((child) => child.kind() === "export_clause");
  for (const specifier of clause?.namedChildren() ?? []) {
    const identifiers = specifier
      .namedChildren()
      .filter((child) => identifierKinds.has(kindOf(child)));
    const localName = identifiers[0]?.text();
    if (!localName) continue;
    entries.push({
      exportedName: identifiers.at(-1)?.text() ?? localName,
      localName,
    });
  }
  if (/^export\s+default\b/.test(node.text())) {
    entries.push({
      exportedName: "default",
      localName: entries[0]?.localName ?? null,
    });
  }
  if (/^export\s+\*/.test(node.text())) {
    entries.push({ exportedName: "*", localName: null });
  }
  for (const entry of entries) {
    state.exports.push({
      exportedName: entry.exportedName,
      id: idFor(state.sourceDigest, "export", [
        entry.exportedName,
        entry.localName,
        source,
        range.startCoordinate.utf16Offset,
      ]),
      localName: entry.localName,
      range,
      source,
      typeOnly,
    });
  }
}

function extractCall(
  state: ExtractorState,
  node: SgNode,
  enclosingSymbol: SyntaxSymbol | null,
): void {
  const functionNode =
    node.field("function") ?? node.namedChildren()[0] ?? null;
  if (!functionNode) return;
  const range = nodeRange(state, node);
  state.calls.push({
    callee: functionNode.text(),
    enclosingSymbolId: enclosingSymbol?.id ?? null,
    id: idFor(state.sourceDigest, "call", [
      functionNode.text(),
      range.startCoordinate.utf16Offset,
    ]),
    range,
  });
}

function extractRelationship(
  state: ExtractorState,
  node: SgNode,
  enclosingSymbol: SyntaxSymbol | null,
  target: SyntaxRelationship[],
  kind: string,
): void {
  for (const child of node.namedChildren()) {
    const range = nodeRange(state, child);
    target.push({
      id: idFor(state.sourceDigest, kind, [
        enclosingSymbol?.id ?? null,
        child.text(),
        range.startCoordinate.utf16Offset,
      ]),
      range,
      sourceSymbolId: enclosingSymbol?.id ?? null,
      targetName: child.text(),
    });
  }
}

function referenceRole(node: SgNode): SyntaxReference["role"] {
  if (node.kind() === "type_identifier") return "type";
  const parent = node.parent();
  if (!parent) return "read";
  if (
    [
      "variable_declarator",
      "required_parameter",
      "optional_parameter",
    ].includes(kindOf(parent)) &&
    declarationName(parent)?.id() === node.id()
  ) {
    return "write";
  }
  const left = parent.field("left");
  return left?.id() === node.id() ? "write" : "read";
}

function visit(
  state: ExtractorState,
  node: SgNode,
  parentId: string | null,
  enclosingSymbol: SyntaxSymbol | null,
): string | null {
  if (state.nodes.length >= state.maxNodes) {
    if (!state.truncated) {
      state.truncated = true;
      state.diagnostics.push({
        code: "truncated",
        message: "Syntax node limit reached",
        range: nodeRange(state, node),
        severity: "warning",
      });
    }
    return null;
  }

  const range = nodeRange(state, node);
  const nodeId = stableNodeId(
    state.sourceDigest,
    kindOf(node),
    range.startCoordinate.utf16Offset,
    range.endCoordinate.utf16Offset,
  );
  const normalized: NormalizedSyntaxNode = {
    childIds: [],
    id: nodeId,
    kind: kindOf(node),
    named: node.isNamed(),
    parentId,
    range,
  };
  state.nodes.push(normalized);

  if (node.kind() === "ERROR" || node.kind() === "error") {
    state.diagnostics.push({
      code: "parse-error",
      message: "Parser recovered from malformed source",
      range,
      severity: "error",
    });
  } else if (kindOf(node).startsWith("MISSING")) {
    state.diagnostics.push({
      code: "missing-node",
      message: "Parser inserted a missing syntax node",
      range,
      severity: "error",
    });
  }

  const symbols = symbolsFromNode(state, node, enclosingSymbol);
  state.symbols.push(...symbols);
  const currentSymbol = symbols[0] ?? enclosingSymbol;

  if (node.kind() === "import_statement") extractImport(state, node);
  if (node.kind() === "export_statement") extractExport(state, node);
  if (node.kind() === "call_expression") {
    extractCall(state, node, currentSymbol);
  }
  if (node.kind() === "extends_clause") {
    extractRelationship(
      state,
      node,
      currentSymbol,
      state.inheritance,
      "inheritance",
    );
  }
  if (node.kind() === "implements_clause") {
    extractRelationship(
      state,
      node,
      currentSymbol,
      state.implementations,
      "implementation",
    );
  }
  if (identifierKinds.has(kindOf(node))) {
    state.references.push({
      enclosingSymbolId: currentSymbol?.id ?? null,
      id: idFor(state.sourceDigest, "reference", [
        node.text(),
        range.startCoordinate.utf16Offset,
      ]),
      name: node.text(),
      range,
      role: referenceRole(node),
    });
  }

  for (const child of node.namedChildren()) {
    const childId = visit(state, child, nodeId, currentSymbol);
    if (childId) normalized.childIds.push(childId);
  }
  return nodeId;
}

function sortedByRange<T extends { range: ExactSourceRange }>(
  values: T[],
): T[] {
  return values.sort(
    (left, right) =>
      left.range.startCoordinate.utf16Offset -
        right.range.startCoordinate.utf16Offset ||
      left.range.endCoordinate.utf16Offset -
        right.range.endCoordinate.utf16Offset,
  );
}

export function parseSource(
  request: ParseSourceRequest,
  registry: LanguageRegistry = defaultLanguageRegistry,
): SyntaxFacts {
  if (
    request.maxNodes !== undefined &&
    (!Number.isFinite(request.maxNodes) ||
      !Number.isInteger(request.maxNodes) ||
      request.maxNodes < 1)
  ) {
    throw new ParserError({
      code: "invalid-request",
      message: "Parser maxNodes must be a finite positive integer",
      retryable: false,
    });
  }
  const sourceDigest = sha256(request.source);
  let grammar: GrammarDescriptor;
  try {
    grammar = registry.get(request.languageId);
  } catch (error) {
    throw new ParserError({
      code: "invalid-language",
      message: error instanceof Error ? error.message : "Unsupported language",
      retryable: false,
    });
  }
  const grammarFingerprint = request.grammarVersion
    ? sha256(
        JSON.stringify([grammar.grammarFingerprint, request.grammarVersion]),
      )
    : grammar.grammarFingerprint;
  const extractorFingerprint = sha256(
    JSON.stringify([
      request.languageId,
      request.extractorVersion ?? DEFAULT_EXTRACTOR_VERSION,
    ]),
  );
  const parserFingerprint = sha256(
    JSON.stringify([grammarFingerprint, extractorFingerprint]),
  );
  const sourceArtifactId = sourceArtifactIdentity({
    contentDigest: sourceDigest,
  });
  const syntaxFactsArtifactId = syntaxFactsArtifactIdentity({
    languageId: request.languageId,
    parserFingerprint,
    sourceArtifactId,
  });

  registry.registerDynamicGrammars();
  const root = parse(grammar.astGrepLanguage, request.source).root();
  const state: ExtractorState = {
    calls: [],
    coordinates: new SourceCoordinateIndex(request.source),
    diagnostics: [],
    exports: [],
    implementations: [],
    imports: [],
    inheritance: [],
    maxNodes: request.maxNodes ?? 250_000,
    nodes: [],
    references: [],
    sourceDigest,
    symbols: [],
    truncated: false,
  };
  const rootNodeId = visit(state, root, null, null);
  if (!rootNodeId) {
    throw new ParserError({
      code: "worker-error",
      message: "Parser produced no root syntax node",
      retryable: false,
    });
  }
  return {
    calls: sortedByRange(state.calls),
    diagnostics: sortedByRange(state.diagnostics),
    exports: sortedByRange(state.exports),
    extractorFingerprint,
    grammarFingerprint,
    implementations: sortedByRange(state.implementations),
    imports: sortedByRange(state.imports),
    inheritance: sortedByRange(state.inheritance),
    languageId: request.languageId,
    nodes: state.nodes,
    parserFingerprint,
    partial: state.diagnostics.length > 0,
    references: sortedByRange(state.references),
    rootNodeId,
    schemaVersion: "ast-mcp.syntax-facts.v1",
    sourceArtifactId,
    sourceDigest,
    symbols: sortedByRange(state.symbols),
    syntaxFactsArtifactId,
  };
}

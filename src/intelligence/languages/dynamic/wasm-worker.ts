import { parentPort } from "node:worker_threads";
import { getWasmPath } from "tree-sitter-wasm";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";
import {
  SourceCoordinateIndex,
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
import {
  type DynamicWorkerResult,
  type DynamicWorkerStart,
  isDynamicWorkerId,
  isDynamicWorkerRequest,
} from "./protocol.ts";
import type { DynamicLanguageId } from "./types.ts";

function send(result: DynamicWorkerResult): void {
  parentPort?.postMessage(result);
}

const languages = new Map<string, Language>();
let initialized: Promise<void> | undefined;

async function language(languageId: DynamicLanguageId) {
  initialized ??= Parser.init();
  await initialized;
  let loaded = languages.get(languageId);
  if (!loaded) {
    loaded = await Language.load(
      getWasmPath(languageId === "luau" ? "lua" : languageId),
    );
    languages.set(languageId, loaded);
  }
  return loaded;
}

function descendants(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const visit = (current: SyntaxNode) => {
    result.push(current);
    for (const child of current.namedChildren) visit(child);
  };
  visit(node);
  return result;
}

function first(
  node: SyntaxNode,
  types: readonly string[],
): SyntaxNode | undefined {
  return descendants(node).find((candidate) => types.includes(candidate.type));
}

function fieldOrFirst(
  node: SyntaxNode,
  field: string,
  types: readonly string[],
): SyntaxNode | undefined {
  return node.childForFieldName(field) ?? first(node, types);
}

function symbolKind(node: SyntaxNode): SyntaxSymbolKind {
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

function byteToUtf16(source: string, byte: number): number {
  let utf16 = 0;
  let consumed = 0;
  for (const character of source) {
    if (consumed >= byte) break;
    consumed += new TextEncoder().encode(character).byteLength;
    utf16 += character.length;
  }
  return utf16;
}

function buildFacts(
  languageId: DynamicLanguageId,
  source: string,
  root: SyntaxNode,
): SyntaxFacts {
  const sourceDigest = sha256(source);
  const coordinates = new SourceCoordinateIndex(source);
  const nodes = descendants(root);
  const exactRange = (node: SyntaxNode) =>
    coordinates.range(
      byteToUtf16(source, node.startIndex),
      byteToUtf16(source, node.endIndex),
    );
  const id = (kind: string, node: SyntaxNode, name: string) =>
    sha256(JSON.stringify([sourceDigest, kind, name, node.startIndex]));
  const symbolNodes = nodes.filter((node) => {
    if (languageId === "r" && node.type === "function_definition") return false;
    if (
      [
        "class_definition",
        "function_definition",
        "class",
        "method",
        "singleton_method",
        "class_declaration",
        "interface_declaration",
        "trait_declaration",
        "enum_declaration",
        "method_declaration",
        "function_declaration",
        "struct_definition",
        "abstract_definition",
        "macro_definition",
      ].includes(node.type)
    ) {
      return true;
    }
    if (languageId === "ruby" && node.type === "module") return true;
    if (languageId === "r") {
      return (
        node.type === "binary_operator" &&
        node.childForFieldName("rhs")?.type === "function_definition"
      );
    }
    if (languageId === "elixir" && node.type === "call") {
      const target = node.childForFieldName("target")?.text;
      return [
        "defmodule",
        "defprotocol",
        "defimpl",
        "def",
        "defp",
        "defmacro",
        "defmacrop",
      ].includes(target ?? "");
    }
    return false;
  });
  const symbols: SyntaxSymbol[] = symbolNodes.flatMap((node) => {
    let nameNode = fieldOrFirst(node, "name", [
      "identifier",
      "constant",
      "name",
      "alias",
    ]);
    if (languageId === "r")
      nameNode = node.childForFieldName("lhs") ?? nameNode;
    if (languageId === "elixir") {
      const argumentNode =
        node.childForFieldName("arguments") ?? first(node, ["arguments"]);
      nameNode = argumentNode
        ? first(argumentNode, ["alias", "identifier", "call"])
        : undefined;
      if (nameNode?.type === "call") {
        nameNode = nameNode.childForFieldName("target") ?? nameNode;
      }
    }
    if (!nameNode) return [];
    const name = nameNode.text;
    const kind =
      languageId === "elixir" &&
      node.childForFieldName("target")?.text === "defmodule"
        ? "namespace"
        : symbolKind(node);
    return [
      {
        declarationRange: exactRange(nameNode),
        exported:
          languageId === "php" ||
          (languageId === "elixir" &&
            !["defp", "defmacrop"].includes(
              node.childForFieldName("target")?.text ?? "",
            )),
        id: id("symbol", nameNode, name),
        kind,
        name,
        qualifiedName: name,
        range: exactRange(node),
      },
    ];
  });
  const symbolAt = (node: SyntaxNode) => {
    const owner = [...symbols]
      .reverse()
      .find(
        (symbol) =>
          symbol.range.startByte <= node.startIndex &&
          symbol.range.endByte >= node.endIndex,
      );
    return owner?.id ?? null;
  };
  const bindingNodeIds = new Set<string>();
  const readNodeIds = new Set<string>();
  for (const node of nodes) {
    if (
      symbols.some(
        (symbol) =>
          symbol.declarationRange.startByte === node.startIndex &&
          symbol.declarationRange.endByte === node.endIndex,
      )
    ) {
      bindingNodeIds.add(`${node.startIndex}:${node.endIndex}`);
    }
  }
  const imports: SyntaxImport[] = [];
  for (const node of nodes) {
    let sourceNode: SyntaxNode | undefined;
    let localNode: SyntaxNode | undefined;
    let importedName = "*";
    if (["import_statement", "import_from_statement"].includes(node.type)) {
      sourceNode =
        node.childForFieldName("module_name") ??
        fieldOrFirst(node, "name", ["dotted_name"]);
      const aliased = first(node, ["aliased_import"]);
      const importedNode =
        aliased?.childForFieldName("name") ??
        (node.type === "import_from_statement"
          ? descendants(node).find(
              (candidate) =>
                candidate.type === "identifier" &&
                candidate.startIndex >= (sourceNode?.endIndex ?? 0),
            )
          : undefined);
      localNode =
        node.childForFieldName("alias") ??
        aliased?.childForFieldName("alias") ??
        importedNode ??
        first(node, ["identifier"]);
      importedName = importedNode?.text ?? "*";
      if (importedNode) {
        readNodeIds.add(`${importedNode.startIndex}:${importedNode.endIndex}`);
      }
    } else if (
      languageId === "ruby" &&
      node.type === "call" &&
      ["require", "require_relative", "load"].includes(
        node.childForFieldName("method")?.text ?? "",
      )
    ) {
      sourceNode = first(node, ["string_content", "string"]);
    } else if (
      languageId === "php" &&
      [
        "namespace_use_declaration",
        "require_once_expression",
        "require_expression",
        "include_expression",
        "include_once_expression",
      ].includes(node.type)
    ) {
      sourceNode = first(node, ["qualified_name", "string_content"]);
    } else if (
      (languageId === "lua" || languageId === "luau") &&
      node.type === "function_call" &&
      node.childForFieldName("name")?.text === "require"
    ) {
      sourceNode =
        first(node, ["string_content"]) ??
        first(node.childForFieldName("arguments") ?? node, [
          "dot_index_expression",
          "identifier",
        ]);
    } else if (
      languageId === "r" &&
      node.type === "call" &&
      ["library", "require", "source"].includes(
        node.childForFieldName("function")?.text ?? "",
      )
    ) {
      sourceNode =
        first(node, ["string_content"]) ?? first(node, ["identifier"]);
    } else if (
      languageId === "julia" &&
      ["using_statement", "import_statement"].includes(node.type)
    ) {
      const names = descendants(node).filter(
        (candidate) => candidate.type === "identifier",
      );
      sourceNode = names[0];
      localNode = names.at(-1);
      importedName = localNode?.text ?? "*";
    } else if (languageId === "elixir" && node.type === "call") {
      const target = node.childForFieldName("target")?.text;
      if (["alias", "import", "require", "use"].includes(target ?? "")) {
        sourceNode = first(node.childForFieldName("arguments") ?? node, [
          "alias",
        ]);
        localNode = sourceNode;
      }
    }
    if (!sourceNode) continue;
    const sourceName = sourceNode.text.replace(/^["']|["']$/g, "");
    if (localNode)
      bindingNodeIds.add(`${localNode.startIndex}:${localNode.endIndex}`);
    const localName =
      localNode?.text ?? sourceName.split(/[.:/\\]/).at(-1) ?? sourceName;
    imports.push({
      id: id("import", sourceNode, `${sourceName}:${localName}`),
      importedName,
      localName,
      range: exactRange(node),
      source: sourceName,
      typeOnly: false,
    });
  }
  const callTypes = new Set([
    "call",
    "function_call_expression",
    "member_call_expression",
    "scoped_call_expression",
    "function_call",
    "call_expression",
  ]);
  const calls: SyntaxCall[] = nodes.flatMap((node) => {
    if (!callTypes.has(node.type)) return [];
    if (
      node.parent?.type === "signature" ||
      (languageId === "elixir" &&
        node.parent?.type === "arguments" &&
        ["def", "defp", "defmodule", "defmacro", "defmacrop"].includes(
          node.parent.parent?.childForFieldName("target")?.text ?? "",
        ))
    ) {
      return [];
    }
    const callee =
      node.childForFieldName("function") ??
      node.childForFieldName("name") ??
      node.childForFieldName("method") ??
      node.childForFieldName("target") ??
      first(node, [
        "field_expression",
        "dot_index_expression",
        "dot",
        "identifier",
      ]);
    if (!callee) return [];
    const name = callee.text;
    if (
      [
        "require",
        "require_relative",
        "load",
        "library",
        "source",
        "using",
        "import",
      ].includes(name) ||
      (languageId === "elixir" &&
        [
          "alias",
          "use",
          "def",
          "defp",
          "defmodule",
          "defmacro",
          "defmacrop",
          "behaviour",
        ].includes(name))
    ) {
      return [];
    }
    return [
      {
        callee: name,
        enclosingSymbolId: symbolAt(node),
        id: id("call", callee, name),
        range: exactRange(node),
      },
    ];
  });
  const inheritance: SyntaxRelationship[] = [];
  for (const symbolNode of symbolNodes) {
    const containers = [
      symbolNode.childForFieldName("superclasses"),
      symbolNode.childForFieldName("superclass"),
      ...symbolNode.namedChildren.filter((child) =>
        ["base_clause", "class_interface_clause"].includes(child.type),
      ),
    ].filter((candidate): candidate is SyntaxNode => Boolean(candidate));
    if (languageId === "julia" && symbolNode.type === "struct_definition") {
      const identifiers = descendants(symbolNode).filter(
        (candidate) => candidate.type === "identifier",
      );
      const target = identifiers.at(-1);
      if (target && identifiers.length > 1) containers.push(target);
    }
    for (const target of containers.flatMap((container) =>
      ["identifier", "constant", "name", "alias"].includes(container.type)
        ? [container]
        : descendants(container).filter((candidate) =>
            ["identifier", "constant", "name", "alias"].includes(
              candidate.type,
            ),
          ),
    )) {
      inheritance.push({
        id: id("inheritance", target, target.text),
        range: exactRange(target),
        sourceSymbolId: symbolAt(symbolNode),
        targetName: target.text,
      });
    }
  }
  if (languageId === "r") {
    for (const node of nodes.filter(
      (candidate) =>
        candidate.type === "call" &&
        candidate.childForFieldName("function")?.text === "setClass",
    )) {
      const strings = descendants(node).filter(
        (candidate) => candidate.type === "string_content",
      );
      const target = strings[1];
      if (target) {
        inheritance.push({
          id: id("inheritance", target, target.text),
          range: exactRange(target),
          sourceSymbolId: null,
          targetName: target.text,
        });
      }
    }
  }
  if (languageId === "elixir") {
    for (const node of nodes.filter(
      (candidate) => candidate.type === "unary_operator",
    )) {
      const target = first(node, ["alias"]);
      if (target) {
        inheritance.push({
          id: id("inheritance", target, target.text),
          range: exactRange(target),
          sourceSymbolId: symbolAt(node),
          targetName: target.text,
        });
      }
    }
  }
  const exports: SyntaxExport[] = [];
  for (const node of nodes) {
    if (languageId === "julia" && node.type === "export_statement") {
      for (const nameNode of node.namedChildren.filter(
        (child) => child.type === "identifier",
      )) {
        exports.push({
          exportedName: nameNode.text,
          id: id("export", nameNode, nameNode.text),
          localName: nameNode.text,
          range: exactRange(nameNode),
          source: null,
          typeOnly: false,
        });
      }
    }
    if (
      (languageId === "lua" || languageId === "luau") &&
      node.type === "return_statement"
    ) {
      const nameNode = first(node, ["identifier"]);
      if (nameNode) {
        exports.push({
          exportedName: nameNode.text,
          id: id("export", nameNode, nameNode.text),
          localName: nameNode.text,
          range: exactRange(nameNode),
          source: null,
          typeOnly: false,
        });
      }
    }
  }
  for (const symbol of symbols.filter((candidate) => candidate.exported)) {
    exports.push({
      exportedName: symbol.name,
      id: sha256(JSON.stringify([symbol.id, "export"])),
      localName: symbol.name,
      range: symbol.declarationRange,
      source: null,
      typeOnly: symbol.kind === "type",
    });
  }
  for (const item of exports) {
    const imported = imports.find(
      (candidate) => candidate.localName === item.localName,
    );
    if (imported) item.source = imported.source;
  }
  for (const node of nodes) {
    if (
      calls.some(
        (call) =>
          call.range.startByte <= node.startIndex &&
          call.range.endByte >= node.endIndex,
      )
    ) {
      readNodeIds.add(`${node.startIndex}:${node.endIndex}`);
    }
  }
  const parameterContainers: Record<DynamicLanguageId, readonly string[]> = {
    elixir: [],
    julia: ["argument_list", "parameter_list", "typed_parameter"],
    lua: ["parameters"],
    luau: ["parameters"],
    php: ["formal_parameters", "simple_parameter", "variadic_parameter"],
    python: ["parameters", "lambda_parameters"],
    r: ["parameters", "parameter"],
    ruby: ["method_parameters", "block_parameters", "lambda_parameters"],
  };
  const bindingContainers = new Set([
    ...parameterContainers[languageId],
    "pattern_list",
    "list_pattern",
    "tuple_pattern",
    "table_pattern",
    "array_destructuring",
    "destructuring",
    "list_splat_pattern",
    "map_pattern",
    "pair_pattern",
    "splat_parameter",
  ]);
  const isBindingReference = (node: SyntaxNode): boolean => {
    const nodeId = `${node.startIndex}:${node.endIndex}`;
    if (languageId === "r") {
      let candidate = node.parent;
      while (candidate) {
        const left = candidate.childForFieldName("lhs");
        if (
          left &&
          left.startIndex <= node.startIndex &&
          left.endIndex >= node.endIndex
        ) {
          return true;
        }
        candidate = candidate.parent;
      }
    }
    if (readNodeIds.has(nodeId)) return false;
    if (bindingNodeIds.has(nodeId)) return true;
    let current = node.parent;
    while (current && current.type !== "block" && current.type !== "body") {
      if (current.type.includes("import")) return false;
      if (bindingContainers.has(current.type)) return true;
      if (
        current.type === "variable_list" &&
        current.parent?.type === "assignment_statement"
      ) {
        return true;
      }
      if (
        languageId === "julia" &&
        current.type === "assignment" &&
        current.namedChildren[0]?.startIndex <= node.startIndex &&
        current.namedChildren[0]?.endIndex >= node.endIndex
      ) {
        return true;
      }
      if (
        languageId === "elixir" &&
        current.type === "arguments" &&
        current.parent?.type === "call" &&
        current.parent.parent?.type === "arguments" &&
        ["def", "defp", "defmacro", "defmacrop"].includes(
          current.parent.parent.parent?.childForFieldName("target")?.text ?? "",
        )
      ) {
        return true;
      }
      const parent = current.parent;
      const assignmentTarget =
        current.childForFieldName("left") ??
        current.childForFieldName("lhs") ??
        current.childForFieldName("pattern") ??
        current.childForFieldName("variables") ??
        current.childForFieldName("targets") ??
        parent?.childForFieldName("left") ??
        parent?.childForFieldName("lhs") ??
        parent?.childForFieldName("pattern") ??
        parent?.childForFieldName("variables") ??
        parent?.childForFieldName("targets");
      if (
        assignmentTarget &&
        assignmentTarget.startIndex <= node.startIndex &&
        assignmentTarget.endIndex >= node.endIndex
      ) {
        return true;
      }
      current = parent;
    }
    return false;
  };
  const references: SyntaxReference[] = nodes
    .filter(
      (node) =>
        ["identifier", "constant", "name", "alias", "variable_name"].includes(
          node.type,
        ) && !(node.type === "name" && node.parent?.type === "variable_name"),
    )
    .map((node) => ({
      enclosingSymbolId: symbolAt(node),
      id: id("reference", node, node.text),
      name: node.text,
      range: exactRange(node),
      role: isBindingReference(node) ? "write" : "read",
    }));
  const diagnostics: SyntaxDiagnostic[] = nodes
    .filter((node) => node.type === "ERROR" || node.isMissing)
    .map((node) => ({
      code: node.isMissing ? "missing-node" : "parse-error",
      message: node.isMissing
        ? "Tree-sitter inserted a missing node"
        : "Tree-sitter recovered from malformed source",
      range: exactRange(node),
      severity: "error",
    }));
  const normalized = nodes.map((node) => ({
    childIds: node.namedChildren.map((child) =>
      stableNodeId(sourceDigest, child.type, child.startIndex, child.endIndex),
    ),
    id: stableNodeId(sourceDigest, node.type, node.startIndex, node.endIndex),
    kind: node.type,
    named: node.isNamed,
    parentId: node.parent
      ? stableNodeId(
          sourceDigest,
          node.parent.type,
          node.parent.startIndex,
          node.parent.endIndex,
        )
      : null,
    range: exactRange(node),
  }));
  const invalidRanges = diagnostics.map(({ range }) => range);
  const valid = (range: { startByte: number; endByte: number }) =>
    !invalidRanges.some(
      (invalid) =>
        invalid.startByte <= range.startByte &&
        invalid.endByte >= range.endByte,
    );
  const validSymbols = symbols.filter(
    (item) => valid(item.range) && valid(item.declarationRange),
  );
  const validImports = imports.filter((item) => valid(item.range));
  const validCalls = calls.filter((item) => valid(item.range));
  const validInheritance = inheritance.filter((item) => valid(item.range));
  const validExports = exports.filter((item) => valid(item.range));
  const validReferences = references.filter((item) => valid(item.range));
  const extractorFingerprint = sha256(
    JSON.stringify(["tree-sitter-wasm", "1.1.8", languageId]),
  );
  return {
    calls: validCalls,
    diagnostics,
    exports: validExports,
    extractorFingerprint,
    grammarFingerprint: sha256(
      JSON.stringify(["tree-sitter-wasm", "1.1.8", languageId]),
    ),
    implementations: [],
    imports: validImports,
    inheritance: validInheritance,
    languageId,
    nodes: normalized,
    parserFingerprint: sha256("web-tree-sitter@0.27.0"),
    partial: root.hasError,
    references: validReferences,
    rootNodeId: normalized[0]?.id ?? stableNodeId(sourceDigest, "root", 0, 0),
    schemaVersion: "ast-mcp.syntax-facts.v1",
    sourceArtifactId: sha256(JSON.stringify(["source", sourceDigest])),
    sourceDigest,
    symbols: validSymbols,
    syntaxFactsArtifactId: sha256(
      JSON.stringify([
        sourceDigest,
        extractorFingerprint,
        validSymbols.map((item) => item.id),
        validImports.map((item) => item.id),
        validCalls.map((item) => item.id),
        validInheritance.map((item) => item.id),
        validExports.map((item) => item.id),
      ]),
    ),
  };
}

async function parse(message: DynamicWorkerStart): Promise<SyntaxFacts> {
  const grammar = await language(message.languageId);
  const parser = new Parser();
  try {
    parser.setLanguage(grammar);
    const tree = parser.parse(message.source);
    if (!tree) throw new Error("Tree-sitter returned no syntax tree");
    try {
      return buildFacts(message.languageId, message.source, tree.rootNode);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

const canceled = new Set<number>();
let queued = 0;
parentPort?.on("message", async (value: unknown) => {
  if (!isDynamicWorkerRequest(value)) {
    const id =
      value && typeof value === "object"
        ? (value as Record<string, unknown>).id
        : undefined;
    if (isDynamicWorkerId(id)) {
      send({
        error: "Invalid dynamic parser worker request",
        id,
        ok: false,
        type: "result",
      });
      return;
    }
    throw new TypeError("Invalid dynamic parser worker request id");
  }
  if (value.type === "cancel") {
    canceled.add(value.id);
    return;
  }
  const message = value;
  if (queued >= 64) {
    send({
      error: "Worker queue capacity exceeded",
      id: message.id,
      ok: false,
      type: "result",
    });
    return;
  }
  queued += 1;
  try {
    const facts = await parse(message);
    if (!canceled.delete(message.id)) {
      send({
        facts,
        id: message.id,
        ok: true,
        type: "result",
      });
    }
  } catch (error) {
    send({
      error: error instanceof Error ? error.message : String(error),
      id: message.id,
      ok: false,
      type: "result",
    });
  } finally {
    queued -= 1;
  }
});

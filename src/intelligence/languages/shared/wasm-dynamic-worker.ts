import { parentPort } from "node:worker_threads";

import { getWasmPath } from "tree-sitter-wasm";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";

import {
  type SyntaxCall,
  type SyntaxFacts,
  type SyntaxImport,
  type SyntaxReference,
  type SyntaxRelationship,
  type SyntaxSymbol,
  sha256,
} from "../../parser/index.ts";
import {
  type DynamicWorkerStart,
  dynamicGrammarFingerprint,
  dynamicLanguageExtractorFingerprint,
  isDynamicWorkerId,
  isDynamicWorkerRequest,
} from "../dynamic/protocol.ts";
import type { DynamicLanguageId } from "../dynamic/types.ts";
import {
  appendTreeSitterImport,
  assembleTreeSitterFacts,
  collectTreeSitterExports,
  createTreeSitterCall,
  createTreeSitterSymbol,
  createTreeSitterSymbolLookup,
  treeSitterSymbolKind as symbolKind,
  TREE_SITTER_CALL_NODE_TYPES,
} from "./wasm-fact-assembly.ts";
import {
  createTreeSitterFactContext,
  createTreeSitterTraversal,
  normalizeTreeSitterNodes,
  parseTreeSitter,
  treeSitterDiagnostics,
} from "./wasm-tree-sitter-support.ts";
import { installWasmWorker } from "./wasm-worker-runtime.ts";

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

const { descendants, fieldOrFirst, first } = createTreeSitterTraversal();

function buildFacts(
  languageId: DynamicLanguageId,
  source: string,
  root: SyntaxNode,
): SyntaxFacts {
  const { exactRange, id, sourceDigest } = createTreeSitterFactContext(source);
  const nodes = descendants(root);
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
    const kind =
      languageId === "elixir" &&
      node.childForFieldName("target")?.text === "defmodule"
        ? "namespace"
        : symbolKind(node);
    return [
      createTreeSitterSymbol({
        exactRange,
        exported:
          languageId === "php" ||
          (languageId === "elixir" &&
            !["defp", "defmacrop"].includes(
              node.childForFieldName("target")?.text ?? "",
            )),
        id,
        kind,
        nameNode,
        node,
      }),
    ];
  });
  const symbolAt = createTreeSitterSymbolLookup(symbols);
  const bindingNodeIds = new Set<string>();
  const readNodeIds = new Set<string>();
  for (const node of nodes) {
    if (
      symbols.some(
        (symbol) =>
          symbol.declarationRange.startCoordinate.utf16Offset ===
            node.startIndex &&
          symbol.declarationRange.endCoordinate.utf16Offset === node.endIndex,
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
    appendTreeSitterImport({
      exactRange,
      id,
      importedName,
      imports,
      localNode,
      node,
      sourceName,
      sourceNode,
    });
  }
  const callTypes = new Set<string>(TREE_SITTER_CALL_NODE_TYPES);
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
    return [createTreeSitterCall({ callee, exactRange, id, node, symbolAt })];
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
  const exports = collectTreeSitterExports({
    exactRange,
    first,
    id,
    imports,
    languageId,
    linkImportSources: true,
    nodes: nodes,
    symbols,
  });
  for (const node of nodes) {
    if (
      calls.some(
        (call) =>
          call.range.startCoordinate.utf16Offset <= node.startIndex &&
          call.range.endCoordinate.utf16Offset >= node.endIndex,
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
  const diagnostics = treeSitterDiagnostics(nodes, exactRange);
  const normalized = normalizeTreeSitterNodes(nodes, sourceDigest, exactRange);
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
  const extractorFingerprint = dynamicLanguageExtractorFingerprint(languageId);
  return assembleTreeSitterFacts({
    calls: validCalls,
    diagnostics,
    exports: validExports,
    extractorFingerprint,
    grammarFingerprint: dynamicGrammarFingerprint(languageId),
    implementations: [],
    imports: validImports,
    inheritance: validInheritance,
    languageId,
    nodes: normalized,
    parserFingerprint: sha256("web-tree-sitter@0.27.0"),
    partial: root.hasError,
    references: validReferences,
    sourceDigest,
    symbols: validSymbols,
  });
}

async function parse(message: DynamicWorkerStart): Promise<SyntaxFacts> {
  const grammar = await language(message.languageId);
  return parseTreeSitter(grammar, message.source, (root) =>
    buildFacts(message.languageId, message.source, root),
  );
}

installWasmWorker({
  invalidError: "Invalid dynamic parser worker request",
  invalidId: (value) => {
    const id =
      value && typeof value === "object"
        ? (value as Record<string, unknown>).id
        : undefined;
    return isDynamicWorkerId(id) ? id : null;
  },
  parse,
  port: parentPort,
  throwOnMissingInvalidId: true,
  validate: (value) => {
    if (!isDynamicWorkerRequest(value)) {
      throw new TypeError("Invalid dynamic parser worker request id");
    }
    return value;
  },
});

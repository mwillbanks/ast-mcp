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
import type { SystemsLanguageId } from "./types.ts";

type WorkerLanguageId =
  | SystemsLanguageId
  | "apex"
  | "csharp"
  | "kotlin"
  | "scala"
  | "elixir"
  | "julia"
  | "lua"
  | "luau"
  | "php"
  | "r"
  | "ruby";

interface StartMessage {
  id: number;
  languageId: SystemsLanguageId;
  source: string;
  type: "start";
}
interface CancelMessage {
  id: number;
  type: "cancel";
}
type WorkerMessage = StartMessage | CancelMessage;
type WorkerResult =
  | { facts: SyntaxFacts; id: number; ok: true; type: "result" }
  | { error: string; id: number; ok: false; type: "result" };

const systemsLanguages = new Set<SystemsLanguageId>([
  "c",
  "cpp",
  "objc",
  "swift",
  "rust",
  "go",
  "zig",
  "dart",
]);

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function requestId(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

export function validateSystemsWorkerRequest(value: unknown): WorkerMessage {
  if (!value || typeof value !== "object") {
    throw new TypeError("SYSTEMS worker request must be an object");
  }
  const request = value as Record<string, unknown>;
  const id = requestId(request);
  if (id === null)
    throw new TypeError("SYSTEMS worker request id must be positive");
  if (request.type === "cancel") {
    if (!exactKeys(request, ["id", "type"])) {
      throw new TypeError("SYSTEMS cancel request contains invalid fields");
    }
    return { id, type: "cancel" };
  }
  if (request.type !== "start") {
    throw new TypeError("SYSTEMS worker request type is invalid");
  }
  if (!exactKeys(request, ["id", "languageId", "source", "type"])) {
    throw new TypeError("SYSTEMS start request contains invalid fields");
  }
  if (
    typeof request.languageId !== "string" ||
    !systemsLanguages.has(request.languageId as SystemsLanguageId)
  ) {
    throw new TypeError("SYSTEMS start request language is invalid");
  }
  if (typeof request.source !== "string") {
    throw new TypeError("SYSTEMS start request source must be a string");
  }
  return {
    id,
    languageId: request.languageId as SystemsLanguageId,
    source: request.source,
    type: "start",
  };
}

function send(result: WorkerResult): void {
  parentPort?.postMessage(result);
}

const languages = new Map<string, Language>();
let initialized: Promise<void> | undefined;

async function language(languageId: WorkerLanguageId) {
  initialized ??= Parser.init();
  await initialized;
  let loaded = languages.get(languageId);
  if (!loaded) {
    loaded = await Language.load(
      getWasmPath(
        (languageId === "csharp"
          ? "c_sharp"
          : languageId === "apex"
            ? "java"
            : languageId) as Parameters<typeof getWasmPath>[0],
      ),
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
  languageId: WorkerLanguageId,
  source: string,
  root: SyntaxNode,
): SyntaxFacts {
  const sourceDigest = sha256(source);
  const coordinates = new SourceCoordinateIndex(source);
  const nodes = descendants(root);
  const errorNodes = nodes.filter(
    (node) => node.type === "ERROR" || node.isMissing,
  );
  const invalidContainers = errorNodes
    .map((error) => {
      let container = error.parent;
      while (container?.parent && container.parent.id !== root.id)
        container = container.parent;
      return container;
    })
    .filter((node): node is SyntaxNode => Boolean(node));
  const isInsideError = (node: SyntaxNode) =>
    errorNodes.some(
      (error) =>
        error.startIndex <= node.startIndex && error.endIndex >= node.endIndex,
    ) ||
    invalidContainers.some(
      (container) =>
        container.id !== root.id &&
        container.startIndex <= node.startIndex &&
        container.endIndex >= node.endIndex,
    );
  const semanticNodes = nodes.filter((node) => !isInsideError(node));
  const exactRange = (node: SyntaxNode) =>
    coordinates.range(
      byteToUtf16(source, node.startIndex),
      byteToUtf16(source, node.endIndex),
    );
  const id = (kind: string, node: SyntaxNode, name: string) =>
    sha256(JSON.stringify([sourceDigest, kind, name, node.startIndex]));
  const symbolNodes = semanticNodes.filter((node) => {
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
        "function_item",
        "struct_item",
        "trait_item",
        "impl_item",
        "type_declaration",
        "protocol_declaration",
        "class_specifier",
        "class_interface",
        "class_implementation",
        "method_definition",
        "function_signature_item",
        "method_signature",
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
      "type_identifier",
      "simple_identifier",
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
    const modifierText = node.namedChildren
      .filter((child) => child.type.includes("modifier"))
      .map((child) => child.text)
      .join(" ");
    const hidden =
      modifierText.includes("private") ||
      modifierText.includes("protected") ||
      modifierText.includes("internal");
    const requiresExplicitPublic = ["rust", "swift", "zig"].includes(
      languageId,
    );
    const languageVisible =
      (languageId !== "go" || name[0] === name[0]?.toUpperCase()) &&
      (languageId !== "dart" || !name.startsWith("_")) &&
      (!["c", "cpp"].includes(languageId) ||
        !descendants(node).some(
          (child) =>
            child.type === "storage_class_specifier" && child.text === "static",
        ));
    const visible =
      !hidden &&
      languageVisible &&
      (!requiresExplicitPublic ||
        modifierText.includes("public") ||
        modifierText.includes("global"));
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
          (["c", "cpp", "objc", "swift", "rust", "go", "zig", "dart"].includes(
            languageId,
          ) &&
            visible) ||
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
  const bindingNodeIds = new Set<number>();
  for (const node of semanticNodes) {
    if (
      symbols.some(
        (symbol) =>
          symbol.declarationRange.startByte === node.startIndex &&
          symbol.declarationRange.endByte === node.endIndex,
      )
    ) {
      bindingNodeIds.add(node.id);
    }
  }
  const declarationContainers = new Set([
    "parameter",
    "parameter_declaration",
    "optional_parameter_declaration",
    "variadic_parameter",
    "simple_parameter",
    "formal_parameter",
    "init_declarator",
    "short_var_declaration",
    "var_declaration",
    "variable_declaration",
    "const_declaration",
    "let_declaration",
    "pattern_binding",
    "identifier_pattern",
    "initialized_variable_definition",
    "local_variable_declaration",
    "property_declaration",
  ]);
  for (const node of semanticNodes) {
    if (
      ![
        "identifier",
        "field_identifier",
        "type_identifier",
        "simple_identifier",
      ].includes(node.type)
    )
      continue;
    let parent = node.parent;
    for (
      let depth = 0;
      parent && depth < 3 && !declarationContainers.has(parent.type);
      depth += 1
    )
      parent = parent.parent;
    if (!parent || !declarationContainers.has(parent.type)) continue;
    if (parent.type === "property_declaration" && symbolAt(node) === null)
      continue;
    const declared =
      parent.childForFieldName("name") ??
      parent.childForFieldName("declarator") ??
      parent.childForFieldName("pattern") ??
      first(parent, ["identifier", "field_identifier", "simple_identifier"]);
    if (declared?.id === node.id || declared?.startIndex === node.startIndex)
      bindingNodeIds.add(node.id);
  }
  const imports: SyntaxImport[] = [];
  for (const node of semanticNodes) {
    let sourceNode: SyntaxNode | undefined;
    let localNode: SyntaxNode | undefined;
    let importedName = "*";
    if (
      ["preproc_include", "use_declaration", "library_import"].includes(
        node.type,
      )
    ) {
      sourceNode =
        node.childForFieldName("path") ??
        node.childForFieldName("argument") ??
        first(node, [
          "system_lib_string",
          "string_literal",
          "scoped_identifier",
          "uri",
        ]);
      localNode = first(node, ["identifier", "type_identifier"]);
      importedName = sourceNode?.text ?? "*";
    } else if (languageId === "go" && node.type === "import_declaration") {
      sourceNode = first(node, ["interpreted_string_literal_content"]);
      localNode = first(node, ["package_identifier", "identifier"]);
      importedName = sourceNode?.text ?? "*";
    } else if (
      [
        "import_declaration",
        "import_header",
        "groovy_import",
        "using_directive",
      ].includes(node.type)
    ) {
      sourceNode =
        node.childForFieldName("import") ??
        (node.type === "using_directive"
          ? first(node, ["qualified_name"])
          : undefined) ??
        node.childForFieldName("name") ??
        first(node, ["scoped_identifier", "identifier", "qualified_name"]);
      const aliasNode = first(node, ["import_alias"]);
      localNode =
        (node.type === "using_directive"
          ? node.childForFieldName("name")
          : undefined) ??
        (aliasNode
          ? first(aliasNode, [
              "simple_identifier",
              "type_identifier",
              "identifier",
            ])
          : undefined) ??
        node.childForFieldName("import_alias") ??
        sourceNode;
      importedName = sourceNode?.text.split(".").at(-1) ?? "*";
    } else if (languageId === "scala" && node.type === "import_declaration") {
      sourceNode = node;
      localNode = first(node, ["arrow_renamed_identifier", "identifier"]);
      importedName = localNode?.text ?? "*";
    } else if (
      ["import_statement", "import_from_statement"].includes(node.type)
    ) {
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
      sourceNode = first(node, ["identifier"]);
    } else if (languageId === "elixir" && node.type === "call") {
      const target = node.childForFieldName("target")?.text;
      if (["alias", "import", "require", "use"].includes(target ?? "")) {
        sourceNode = first(node.childForFieldName("arguments") ?? node, [
          "alias",
        ]);
      }
    }
    if (!sourceNode) continue;
    const sourceName = sourceNode.text.replace(/^["']|["']$/g, "");
    if (localNode) bindingNodeIds.add(localNode.id);
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
    "method_invocation",
    "invocation_expression",
    "macro_invocation",
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
        "member_access_expression",
        "dotted_identifier",
        "field_expression",
        "dot_index_expression",
        "dot",
        "identifier",
        "simple_identifier",
        "field_identifier",
        "builtin_identifier",
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
  const implementations: SyntaxRelationship[] = [];
  for (const symbolNode of symbolNodes) {
    const containers = [
      symbolNode.childForFieldName("superclasses"),
      symbolNode.childForFieldName("superclass"),
      ...symbolNode.namedChildren.filter((child) =>
        [
          "base_clause",
          "class_interface_clause",
          "super_interfaces",
          "delegation_specifier",
          "extends_clause",
          "base_list",
        ].includes(child.type),
      ),
    ].filter((candidate): candidate is SyntaxNode => Boolean(candidate));
    if (languageId === "julia" && symbolNode.type === "struct_definition") {
      const identifiers = descendants(symbolNode).filter(
        (candidate) => candidate.type === "identifier",
      );
      const target = identifiers.at(-1);
      if (target && identifiers.length > 1) containers.push(target);
    }
    for (const container of containers) {
      const targets = [
        "identifier",
        "constant",
        "name",
        "alias",
        "type_identifier",
      ].includes(container.type)
        ? [container]
        : descendants(container).filter((candidate) =>
            [
              "identifier",
              "constant",
              "name",
              "alias",
              "type_identifier",
            ].includes(candidate.type),
          );
      for (const [index, target] of targets.entries()) {
        const isImplementation =
          container.type === "super_interfaces" ||
          (languageId === "kotlin" &&
            container.type === "delegation_specifier" &&
            !descendants(container).some(
              (candidate) => candidate.type === "constructor_invocation",
            )) ||
          (languageId === "scala" &&
            container.type === "extends_clause" &&
            index > 0);
        const collection = isImplementation ? implementations : inheritance;
        const relationshipKind = isImplementation
          ? "implementation"
          : "inheritance";
        collection.push({
          id: id(relationshipKind, target, target.text),
          range: exactRange(target),
          sourceSymbolId: symbolAt(symbolNode),
          targetName: target.text,
        });
      }
    }
  }
  if (languageId === "r") {
    for (const node of semanticNodes.filter(
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
    for (const node of semanticNodes.filter(
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
  for (const node of semanticNodes) {
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
  const references: SyntaxReference[] = semanticNodes
    .filter((node) =>
      [
        "identifier",
        "constant",
        "name",
        "alias",
        "type_identifier",
        "simple_identifier",
      ].includes(node.type),
    )
    .map((node) => ({
      enclosingSymbolId: symbolAt(node),
      id: id("reference", node, node.text),
      name: node.text,
      range: exactRange(node),
      role:
        bindingNodeIds.has(node.id) ||
        ["parameters", "parameter_list", "formal_parameters"].includes(
          node.parent?.type ?? "",
        ) ||
        ["left", "lhs"].some(
          (field) => node.parent?.childForFieldName(field)?.id === node.id,
        )
          ? ("write" as const)
          : ("read" as const),
    }))
    .filter(
      (item, index, items) =>
        items.findIndex((candidate) => candidate.id === item.id) === index,
    );
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
  const semanticNodeKeys = new Set(semanticNodes.map((node) => node.id));
  const normalized = semanticNodes.map((node) => ({
    childIds: node.namedChildren
      .filter((child) => semanticNodeKeys.has(child.id))
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
      node.parent && semanticNodeKeys.has(node.parent.id)
        ? stableNodeId(
            sourceDigest,
            node.parent.type,
            node.parent.startIndex,
            node.parent.endIndex,
          )
        : null,
    range: exactRange(node),
  }));
  const grammarIdentity =
    languageId === "apex" ? "java:apex-compatible-subset-v1" : languageId;
  const extractorFingerprint = sha256(
    JSON.stringify(["tree-sitter-wasm", "1.1.8", grammarIdentity]),
  );
  return {
    calls,
    diagnostics,
    exports,
    extractorFingerprint,
    grammarFingerprint: sha256(
      JSON.stringify(["tree-sitter-wasm", "1.1.8", grammarIdentity]),
    ),
    implementations,
    imports,
    inheritance,
    languageId,
    nodes: normalized,
    parserFingerprint: sha256("web-tree-sitter@0.27.0"),
    partial: root.hasError,
    references,
    rootNodeId: normalized[0]?.id ?? stableNodeId(sourceDigest, "root", 0, 0),
    schemaVersion: "ast-mcp.syntax-facts.v1",
    sourceArtifactId: sha256(JSON.stringify(["source", sourceDigest])),
    sourceDigest,
    symbols,
    syntaxFactsArtifactId: sha256(
      JSON.stringify([
        sourceDigest,
        extractorFingerprint,
        symbols.map((item) => item.id),
        imports.map((item) => item.id),
        calls.map((item) => item.id),
        inheritance.map((item) => item.id),
        implementations.map((item) => item.id),
        exports.map((item) => item.id),
      ]),
    ),
  };
}

async function parse(message: StartMessage): Promise<SyntaxFacts> {
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
  let message: WorkerMessage;
  try {
    message = validateSystemsWorkerRequest(value);
  } catch (error) {
    const id = requestId(value);
    if (id !== null) {
      send({
        error: error instanceof Error ? error.message : String(error),
        id,
        ok: false,
        type: "result",
      });
    }
    return;
  }
  if (message.type === "cancel") {
    canceled.add(message.id);
    return;
  }
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
    if (!canceled.delete(message.id)) {
      send({
        error: error instanceof Error ? error.message : String(error),
        id: message.id,
        ok: false,
        type: "result",
      });
    }
  } finally {
    queued -= 1;
  }
});

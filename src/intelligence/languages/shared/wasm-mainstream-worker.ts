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
import {
  type MainstreamLanguageId,
  type MainstreamWorkerMessage,
  type MainstreamWorkerStartMessage,
  positiveRequestId,
} from "./wasm-worker-validation.ts";

const languages = new Map<string, Language>();
let initialized: Promise<void> | undefined;

async function language(languageId: MainstreamLanguageId) {
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

const traversals = {
  jvm: createTreeSitterTraversal(true),
  systems: createTreeSitterTraversal(),
};

type WorkerProfile = keyof typeof traversals;

function buildFacts(
  profile: WorkerProfile,
  languageId: MainstreamLanguageId,
  source: string,
  root: SyntaxNode,
): SyntaxFacts {
  const { descendants, first } = traversals[profile];
  const { exactRange, id, sourceDigest } = createTreeSitterFactContext(source);
  const nodes = descendants(root);
  const errorNodes = nodes.filter(
    (node) => node.type === "ERROR" || node.isMissing,
  );
  const invalidContainers = errorNodes
    .map((error) => {
      if (profile === "jvm") return error.parent;
      let container = error.parent;
      while (container?.parent && container.parent.id !== root.id) {
        container = container.parent;
      }
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
        (profile === "jvm" || container.id !== root.id) &&
        container.startIndex <= node.startIndex &&
        container.endIndex >= node.endIndex,
    );
  const semanticNodes =
    profile === "jvm" && languageId !== "apex"
      ? nodes
      : nodes.filter((node) => !isInsideError(node));
  const systemsSymbolTypes = new Set([
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
  ]);
  const symbolNodes = semanticNodes.filter(
    (node) =>
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
      ].includes(node.type) ||
      (profile === "systems" && systemsSymbolTypes.has(node.type)),
  );
  const symbols: SyntaxSymbol[] = symbolNodes.flatMap((node) => {
    const nameNode =
      node.childForFieldName("name") ??
      first(node, [
        "identifier",
        "constant",
        "name",
        "alias",
        "type_identifier",
        "simple_identifier",
      ]);
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
    const systemsLanguageVisible =
      (languageId !== "go" || name[0] === name[0]?.toUpperCase()) &&
      (languageId !== "dart" || !name.startsWith("_")) &&
      (!["c", "cpp"].includes(languageId) ||
        !descendants(node).some(
          (child) =>
            child.type === "storage_class_specifier" && child.text === "static",
        ));
    const requiresExplicitPublic =
      profile === "systems"
        ? ["rust", "swift", "zig"].includes(languageId)
        : ["java", "csharp", "apex"].includes(languageId);
    const visible =
      !hidden &&
      (profile === "jvm" || systemsLanguageVisible) &&
      (!requiresExplicitPublic ||
        modifierText.includes("public") ||
        modifierText.includes("global"));
    const kind = symbolKind(node);
    return [
      createTreeSitterSymbol({
        exactRange,
        exported:
          (profile === "systems"
            ? ["c", "cpp", "objc", "swift", "rust", "go", "zig", "dart"]
            : ["java", "kotlin", "scala", "groovy", "csharp", "apex"]
          ).includes(languageId) && visible,
        id,
        kind,
        nameNode,
        node,
      }),
    ];
  });
  const symbolAt = createTreeSitterSymbolLookup(symbols);
  const bindingNodeIds = new Set<number | string>();
  const bindingKey = (node: SyntaxNode) =>
    profile === "systems" ? node.id : `${node.startIndex}:${node.endIndex}`;
  for (const node of semanticNodes) {
    if (
      symbols.some(
        (symbol) =>
          symbol.declarationRange.startCoordinate.utf16Offset ===
            node.startIndex &&
          symbol.declarationRange.endCoordinate.utf16Offset === node.endIndex,
      )
    ) {
      bindingNodeIds.add(bindingKey(node));
    }
  }
  if (profile === "systems") {
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
      ) {
        continue;
      }
      let parent = node.parent;
      for (
        let depth = 0;
        parent && depth < 3 && !declarationContainers.has(parent.type);
        depth += 1
      ) {
        parent = parent.parent;
      }
      if (!parent || !declarationContainers.has(parent.type)) continue;
      if (parent.type === "property_declaration" && symbolAt(node) === null) {
        continue;
      }
      const declared =
        parent.childForFieldName("name") ??
        parent.childForFieldName("declarator") ??
        parent.childForFieldName("pattern") ??
        first(parent, ["identifier", "field_identifier", "simple_identifier"]);
      if (
        declared?.id === node.id ||
        declared?.startIndex === node.startIndex
      ) {
        bindingNodeIds.add(bindingKey(node));
      }
    }
  }
  const imports: SyntaxImport[] = [];
  for (const node of semanticNodes) {
    let sourceNode: SyntaxNode | undefined;
    let localNode: SyntaxNode | undefined;
    let sourceOverride: string | undefined;
    let importedName = "*";
    if (
      profile === "jvm" &&
      languageId === "scala" &&
      node.type === "import_declaration"
    ) {
      const paths = node
        .childrenForFieldName("path")
        .filter((path) => path.type === "identifier");
      const renamed = first(node, ["arrow_renamed_identifier"]);
      const importedNode = renamed?.childForFieldName("name");
      const aliasNode = renamed?.childForFieldName("alias");
      sourceNode = paths[0];
      sourceOverride = paths.map((path) => path.text).join(".");
      localNode = aliasNode ?? importedNode ?? paths.at(-1);
      importedName = importedNode?.text ?? paths.at(-1)?.text ?? "*";
    } else if (
      profile === "systems" &&
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
    } else if (
      profile === "systems" &&
      languageId === "go" &&
      node.type === "import_declaration"
    ) {
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
    }
    if (!sourceNode) continue;
    const sourceName = (sourceOverride ?? sourceNode.text).replace(
      /^["']|["']$/g,
      "",
    );
    if (localNode) bindingNodeIds.add(bindingKey(localNode));
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
  const callTypes = new Set([
    ...TREE_SITTER_CALL_NODE_TYPES,
    "method_invocation",
    "invocation_expression",
    ...(profile === "systems" ? ["macro_invocation"] : []),
  ]);
  const callNodes = profile === "systems" ? nodes : semanticNodes;
  const calls: SyntaxCall[] = callNodes.flatMap((node) => {
    if (!callTypes.has(node.type)) return [];
    if (node.parent?.type === "signature") return [];
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
        ...(profile === "systems"
          ? ["field_identifier", "builtin_identifier"]
          : []),
      ]);
    if (!callee) return [];
    const name = callee.text;
    if (["require", "load", "using", "import"].includes(name)) {
      return [];
    }
    return [createTreeSitterCall({ callee, exactRange, id, node, symbolAt })];
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
  const exports = collectTreeSitterExports({
    exactRange,
    first,
    id,
    imports,
    languageId,
    nodes: semanticNodes,
    symbols,
  });
  const contains = (container: SyntaxNode, node: SyntaxNode) =>
    container.startIndex <= node.startIndex &&
    container.endIndex >= node.endIndex;
  const parameterContainers = new Set([
    "formal_parameter",
    "parameter",
    "parameter_declaration",
    "function_value_parameter",
    "class_parameter",
    "simple_parameter",
    "variable_parameter",
  ]);
  const jvmDeclarationContainers = new Set([
    "local_variable_declaration",
    "variable_declaration",
    "variable_declarator",
    "property_declaration",
    "binding",
    "pattern_definition",
    "val_definition",
    "var_definition",
    "declaration",
  ]);
  const isJvmDeclaration = (node: SyntaxNode) => {
    if (bindingNodeIds.has(bindingKey(node))) return true;
    let current = node.parent;
    while (current) {
      if (parameterContainers.has(current.type)) {
        const target =
          current.childForFieldName("name") ??
          first(current, ["simple_identifier", "identifier", "variable_name"]);
        if (target && contains(target, node)) return true;
      }
      if (jvmDeclarationContainers.has(current.type)) {
        const declarator = current.childForFieldName("declarator");
        const target =
          current.childForFieldName("name") ??
          declarator?.childForFieldName("name") ??
          current.childForFieldName("pattern") ??
          first(current, ["simple_identifier", "identifier", "variable_name"]);
        if (target && contains(target, node)) return true;
      }
      for (const field of ["left", "lhs"]) {
        const target = current.childForFieldName(field);
        if (target && contains(target, node)) return true;
      }
      if (symbolNodes.includes(current)) break;
      current = current.parent;
    }
    return false;
  };
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
        profile === "jvm"
          ? isJvmDeclaration(node)
            ? ("write" as const)
            : ("read" as const)
          : bindingNodeIds.has(bindingKey(node)) ||
              ["parameters", "parameter_list", "formal_parameters"].includes(
                node.parent?.type ?? "",
              ) ||
              ["left", "lhs"].some(
                (field) =>
                  node.parent?.childForFieldName(field)?.id === node.id,
              )
            ? ("write" as const)
            : ("read" as const),
    }))
    .filter(
      (item, index, items) =>
        items.findIndex((candidate) => candidate.id === item.id) === index,
    );
  const diagnostics = treeSitterDiagnostics(nodes, exactRange);
  const normalized = normalizeTreeSitterNodes(
    semanticNodes,
    sourceDigest,
    exactRange,
    true,
  );
  const grammarIdentity =
    languageId === "apex" ? "java:apex-compatible-subset-v1" : languageId;
  const extractorFingerprint = sha256(
    JSON.stringify([
      "tree-sitter-wasm",
      "1.1.8",
      grammarIdentity,
      "coordinates-v2",
    ]),
  );
  return assembleTreeSitterFacts({
    calls,
    diagnostics,
    exports,
    extractorFingerprint,
    grammarFingerprint: sha256(
      JSON.stringify(["tree-sitter-wasm", "1.1.8", grammarIdentity]),
    ),
    implementations,
    imports,
    includeImplementationsInArtifact: true,
    inheritance,
    languageId,
    nodes: normalized,
    parserFingerprint: sha256("web-tree-sitter@0.27.0"),
    partial: root.hasError,
    references,
    sourceDigest,
    symbols,
  });
}

export function installMainstreamWasmWorker<
  LanguageId extends MainstreamLanguageId,
>(options: {
  profile: WorkerProfile;
  validate: (value: unknown) => MainstreamWorkerMessage<LanguageId>;
}): void {
  const parse = async (
    message: MainstreamWorkerStartMessage<LanguageId>,
  ): Promise<SyntaxFacts> => {
    const grammar = await language(message.languageId);
    return parseTreeSitter(grammar, message.source, (root) =>
      buildFacts(options.profile, message.languageId, message.source, root),
    );
  };

  installWasmWorker({
    invalidId: positiveRequestId,
    parse,
    port: parentPort,
    suppressCanceledErrors: true,
    validate: options.validate,
  });
}

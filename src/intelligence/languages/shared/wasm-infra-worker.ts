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
import type { InfraLanguageId } from "../infra/types.ts";
import { installWasmWorker } from "./wasm-worker-runtime.ts";
import {
  positiveRequestId,
  type InfraWorkerStartMessage as StartMessage,
  validateInfraWorkerRequest,
} from "./wasm-worker-validation.ts";

const languages = new Map<string, Language>();
let initialized: Promise<void> | undefined;
async function grammar(languageId: InfraLanguageId): Promise<Language | null> {
  const grammarId = languageId === "verilog" ? "systemverilog" : languageId;
  if (!["bash", "powershell", "systemverilog"].includes(grammarId)) return null;
  initialized ??= Parser.init();
  await initialized;
  let loaded = languages.get(grammarId);
  if (!loaded) {
    loaded = await Language.load(
      getWasmPath(grammarId as Parameters<typeof getWasmPath>[0]),
    );
    languages.set(grammarId, loaded);
  }
  return loaded;
}
interface FlatNode {
  children: FlatNode[];
  end: number;
  missing: boolean;
  parent?: FlatNode;
  start: number;
  text: string;
  type: string;
}
function flattenTree(root: SyntaxNode): FlatNode {
  const convert = (node: SyntaxNode, parent?: FlatNode): FlatNode => {
    const value: FlatNode = {
      children: [],
      end: node.endIndex,
      missing: node.isMissing,
      parent,
      start: node.startIndex,
      text: node.text,
      type: node.type,
    };
    value.children = node.children.map((child) => convert(child, value));
    return value;
  };
  return convert(root);
}
interface Token {
  end: number;
  start: number;
  text: string;
  type: "identifier" | "string" | "symbol" | "newline";
}
function structuredTokens(
  languageId: InfraLanguageId,
  source: string,
): { errors: Array<{ end: number; start: number }>; tokens: Token[] } {
  const tokens: Token[] = [];
  const errors: Array<{ end: number; start: number }> = [];
  const brackets: Array<{ close: string; start: number }> = [];
  let i = 0;
  while (i < source.length) {
    const start = i;
    const ch = source[i] ?? "";
    if (ch === "\n") {
      i++;
      tokens.push({ end: i, start, text: ch, type: "newline" });
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const lineComment =
      (languageId === "fortran" && ch === "!") ||
      (languageId === "sql" && ch === "-" && source[i + 1] === "-") ||
      (languageId === "hcl" &&
        (ch === "#" || (ch === "/" && source[i + 1] === "/")));
    if (lineComment) {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (
      (languageId === "sql" || languageId === "hcl") &&
      ch === "/" &&
      source[i + 1] === "*"
    ) {
      i += 2;
      let closed = false;
      while (i < source.length) {
        const c = source[i] ?? "";
        if (c === "*" && source[i + 1] === "/") {
          i += 2;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) errors.push({ end: i, start });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let closed = false;
      while (i < source.length) {
        const c = source[i] ?? "";
        i++;
        if (c === quote) {
          closed = true;
          break;
        }
      }
      tokens.push({
        end: i,
        start,
        text: source.slice(start, i),
        type: "string",
      });
      if (!closed) errors.push({ end: i, start });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      i++;
      while (i < source.length && /[A-Za-z0-9_$.-]/.test(source[i] ?? "")) i++;
      tokens.push({
        end: i,
        start,
        text: source.slice(start, i),
        type: "identifier",
      });
      continue;
    }
    i++;
    if ("([{".includes(ch))
      brackets.push({
        close: { "(": ")", "[": "]", "{": "}" }[ch] ?? "",
        start,
      });
    if (")]}".includes(ch)) {
      const open = brackets.pop();
      if (!open || open.close !== ch) errors.push({ end: i, start });
    }
    tokens.push({ end: i, start, text: ch, type: "symbol" });
  }
  for (const open of brackets)
    errors.push({ end: source.length, start: open.start });
  return { errors, tokens };
}
function structuredTree(languageId: InfraLanguageId, source: string): FlatNode {
  const root: FlatNode = {
    children: [],
    end: source.length,
    missing: false,
    start: 0,
    text: source,
    type: `${languageId}_document`,
  };
  let current: Token[] = [];
  const finish = () => {
    if (!current.length) return;
    const node: FlatNode = {
      children: [],
      end: current.at(-1)?.end ?? 0,
      missing: false,
      parent: root,
      start: current[0]?.start ?? 0,
      text: "",
      type: "statement",
    };
    node.text = source.slice(node.start, node.end);
    node.children = current.map((token) => ({
      children: [],
      end: token.end,
      missing: false,
      parent: node,
      start: token.start,
      text: token.text,
      type: token.type,
    }));
    root.children.push(node);
    current = [];
  };
  const structured = structuredTokens(languageId, source);
  for (const token of structured.tokens) {
    if (token.type === "newline" || token.text === ";") finish();
    else current.push(token);
  }
  finish();
  for (const error of structured.errors)
    root.children.push({
      children: [],
      end: error.end,
      missing: false,
      parent: root,
      start: error.start,
      text: source.slice(error.start, error.end),
      type: "ERROR",
    });
  root.children.sort((a, b) => a.start - b.start || a.end - b.end);
  return root;
}
function descendants(root: FlatNode): FlatNode[] {
  const result: FlatNode[] = [];
  const visit = (n: FlatNode) => {
    result.push(n);
    for (const c of n.children) visit(c);
  };
  visit(root);
  return result;
}
function buildFacts(
  languageId: InfraLanguageId,
  source: string,
  root: FlatNode,
): SyntaxFacts {
  const sourceDigest = sha256(source);
  const coordinates = new SourceCoordinateIndex(source);
  const all = descendants(root);
  const errors = all.filter((node) => node.type === "ERROR" || node.missing);
  const invalid = (node: FlatNode) =>
    node.type === "ERROR" ||
    node.missing ||
    (node !== root &&
      errors.some((error) => error.start < node.end && error.end > node.start));
  const semanticNodes = all.filter((node) => !invalid(node));
  const range = (node: FlatNode) => coordinates.range(node.start, node.end);
  const id = (kind: string, node: FlatNode, name: string) =>
    sha256(JSON.stringify([sourceDigest, kind, name, node.start]));
  const symbols: SyntaxSymbol[] = [];
  const imports: SyntaxImport[] = [];
  const calls: SyntaxCall[] = [];
  const inheritance: SyntaxRelationship[] = [];
  const implementations: SyntaxRelationship[] = [];
  const exports: SyntaxExport[] = [];
  const references: SyntaxReference[] = [];
  const addSymbol = (
    node: FlatNode,
    nameNode: FlatNode,
    kind: SyntaxSymbolKind,
    exported = true,
  ) => {
    const symbolName = nameNode.text.replace(/^["\x27]|["\x27]$/g, "");
    const symbol = {
      declarationRange: range(nameNode),
      exported,
      id: id("symbol", nameNode, symbolName),
      kind,
      name: symbolName,
      qualifiedName: symbolName,
      range: range(node),
    };
    symbols.push(symbol);
    if (exported)
      exports.push({
        exportedName: symbol.name,
        id: sha256(JSON.stringify([symbol.id, "export"])),
        localName: symbol.name,
        range: symbol.declarationRange,
        source: null,
        typeOnly: kind === "type",
      });
    return symbol.id;
  };
  const addImport = (node: FlatNode, target: FlatNode) =>
    imports.push({
      id: id("import", target, target.text),
      importedName: "*",
      localName: target.text.replace(/^["']|["']$/g, ""),
      range: range(node),
      source: target.text.replace(/^["']|["']$/g, ""),
      typeOnly: false,
    });
  const addCall = (node: FlatNode, target: FlatNode) =>
    calls.push({
      callee: target.text,
      enclosingSymbolId: null,
      id: id("call", target, target.text),
      range: range(node),
    });
  if (["sql", "hcl", "fortran"].includes(languageId)) {
    for (const statement of root.children) {
      if (!semanticNodes.includes(statement)) continue;
      const t = statement.children;
      const words = t.filter((n) => n.type === "identifier");
      const upper = words.map((n) => n.text.toUpperCase());
      if (languageId === "sql") {
        if (upper[0] === "CREATE") {
          const k = upper.findIndex((v) =>
            ["TABLE", "VIEW", "FUNCTION", "PROCEDURE"].includes(v),
          );
          const nameOffset =
            upper[k + 1] === "IF" &&
            upper[k + 2] === "NOT" &&
            upper[k + 3] === "EXISTS"
              ? 4
              : 1;
          const name = words[k + nameOffset];
          if (name)
            addSymbol(
              statement,
              name,
              upper[k] === "TABLE" || upper[k] === "VIEW" ? "type" : "function",
            );
        }
        for (let i = 0; i < upper.length; i++) {
          const target = words[i + 1];
          if (["FROM", "JOIN", "REFERENCES"].includes(upper[i] ?? "") && target)
            addImport(statement, target);
          if (["CALL", "EXEC", "EXECUTE"].includes(upper[i] ?? "") && target)
            addCall(statement, target);
        }
      }
      if (languageId === "hcl") {
        const first = words[0];
        const label = t.filter((n) => n.type === "string").at(-1);
        if (
          first &&
          t.some((node) => node.text === "{") &&
          [
            "RESOURCE",
            "DATA",
            "MODULE",
            "VARIABLE",
            "OUTPUT",
            "LOCALS",
          ].includes(first.text.toUpperCase())
        )
          addSymbol(statement, label ?? words[1] ?? first, "type");
        if (
          first?.text.toUpperCase() === "SOURCE" &&
          t.find((n) => n.text === "=")
        ) {
          const target = t.find((n) => n.type === "string");
          if (target) addImport(statement, target);
        }
        for (let i = 0; i < t.length - 1; i++) {
          const target = t[i];
          if (target?.type === "identifier" && t[i + 1]?.text === "(")
            addCall(statement, target);
        }
      }
      if (languageId === "fortran") {
        const k =
          upper[0] === "END"
            ? -1
            : upper.findIndex((v) =>
                [
                  "PROGRAM",
                  "MODULE",
                  "SUBROUTINE",
                  "FUNCTION",
                  "TYPE",
                ].includes(v),
              );
        const declaration = k >= 0 ? words[k + 1] : undefined;
        if (declaration)
          addSymbol(
            statement,
            declaration,
            upper[k] === "TYPE"
              ? "type"
              : upper[k] === "MODULE"
                ? "namespace"
                : "function",
          );
        const dependency = words[1];
        if (upper[0] === "USE" && dependency) addImport(statement, dependency);
        if (upper[0] === "CALL" && dependency) addCall(statement, dependency);
        const ex = upper.indexOf("EXTENDS");
        const base = ex >= 0 ? words[ex + 1] : undefined;
        if (base)
          inheritance.push({
            id: id("inheritance", base, base.text),
            range: range(base),
            sourceSymbolId: null,
            targetName: base.text,
          });
      }
    }
  } else {
    const symbolKinds = new Set([
      "function_definition",
      "function_statement",
      "function_declaration",
      "task_declaration",
      "module_declaration",
      "interface_declaration",
      "class_declaration",
      "program_declaration",
    ]);
    const callKinds = new Set([
      "command",
      "command_name",
      "command_invocation",
      "invocation_expression",
      "module_instantiation",
    ]);
    const importKinds = new Set([
      "using_statement",
      "package_import_declaration",
      "source_command",
    ]);
    for (const node of semanticNodes) {
      if (symbolKinds.has(node.type)) {
        const name =
          node.children.find((c) =>
            [
              "word",
              "identifier",
              "simple_identifier",
              "simple_name",
              "function_name",
              "module_identifier",
            ].includes(c.type),
          ) ??
          descendants(node).find((c) =>
            [
              "word",
              "identifier",
              "simple_identifier",
              "simple_name",
              "function_name",
              "module_identifier",
            ].includes(c.type),
          );
        if (name)
          addSymbol(
            node,
            name,
            node.type.includes("class")
              ? "class"
              : node.type.includes("module")
                ? "namespace"
                : "function",
          );
      }
      if (importKinds.has(node.type)) {
        const target = descendants(node).find((c) =>
          [
            "string_literal",
            "string_content",
            "identifier",
            "scoped_identifier",
          ].includes(c.type),
        );
        if (target) addImport(node, target);
      }
      if (
        callKinds.has(node.type) &&
        (!symbolKinds.has(node.parent?.type ?? "") ||
          node.type === "module_instantiation") &&
        !callKinds.has(node.parent?.type ?? "")
      ) {
        const target = descendants(node).find((c) =>
          [
            "command_name",
            "word",
            "identifier",
            "simple_identifier",
            "generic_command_name",
          ].includes(c.type),
        );
        if (
          target &&
          !errors.some(
            (error) =>
              (node.end === error.start || target.end === error.start) &&
              error.parent === node.parent,
          )
        ) {
          if (
            ["bash", "powershell"].includes(languageId) &&
            ["source", ".", "using"].includes(target.text.toLowerCase())
          ) {
            const dependency =
              descendants(node).find((candidate) =>
                [
                  "string",
                  "string_content",
                  "string_literal",
                  "expandable_string_literal",
                ].includes(candidate.type),
              ) ??
              descendants(node).find(
                (candidate) =>
                  candidate.type === "generic_token" &&
                  candidate.text !== "module",
              );
            if (dependency) addImport(node, dependency);
          } else addCall(node, target);
        }
      }
    }
  }
  const declarations = new Set(
    symbols.map(
      (s) => `${s.declarationRange.startByte}:${s.declarationRange.endByte}`,
    ),
  );
  for (const statement of root.children.filter((node) =>
    semanticNodes.includes(node),
  )) {
    const equals = statement.children.findIndex((node) => node.text === "=");
    if (equals > 0) {
      const assigned = statement.children
        .slice(0, equals)
        .reverse()
        .find((node) =>
          ["identifier", "word", "variable_name", "variable"].includes(
            node.type,
          ),
        );
      if (assigned) declarations.add(`${assigned.start}:${assigned.end}`);
    }
  }
  for (const node of semanticNodes) {
    if (
      [
        "variable_assignment",
        "left_assignment_expression",
        "assignment_expression",
      ].includes(node.type)
    ) {
      const assigned = descendants(node).find((candidate) =>
        ["variable_name", "variable", "word", "identifier"].includes(
          candidate.type,
        ),
      );
      if (assigned) declarations.add(`${assigned.start}:${assigned.end}`);
    }
    if (["parameter", "script_parameter"].includes(node.type)) {
      const parameter = descendants(node).find((candidate) =>
        ["variable_name", "variable", "identifier"].includes(candidate.type),
      );
      if (parameter) declarations.add(`${parameter.start}:${parameter.end}`);
    }
  }
  for (const node of semanticNodes.filter((n) =>
    [
      "identifier",
      "word",
      "variable",
      "variable_name",
      "simple_identifier",
      "simple_name",
      "module_identifier",
    ].includes(n.type),
  )) {
    references.push({
      enclosingSymbolId: null,
      id: id("reference", node, node.text),
      name: node.text,
      range: range(node),
      role: declarations.has(`${node.start}:${node.end}`) ? "write" : "read",
    });
  }
  const diagnostics: SyntaxDiagnostic[] = errors.map((node) => ({
    code: node.missing ? "missing-node" : "parse-error",
    message: node.missing
      ? "Tree-sitter inserted a missing node"
      : "Parser recovered from malformed source",
    range: range(node),
    severity: "error",
  }));
  if (languageId === "verilog") {
    diagnostics.push({
      code: "truncated",
      message:
        "Verilog is parsed through the bundled SystemVerilog compatibility grammar",
      range: range(root),
      severity: "warning",
    });
  }
  const normalized = all.map((node) => ({
    childIds: node.children.map((c) =>
      stableNodeId(sourceDigest, c.type, c.start, c.end),
    ),
    id: stableNodeId(sourceDigest, node.type, node.start, node.end),
    kind: node.type,
    named: true,
    parentId: node.parent
      ? stableNodeId(
          sourceDigest,
          node.parent.type,
          node.parent.start,
          node.parent.end,
        )
      : null,
    range: range(node),
  }));
  const grammarIdentity = ["sql", "hcl", "fortran"].includes(languageId)
    ? `structured:${languageId}:v1`
    : languageId === "verilog"
      ? "systemverilog:verilog-subset-v1"
      : languageId;
  const extractorFingerprint = sha256(
    "infra-structured-v1+tree-sitter-wasm@1.1.8+web-tree-sitter@0.27.0+coordinates-v2",
  );
  return {
    calls,
    diagnostics,
    exports,
    extractorFingerprint,
    grammarFingerprint: sha256(JSON.stringify([grammarIdentity, "1.1.8"])),
    implementations,
    imports,
    inheritance,
    languageId,
    nodes: normalized,
    parserFingerprint: sha256(
      grammarIdentity.startsWith("structured")
        ? "ast-mcp-structured-parser-v1"
        : "web-tree-sitter@0.27.0",
    ),
    partial: errors.length > 0 || languageId === "verilog",
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
        symbols.map((x) => x.id),
        imports.map((x) => x.id),
        calls.map((x) => x.id),
        inheritance.map((x) => x.id),
        implementations.map((x) => x.id),
        exports.map((x) => x.id),
      ]),
    ),
  };
}
async function parse(message: StartMessage): Promise<SyntaxFacts> {
  const loaded = await grammar(message.languageId);
  if (!loaded)
    return buildFacts(
      message.languageId,
      message.source,
      structuredTree(message.languageId, message.source),
    );
  const parser = new Parser();
  try {
    parser.setLanguage(loaded);
    const tree = parser.parse(message.source);
    if (!tree) throw new Error("Tree-sitter returned no syntax tree");
    try {
      return buildFacts(
        message.languageId,
        message.source,
        flattenTree(tree.rootNode),
      );
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
installWasmWorker({
  invalidId: positiveRequestId,
  parse,
  port: parentPort,
  suppressCanceledErrors: true,
  validate: validateInfraWorkerRequest,
});

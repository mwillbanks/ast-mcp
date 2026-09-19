import { parentPort } from "node:worker_threads";

import { getWasmPath } from "tree-sitter-wasm";
import { Language, Parser, type Node as TreeNode } from "web-tree-sitter";

import {
  SourceCoordinateIndex,
  type SyntaxCall,
  type SyntaxDiagnostic,
  type SyntaxFacts,
  type SyntaxImport,
  type SyntaxReference,
  type SyntaxRelationship,
  type SyntaxSymbol,
  sha256,
  stableNodeId,
} from "../../parser/index.ts";
import {
  isLegacyWorkerId,
  isLegacyWorkerRequest,
  type LegacyWorkerStart,
  legacyGrammarFingerprint,
  legacyLanguageExtractorFingerprint,
  legacyParserFingerprint,
} from "../legacy/protocol.ts";
import type { LegacyLanguageId } from "../legacy/types.ts";
import { installWasmWorker } from "./wasm-worker-runtime.ts";

interface Token {
  end: number;
  kind: "identifier" | "keyword" | "punctuation";
  start: number;
  text: string;
}
interface RawFacts {
  calls: Array<{ end: number; name: string; start: number }>;
  diagnostics: Array<{ end: number; message: string; start: number }>;
  imports: Array<{
    end: number;
    local: string;
    name: string;
    source: string;
    start: number;
  }>;
  inheritance: Array<{ end: number; name: string; start: number }>;
  references: Array<{
    end: number;
    name: string;
    role: "read" | "write" | "type";
    start: number;
  }>;
  symbols: Array<{
    end: number;
    exported: boolean;
    kind: SyntaxSymbol["kind"];
    name: string;
    start: number;
  }>;
}

const keywords: Record<LegacyLanguageId, Set<string>> = {
  "common-lisp": new Set([
    "defun",
    "defmacro",
    "defclass",
    "defvar",
    "defparameter",
    "defconstant",
  ]),
  dreammaker: new Set([
    "proc",
    "var",
    "datum",
    "mob",
    "obj",
    "verb",
    "if",
    "else",
    "for",
    "while",
    "switch",
    "spawn",
  ]),
  ocaml: new Set([
    "let",
    "rec",
    "type",
    "module",
    "open",
    "include",
    "class",
    "method",
  ]),
  pascal: new Set([
    "class",
    "function",
    "procedure",
    "program",
    "unit",
    "uses",
    "var",
    "type",
    "if",
    "then",
    "else",
    "while",
    "for",
    "case",
    "repeat",
    "with",
  ]),
  "robot-framework": new Set(),
};

function wordStart(char: string): boolean {
  return /[A-Za-z_À-￿]/u.test(char);
}
function wordPart(char: string): boolean {
  return /[\wÀ-￿!?-]/u.test(char);
}

function scan(
  source: string,
  languageId: LegacyLanguageId,
): { tokens: Token[]; diagnostics: RawFacts["diagnostics"] } {
  const tokens: Token[] = [];
  const diagnostics: RawFacts["diagnostics"] = [];
  const stack: Array<{ char: string; start: number }> = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (languageId === "pascal" && char === "{") {
      const end = source.indexOf("}", index + 1);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (languageId === "pascal" && source.startsWith("(*", index)) {
      const end = source.indexOf("*)", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (languageId === "ocaml" && source.startsWith("(*", index)) {
      let depth = 1;
      let end = index + 2;
      while (end < source.length && depth) {
        if (source.startsWith("(*", end)) {
          depth++;
          end += 2;
        } else if (source.startsWith("*)", end)) {
          depth--;
          end += 2;
        } else end++;
      }
      index = end;
      continue;
    }
    if (
      (languageId === "common-lisp" && char === ";") ||
      ((languageId === "dreammaker" || languageId === "pascal") &&
        source.startsWith("//", index)) ||
      (languageId === "robot-framework" && char === "#")
    ) {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (languageId === "dreammaker" && source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === quote) {
          end++;
          break;
        }
        end++;
      }
      index = end;
      continue;
    }
    if (wordStart(char)) {
      let end = index + 1;
      while (end < source.length && wordPart(source[end] ?? "")) end++;
      const text = source.slice(index, end);
      tokens.push({
        end,
        kind: keywords[languageId].has(text.toLowerCase())
          ? "keyword"
          : "identifier",
        start: index,
        text,
      });
      index = end;
      continue;
    }
    if ("([{".includes(char)) stack.push({ char, start: index });
    if (")]}".includes(char)) {
      const expected = char === ")" ? "(" : char === "]" ? "[" : "{";
      const open = stack.pop();
      if (!open || open.char !== expected)
        diagnostics.push({
          end: index + 1,
          message: "Unexpected closing delimiter",
          start: index,
        });
    }
    if (!/\s/u.test(char))
      tokens.push({
        end: index + 1,
        kind: "punctuation",
        start: index,
        text: char,
      });
    index++;
  }
  for (const open of stack)
    diagnostics.push({
      end: source.length,
      message: "Unclosed delimiter",
      start: open.start,
    });
  return { diagnostics, tokens };
}
function empty(): RawFacts {
  return {
    calls: [],
    diagnostics: [],
    imports: [],
    inheritance: [],
    references: [],
    symbols: [],
  };
}
function addRef(raw: RawFacts, token: Token, role: SyntaxReference["role"]) {
  raw.references.push({
    end: token.end,
    name: token.text,
    role,
    start: token.start,
  });
}
function structured(
  languageId: LegacyLanguageId,
  source: string,
): { raw: RawFacts; tokens: Token[] } {
  const scanned = scan(source, languageId);
  const raw = empty();
  raw.diagnostics.push(...scanned.diagnostics);
  const tokens = scanned.tokens;
  if (languageId === "robot-framework") {
    const coordinates = new SourceCoordinateIndex(source);
    let section = "";
    let offset = 0;
    for (const line of source.split(/(?<=\n)/u)) {
      const body = line.replace(/[\r\n]+$/u, "");
      const trimmed = body.trim();
      if (/^\*\*\* .+ \*\*\*$/u.test(trimmed)) {
        section = trimmed.toLowerCase();
        offset += line.length;
        continue;
      }
      if (!trimmed || trimmed.startsWith("#")) {
        offset += line.length;
        continue;
      }
      const cells: Array<{ start: number; text: string }> = [];
      let cursor = 0;
      for (const piece of body.split(/(?:\t+| {2,})/u)) {
        const at = body.indexOf(piece, cursor);
        cursor = at + piece.length;
        if (piece.trim())
          cells.push({ start: offset + at, text: piece.trim() });
      }
      const first = cells[0];
      if (!first) {
        offset += line.length;
        continue;
      }
      if (
        section.includes("settings") &&
        ["library", "resource"].includes(first.text.toLowerCase())
      ) {
        const dependency = cells[1];
        if (dependency)
          raw.imports.push({
            end: dependency.start + dependency.text.length,
            local: dependency.text,
            name: "*",
            source: dependency.text,
            start: dependency.start,
          });
      } else if (section.includes("test cases") && !/^\s/u.test(body)) {
        raw.symbols.push({
          end: first.start + first.text.length,
          exported: true,
          kind: "function",
          name: first.text,
          start: first.start,
        });
        addRef(
          raw,
          {
            ...first,
            end: first.start + first.text.length,
            kind: "identifier",
          },
          "write",
        );
      } else if (section.includes("keywords") && !/^\s/u.test(body)) {
        raw.symbols.push({
          end: first.start + first.text.length,
          exported: true,
          kind: "function",
          name: first.text,
          start: first.start,
        });
        addRef(
          raw,
          {
            ...first,
            end: first.start + first.text.length,
            kind: "identifier",
          },
          "write",
        );
      } else if (
        /^\s/u.test(body) &&
        (section.includes("test cases") || section.includes("keywords"))
      ) {
        raw.calls.push({
          end: first.start + first.text.length,
          name: first.text,
          start: first.start,
        });
        addRef(
          raw,
          {
            ...first,
            end: first.start + first.text.length,
            kind: "identifier",
          },
          "read",
        );
      }
      offset += line.length;
    }
    void coordinates;
    return { raw, tokens };
  }
  if (languageId === "dreammaker") {
    let offset = 0;
    for (const line of source.split(/(?<=\n)/u)) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("#include")) {
        const quote = trimmed.indexOf('"');
        const close = quote < 0 ? -1 : trimmed.indexOf('"', quote + 1);
        if (quote >= 0 && close > quote) {
          const leading = line.length - trimmed.length;
          const start = offset + leading + quote + 1;
          const dependency = trimmed.slice(quote + 1, close);
          raw.imports.push({
            end: start + dependency.length,
            local: dependency,
            name: "*",
            source: dependency,
            start,
          });
        }
      }
      offset += line.length;
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const lower = token.text.toLowerCase();
    const next = tokens[i + 1];
    const next2 = tokens[i + 2];
    if (languageId === "pascal") {
      if (
        lower === "class" &&
        tokens[i - 1]?.text === "=" &&
        tokens[i - 2]?.kind === "identifier"
      ) {
        const name = tokens[i - 2];
        if (name) {
          raw.symbols.push({
            end: name.end,
            exported: true,
            kind: "class",
            name: name.text,
            start: name.start,
          });
          addRef(raw, name, "write");
        }
      }
      if (token.kind === "identifier" && next?.text === ":")
        addRef(raw, token, "write");
      if (
        ["procedure", "function"].includes(lower) &&
        next?.kind === "identifier"
      ) {
        raw.symbols.push({
          end: next.end,
          exported: true,
          kind: "function",
          name: next.text,
          start: next.start,
        });
        addRef(raw, next, "write");
        continue;
      }
      if (["program", "unit"].includes(lower) && next?.kind === "identifier") {
        raw.symbols.push({
          end: next.end,
          exported: true,
          kind: "namespace",
          name: next.text,
          start: next.start,
        });
        addRef(raw, next, "write");
        continue;
      }
      if (lower === "uses") {
        for (let j = i + 1; j < tokens.length && tokens[j]?.text !== ";"; j++) {
          const item = tokens[j];
          if (item?.kind === "identifier")
            raw.imports.push({
              end: item.end,
              local: item.text,
              name: "*",
              source: item.text,
              start: item.start,
            });
        }
        continue;
      }
      if (
        lower === "class" &&
        next?.text === "(" &&
        next2?.kind === "identifier"
      )
        raw.inheritance.push({
          end: next2.end,
          name: next2.text,
          start: next2.start,
        });
    } else if (languageId === "dreammaker") {
      const lineStart = source.lastIndexOf("\n", token.start - 1) + 1;
      const beginsPath =
        token.text === "/" &&
        source.slice(lineStart, token.start).trim() === "";
      if (
        beginsPath &&
        (next?.kind === "identifier" || next?.kind === "keyword")
      ) {
        let j = i + 1;
        const parts: string[] = [];
        const newline = source.indexOf("\n", token.start);
        const lineEnd = newline < 0 ? source.length : newline;
        while (
          (tokens[j]?.start ?? source.length) < lineEnd &&
          (tokens[j]?.kind === "identifier" ||
            tokens[j]?.kind === "keyword" ||
            tokens[j]?.text === "/")
        ) {
          if (tokens[j]?.kind !== "punctuation") parts.push(tokens[j]?.text);
          j++;
        }
        const last = tokens[j - 1];
        if (parts.length && last) {
          raw.symbols.push({
            end: last.end,
            exported: true,
            kind:
              parts.includes("proc") || parts.includes("verb")
                ? "function"
                : "class",
            name: parts.at(-1) ?? "",
            start: token.start,
          });
          if (tokens[j]?.text === "(") {
            for (
              let parameterIndex = j + 1;
              parameterIndex < tokens.length;
              parameterIndex++
            ) {
              const parameter = tokens[parameterIndex];
              if (!parameter || parameter.text === ")") break;
              if (parameter.kind === "identifier")
                addRef(raw, parameter, "write");
            }
          }
        }
      }
      if (lower === "var" && next?.kind === "identifier")
        addRef(raw, next, "write");
    }
    if (token.kind === "identifier" && next?.text === "(") {
      const previous = tokens[i - 1]?.text.toLowerCase();
      const pathDeclaration =
        languageId === "dreammaker" &&
        tokens[i - 1]?.text === "/" &&
        source
          .slice(source.lastIndexOf("\n", token.start - 1) + 1, token.start)
          .includes("/proc/");
      if (
        !pathDeclaration &&
        !["procedure", "function", "proc", "verb"].includes(previous ?? "")
      ) {
        raw.calls.push({
          end: token.end,
          name: token.text,
          start: token.start,
        });
        addRef(raw, token, "read");
      }
    }
  }
  return { raw, tokens };
}
const wasmLanguages = new Map<string, Language>();
let initialized: Promise<void> | undefined;
async function wasm(
  languageId: "ocaml" | "common-lisp",
  source: string,
): Promise<{ raw: RawFacts; treeNodes: TreeNode[] }> {
  initialized ??= Parser.init();
  await initialized;
  let grammar = wasmLanguages.get(languageId);
  if (!grammar) {
    grammar = await Language.load(
      getWasmPath(languageId === "common-lisp" ? "commonlisp" : "ocaml"),
    );
    wasmLanguages.set(languageId, grammar);
  }
  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(source);
  if (!tree) throw new Error("Tree-sitter returned no tree");
  const all: TreeNode[] = [];
  const visit = (node: TreeNode) => {
    all.push(node);
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  const raw = empty();
  for (const node of all) {
    if (node.type === "ERROR" || node.isMissing)
      raw.diagnostics.push({
        end: node.endIndex,
        message: node.isMissing
          ? "Tree-sitter inserted a missing node"
          : "Tree-sitter recovered from malformed source",
        start: node.startIndex,
      });
    if (languageId === "ocaml") {
      if (node.type === "let_binding") {
        const name =
          node.childForFieldName("pattern") ??
          node.namedChildren.find((c) => c.type === "value_name");
        if (name) {
          raw.symbols.push({
            end: name.endIndex,
            exported: true,
            kind: node.namedChildren.some((child) => child.type === "parameter")
              ? "function"
              : "variable",
            name: name.text,
            start: name.startIndex,
          });
          raw.references.push({
            end: name.endIndex,
            name: name.text,
            role: "write",
            start: name.startIndex,
          });
        }
      }
      if (node.type === "type_binding") {
        const name = node.childForFieldName("name");
        if (name) {
          raw.symbols.push({
            end: name.endIndex,
            exported: true,
            kind: "type",
            name: name.text,
            start: name.startIndex,
          });
          raw.references.push({
            end: name.endIndex,
            name: name.text,
            role: "write",
            start: name.startIndex,
          });
        }
      }
      if (["open_module", "include_module"].includes(node.type)) {
        const name = node.namedChildren.at(-1);
        if (name)
          raw.imports.push({
            end: name.endIndex,
            local: name.text,
            name: "*",
            source: name.text,
            start: name.startIndex,
          });
      }
      if (node.type === "application_expression") {
        const callee =
          node.childForFieldName("function") ?? node.namedChildren.at(0);
        if (callee) {
          raw.calls.push({
            end: callee.endIndex,
            name: callee.text,
            start: callee.startIndex,
          });
        }
      }
      if (node.type === "value_pattern" && node.parent?.type === "parameter")
        raw.references.push({
          end: node.endIndex,
          name: node.text,
          role: "write",
          start: node.startIndex,
        });
      if (node.type === "value_name" && node.parent?.type === "value_path")
        raw.references.push({
          end: node.endIndex,
          name: node.text,
          role: "read",
          start: node.startIndex,
        });
    } else if (node.type === "defun") {
      const header = node.namedChildren.find(
        (child) => child.type === "defun_header",
      );
      const name = header?.childForFieldName("function_name");
      if (name) {
        raw.symbols.push({
          end: name.endIndex,
          exported: true,
          kind: "function",
          name: name.text,
          start: name.startIndex,
        });
        raw.references.push({
          end: name.endIndex,
          name: name.text,
          role: "write",
          start: name.startIndex,
        });
      }
      const parameters = header?.childForFieldName("lambda_list");
      for (const parameter of parameters?.namedChildren ?? []) {
        if (parameter.type === "sym_lit")
          raw.references.push({
            end: parameter.endIndex,
            name: parameter.text,
            role: "write",
            start: parameter.startIndex,
          });
      }
    } else if (node.type === "list_lit") {
      const children = node.namedChildren;
      const head = children[0];
      const key = head?.text.toLowerCase();
      const name = children[1];
      if (key === "require" && name) {
        const dependency = name.text.replace(/^:/u, "");
        raw.imports.push({
          end: name.endIndex,
          local: dependency,
          name: "*",
          source: dependency,
          start: name.startIndex,
        });
      } else if (
        key &&
        name &&
        [
          "defun",
          "defmacro",
          "defclass",
          "defvar",
          "defparameter",
          "defconstant",
        ].includes(key)
      ) {
        raw.symbols.push({
          end: name.endIndex,
          exported: true,
          kind:
            key === "defclass"
              ? "class"
              : key === "defun" || key === "defmacro"
                ? "function"
                : "variable",
          name: name.text,
          start: name.startIndex,
        });
        raw.references.push({
          end: name.endIndex,
          name: name.text,
          role: "write",
          start: name.startIndex,
        });
        if (key === "defclass") {
          const bases = children[2];
          for (const base of bases?.namedChildren ?? [])
            raw.inheritance.push({
              end: base.endIndex,
              name: base.text,
              start: base.startIndex,
            });
        }
      } else if (
        head?.type === "sym_lit" &&
        node.parent?.type !== "defun_header" &&
        node.parent?.namedChildren[0]?.text.toLowerCase() !== "defclass"
      ) {
        raw.calls.push({
          end: head.endIndex,
          name: head.text,
          start: head.startIndex,
        });
        raw.references.push({
          end: head.endIndex,
          name: head.text,
          role: "read",
          start: head.startIndex,
        });
      }
    }
  }
  tree.delete();
  parser.delete();
  return { raw, treeNodes: [] };
}
function buildFacts(
  languageId: LegacyLanguageId,
  source: string,
  raw: RawFacts,
  tokens: Token[],
): SyntaxFacts {
  const digest = sha256(source);
  const coords = new SourceCoordinateIndex(source);
  const range = (start: number, end: number) => coords.range(start, end);
  const invalid = raw.diagnostics.map((d) => ({ end: d.end, start: d.start }));
  const valid = (x: { start: number; end: number }) =>
    !invalid.some((d) => d.start <= x.start && d.end >= x.end);
  const id = (kind: string, name: string, start: number) =>
    sha256(JSON.stringify([digest, kind, name, start]));
  const symbols: SyntaxSymbol[] = raw.symbols.filter(valid).map((x) => ({
    declarationRange: range(x.start, x.end),
    exported: x.exported,
    id: id("symbol", x.name, x.start),
    kind: x.kind,
    name: x.name,
    qualifiedName: x.name,
    range: range(x.start, x.end),
  }));
  const calls: SyntaxCall[] = raw.calls.filter(valid).map((x) => ({
    callee: x.name,
    enclosingSymbolId: null,
    id: id("call", x.name, x.start),
    range: range(x.start, x.end),
  }));
  const imports: SyntaxImport[] = raw.imports.filter(valid).map((x) => ({
    id: id("import", x.source, x.start),
    importedName: x.name,
    localName: x.local,
    range: range(x.start, x.end),
    source: x.source,
    typeOnly: false,
  }));
  const inheritance: SyntaxRelationship[] = raw.inheritance
    .filter(valid)
    .map((x) => ({
      id: id("inheritance", x.name, x.start),
      range: range(x.start, x.end),
      sourceSymbolId: null,
      targetName: x.name,
    }));
  const references: SyntaxReference[] = raw.references
    .filter(valid)
    .map((x) => ({
      enclosingSymbolId: null,
      id: id("reference", x.name, x.start),
      name: x.name,
      range: range(x.start, x.end),
      role: x.role,
    }));
  const diagnostics: SyntaxDiagnostic[] = raw.diagnostics.map((x) => ({
    code: "parse-error",
    message: x.message,
    range: range(x.start, x.end),
    severity: "error",
  }));
  const rootId = stableNodeId(digest, "root", 0, source.length);
  const tokenNodes = tokens.filter(valid).map((x) => ({
    childIds: [],
    id: stableNodeId(digest, x.kind, x.start, x.end),
    kind: x.kind,
    named: true,
    parentId: rootId,
    range: range(x.start, x.end),
  }));
  const nodes = [
    {
      childIds: tokenNodes.map((n) => n.id),
      id: rootId,
      kind: "root",
      named: true,
      parentId: null,
      range: range(0, source.length),
    },
    ...tokenNodes,
  ];
  const extractorFingerprint = legacyLanguageExtractorFingerprint(languageId);
  const facts: SyntaxFacts = {
    calls,
    diagnostics,
    exports: [],
    extractorFingerprint,
    grammarFingerprint: legacyGrammarFingerprint(languageId),
    implementations: [],
    imports,
    inheritance,
    languageId,
    nodes,
    parserFingerprint: legacyParserFingerprint(),
    partial:
      diagnostics.length > 0 ||
      ["dreammaker", "robot-framework", "pascal"].includes(languageId),
    references,
    rootNodeId: rootId,
    schemaVersion: "ast-mcp.syntax-facts.v1",
    sourceArtifactId: sha256(JSON.stringify(["source", digest])),
    sourceDigest: digest,
    symbols,
    syntaxFactsArtifactId: "",
  };
  facts.syntaxFactsArtifactId = sha256(
    JSON.stringify([
      digest,
      extractorFingerprint,
      symbols.map((x) => x.id),
      imports.map((x) => x.id),
      calls.map((x) => x.id),
      inheritance.map((x) => x.id),
      [],
    ]),
  );
  return facts;
}
async function parse(message: LegacyWorkerStart): Promise<SyntaxFacts> {
  if (message.languageId === "ocaml" || message.languageId === "common-lisp") {
    const result = await wasm(message.languageId, message.source);
    const scanned = scan(message.source, message.languageId);
    result.raw.diagnostics.push(...scanned.diagnostics);
    return buildFacts(
      message.languageId,
      message.source,
      result.raw,
      scanned.tokens,
    );
  }
  const result = structured(message.languageId, message.source);
  return buildFacts(
    message.languageId,
    message.source,
    result.raw,
    result.tokens,
  );
}
installWasmWorker({
  invalidError: "Invalid legacy parser worker request",
  invalidId: (value) => {
    const id =
      value && typeof value === "object"
        ? (value as Record<string, unknown>).id
        : undefined;
    return isLegacyWorkerId(id) ? id : null;
  },
  parse,
  port: parentPort,
  throwOnMissingInvalidId: true,
  validate: (value) => {
    if (!isLegacyWorkerRequest(value)) {
      throw new TypeError("Invalid legacy parser worker request id");
    }
    return value;
  },
});

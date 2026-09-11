import { type SyntaxFacts, sha256 } from "../../parser/index.ts";
import type { DynamicLanguageId } from "./types.ts";

export interface DynamicWorkerStart {
  id: number;
  languageId: DynamicLanguageId;
  source: string;
  type: "start";
}

export interface DynamicWorkerCancel {
  id: number;
  type: "cancel";
}

export type DynamicWorkerRequest = DynamicWorkerStart | DynamicWorkerCancel;

export type DynamicWorkerResult =
  | { facts: SyntaxFacts; id: number; ok: true; type: "result" }
  | { error: string; id: number; ok: false; type: "result" };

export interface DynamicWorkerExpectation {
  languageId: DynamicLanguageId;
  sourceDigest: string;
}

const languageIds = new Set<DynamicLanguageId>([
  "elixir",
  "julia",
  "lua",
  "luau",
  "php",
  "python",
  "r",
  "ruby",
]);
const hash = /^[a-f0-9]{64}$/u;
const symbolKinds = new Set([
  "class",
  "interface",
  "function",
  "method",
  "variable",
  "type",
  "enum",
  "namespace",
  "unknown",
]);
const referenceRoles = new Set(["read", "write", "type"]);
const diagnosticCodes = new Set(["parse-error", "missing-node", "truncated"]);
const diagnosticSeverities = new Set(["error", "warning"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function safeNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isDynamicWorkerId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function nonempty(value: unknown): value is string {
  return string(value) && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || string(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(string);
}

function position(value: unknown): boolean {
  return (
    exact(value, ["column", "line"]) &&
    safeNonnegative(value.column) &&
    safeNonnegative(value.line)
  );
}

function coordinate(value: unknown): boolean {
  return (
    exact(value, [
      "byteOffset",
      "characterOffset",
      "column",
      "line",
      "utf16Column",
      "utf16Offset",
    ]) &&
    safeNonnegative(value.byteOffset) &&
    safeNonnegative(value.characterOffset) &&
    safeNonnegative(value.column) &&
    safeNonnegative(value.line) &&
    safeNonnegative(value.utf16Column) &&
    safeNonnegative(value.utf16Offset)
  );
}

function range(value: unknown): boolean {
  if (
    !exact(value, [
      "end",
      "endByte",
      "endCoordinate",
      "start",
      "startByte",
      "startCoordinate",
    ])
  )
    return false;
  if (
    !position(value.start) ||
    !position(value.end) ||
    !coordinate(value.startCoordinate) ||
    !coordinate(value.endCoordinate) ||
    !safeNonnegative(value.startByte) ||
    !safeNonnegative(value.endByte)
  )
    return false;
  const start = value.start as { column: number; line: number };
  const end = value.end as { column: number; line: number };
  const startCoordinate = value.startCoordinate as {
    byteOffset: number;
    characterOffset: number;
    column: number;
    line: number;
    utf16Column: number;
    utf16Offset: number;
  };
  const endCoordinate = value.endCoordinate as {
    byteOffset: number;
    characterOffset: number;
    column: number;
    line: number;
    utf16Column: number;
    utf16Offset: number;
  };
  return (
    value.endByte >= value.startByte &&
    endCoordinate.utf16Offset >= startCoordinate.utf16Offset &&
    endCoordinate.characterOffset >= startCoordinate.characterOffset &&
    (end.line > start.line ||
      (end.line === start.line && end.column >= start.column)) &&
    (endCoordinate.line > startCoordinate.line ||
      (endCoordinate.line === startCoordinate.line &&
        endCoordinate.column >= startCoordinate.column &&
        endCoordinate.utf16Column >= startCoordinate.utf16Column)) &&
    start.line === startCoordinate.line &&
    start.column === startCoordinate.column &&
    end.line === endCoordinate.line &&
    end.column === endCoordinate.column &&
    endCoordinate.byteOffset === value.endByte &&
    startCoordinate.byteOffset === value.startByte
  );
}

function nullableNonempty(value: unknown): boolean {
  return value === null || nonempty(value);
}

function node(value: unknown): boolean {
  return (
    exact(value, ["childIds", "id", "kind", "named", "parentId", "range"]) &&
    stringArray(value.childIds) &&
    nonempty(value.id) &&
    nonempty(value.kind) &&
    typeof value.named === "boolean" &&
    nullableNonempty(value.parentId) &&
    range(value.range)
  );
}

function symbol(value: unknown): boolean {
  return (
    exact(value, [
      "declarationRange",
      "exported",
      "id",
      "kind",
      "name",
      "qualifiedName",
      "range",
    ]) &&
    range(value.declarationRange) &&
    typeof value.exported === "boolean" &&
    nonempty(value.id) &&
    string(value.kind) &&
    symbolKinds.has(value.kind) &&
    nonempty(value.name) &&
    nonempty(value.qualifiedName) &&
    range(value.range)
  );
}

function syntaxImport(value: unknown): boolean {
  return (
    exact(value, [
      "id",
      "importedName",
      "localName",
      "range",
      "source",
      "typeOnly",
    ]) &&
    nonempty(value.id) &&
    nonempty(value.importedName) &&
    nonempty(value.localName) &&
    range(value.range) &&
    nonempty(value.source) &&
    typeof value.typeOnly === "boolean"
  );
}

function syntaxExport(value: unknown): boolean {
  return (
    exact(value, [
      "exportedName",
      "id",
      "localName",
      "range",
      "source",
      "typeOnly",
    ]) &&
    nonempty(value.exportedName) &&
    nonempty(value.id) &&
    nullableString(value.localName) &&
    range(value.range) &&
    nullableString(value.source) &&
    typeof value.typeOnly === "boolean"
  );
}

function call(value: unknown): boolean {
  return (
    exact(value, ["callee", "enclosingSymbolId", "id", "range"]) &&
    nonempty(value.callee) &&
    nullableNonempty(value.enclosingSymbolId) &&
    nonempty(value.id) &&
    range(value.range)
  );
}

function relationship(value: unknown): boolean {
  return (
    exact(value, ["id", "range", "sourceSymbolId", "targetName"]) &&
    nonempty(value.id) &&
    range(value.range) &&
    nullableNonempty(value.sourceSymbolId) &&
    nonempty(value.targetName)
  );
}

function reference(value: unknown): boolean {
  return (
    exact(value, ["enclosingSymbolId", "id", "name", "range", "role"]) &&
    nullableNonempty(value.enclosingSymbolId) &&
    nonempty(value.id) &&
    nonempty(value.name) &&
    range(value.range) &&
    string(value.role) &&
    referenceRoles.has(value.role)
  );
}

function diagnostic(value: unknown): boolean {
  return (
    exact(value, ["code", "message", "range", "severity"]) &&
    string(value.code) &&
    diagnosticCodes.has(value.code) &&
    nonempty(value.message) &&
    range(value.range) &&
    string(value.severity) &&
    diagnosticSeverities.has(value.severity)
  );
}

function arrayOf(
  value: unknown,
  validator: (entry: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.every(validator);
}

function uniqueIds(values: readonly { id: string }[]): boolean {
  return new Set(values.map(({ id }) => id)).size === values.length;
}

export function dynamicSourceArtifactId(sourceDigest: string): string {
  return sha256(JSON.stringify(["source", sourceDigest]));
}

export function dynamicGrammarFingerprint(
  languageId: DynamicLanguageId,
): string {
  return sha256(JSON.stringify(["tree-sitter-wasm", "1.1.8", languageId]));
}

export function dynamicParserFingerprint(): string {
  return sha256("web-tree-sitter@0.27.0");
}

export function dynamicSyntaxFactsArtifactId(facts: SyntaxFacts): string {
  return sha256(
    JSON.stringify([
      facts.sourceDigest,
      facts.extractorFingerprint,
      facts.symbols.map((item) => item.id),
      facts.imports.map((item) => item.id),
      facts.calls.map((item) => item.id),
      facts.inheritance.map((item) => item.id),
      facts.exports.map((item) => item.id),
    ]),
  );
}

export function isDynamicSyntaxFacts(
  value: unknown,
  expected: DynamicWorkerExpectation,
): value is SyntaxFacts {
  if (
    !exact(value, [
      "calls",
      "diagnostics",
      "exports",
      "extractorFingerprint",
      "grammarFingerprint",
      "implementations",
      "imports",
      "inheritance",
      "languageId",
      "nodes",
      "parserFingerprint",
      "partial",
      "references",
      "rootNodeId",
      "schemaVersion",
      "sourceArtifactId",
      "sourceDigest",
      "symbols",
      "syntaxFactsArtifactId",
    ])
  )
    return false;
  if (
    !arrayOf(value.calls, call) ||
    !arrayOf(value.diagnostics, diagnostic) ||
    !arrayOf(value.exports, syntaxExport) ||
    !arrayOf(value.implementations, relationship) ||
    !arrayOf(value.imports, syntaxImport) ||
    !arrayOf(value.inheritance, relationship) ||
    !Array.isArray(value.nodes) ||
    !arrayOf(value.nodes, node) ||
    !arrayOf(value.references, reference) ||
    !arrayOf(value.symbols, symbol) ||
    value.nodes.length === 0 ||
    typeof value.partial !== "boolean" ||
    value.schemaVersion !== "ast-mcp.syntax-facts.v1" ||
    value.languageId !== expected.languageId ||
    value.sourceDigest !== expected.sourceDigest ||
    !hash.test(String(value.sourceDigest)) ||
    !hash.test(String(value.extractorFingerprint)) ||
    !hash.test(String(value.grammarFingerprint)) ||
    !hash.test(String(value.parserFingerprint)) ||
    !hash.test(String(value.sourceArtifactId)) ||
    !hash.test(String(value.syntaxFactsArtifactId)) ||
    !nonempty(value.rootNodeId)
  )
    return false;
  const facts = value as unknown as SyntaxFacts;
  const nodeIds = new Set(facts.nodes.map((entry) => entry.id));
  const semanticFacts = [
    ...facts.calls,
    ...facts.exports,
    ...facts.implementations,
    ...facts.imports,
    ...facts.inheritance,
    ...facts.references,
    ...facts.symbols,
  ];
  if (
    !uniqueIds(facts.nodes) ||
    facts.nodes.some(
      (entry) => !uniqueIds(entry.childIds.map((id) => ({ id }))),
    ) ||
    !uniqueIds(semanticFacts) ||
    !nodeIds.has(facts.rootNodeId) ||
    facts.nodes.some(
      (entry) => entry.parentId !== null && !nodeIds.has(entry.parentId),
    ) ||
    facts.nodes.some((entry) => entry.childIds.some((id) => !nodeIds.has(id)))
  )
    return false;
  const fingerprint = dynamicGrammarFingerprint(expected.languageId);
  return (
    facts.sourceArtifactId === dynamicSourceArtifactId(expected.sourceDigest) &&
    facts.extractorFingerprint === fingerprint &&
    facts.grammarFingerprint === fingerprint &&
    facts.parserFingerprint === dynamicParserFingerprint() &&
    facts.syntaxFactsArtifactId === dynamicSyntaxFactsArtifactId(facts)
  );
}

export function isDynamicWorkerRequest(
  value: unknown,
): value is DynamicWorkerRequest {
  if (!record(value) || !isDynamicWorkerId(value.id)) return false;
  if (value.type === "cancel") return exact(value, ["id", "type"]);
  return (
    value.type === "start" &&
    exact(value, ["id", "languageId", "source", "type"]) &&
    string(value.languageId) &&
    languageIds.has(value.languageId as DynamicLanguageId) &&
    string(value.source)
  );
}

export function isDynamicWorkerResult(
  value: unknown,
  expected?: DynamicWorkerExpectation,
): value is DynamicWorkerResult {
  if (
    !record(value) ||
    value.type !== "result" ||
    !isDynamicWorkerId(value.id) ||
    typeof value.ok !== "boolean"
  )
    return false;
  if (value.ok === false) {
    return exact(value, ["error", "id", "ok", "type"]) && nonempty(value.error);
  }
  return (
    exact(value, ["facts", "id", "ok", "type"]) &&
    expected !== undefined &&
    isDynamicSyntaxFacts(value.facts, expected)
  );
}

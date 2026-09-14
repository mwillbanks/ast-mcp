import { type SyntaxFacts, sha256 } from "../../parser/index.ts";

export interface WorkerExpectation<L extends string> {
  languageId: L;
  sourceDigest: string;
}
export interface LanguageWorkerStart<L extends string> {
  id: number;
  languageId: L;
  source: string;
  type: "start";
}
export interface LanguageWorkerCancel {
  id: number;
  type: "cancel";
}
export type LanguageWorkerRequest<L extends string> =
  | LanguageWorkerStart<L>
  | LanguageWorkerCancel;
export type LanguageWorkerResult =
  | { facts: SyntaxFacts; id: number; ok: true; type: "result" }
  | { error: string; id: number; ok: false; type: "result" };
export interface SyntaxFactsValidation<L extends string> {
  extractorFingerprint(languageId: L): string;
  grammarFingerprint(languageId: L): string;
  hashedIds: boolean;
  parserFingerprint(): string;
  requireSemanticLinks: boolean;
}

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
export function isLanguageWorkerId(value: unknown): value is number {
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
function validId(value: unknown, hashed: boolean): value is string {
  return string(value) && (hashed ? hash.test(value) : value.length > 0);
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
    ]) ||
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
  const sc = value.startCoordinate as {
    byteOffset: number;
    characterOffset: number;
    column: number;
    line: number;
    utf16Column: number;
    utf16Offset: number;
  };
  const ec = value.endCoordinate as typeof sc;
  return (
    value.endByte >= value.startByte &&
    ec.utf16Offset >= sc.utf16Offset &&
    ec.characterOffset >= sc.characterOffset &&
    (end.line > start.line ||
      (end.line === start.line && end.column >= start.column)) &&
    (ec.line > sc.line ||
      (ec.line === sc.line &&
        ec.column >= sc.column &&
        ec.utf16Column >= sc.utf16Column)) &&
    start.line === sc.line &&
    start.column === sc.column &&
    end.line === ec.line &&
    end.column === ec.column &&
    ec.byteOffset === value.endByte &&
    sc.byteOffset === value.startByte
  );
}
function node(value: unknown, hashed: boolean): boolean {
  return (
    exact(value, ["childIds", "id", "kind", "named", "parentId", "range"]) &&
    Array.isArray(value.childIds) &&
    value.childIds.every((id) => validId(id, hashed)) &&
    validId(value.id, hashed) &&
    nonempty(value.kind) &&
    typeof value.named === "boolean" &&
    (value.parentId === null || validId(value.parentId, hashed)) &&
    range(value.range)
  );
}
function symbol(value: unknown, hashed: boolean): boolean {
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
    validId(value.id, hashed) &&
    string(value.kind) &&
    symbolKinds.has(value.kind) &&
    nonempty(value.name) &&
    nonempty(value.qualifiedName) &&
    range(value.range)
  );
}
function syntaxImport(value: unknown, hashed: boolean): boolean {
  return (
    exact(value, [
      "id",
      "importedName",
      "localName",
      "range",
      "source",
      "typeOnly",
    ]) &&
    validId(value.id, hashed) &&
    nonempty(value.importedName) &&
    nonempty(value.localName) &&
    range(value.range) &&
    nonempty(value.source) &&
    typeof value.typeOnly === "boolean"
  );
}
function syntaxExport(value: unknown, hashed: boolean): boolean {
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
    validId(value.id, hashed) &&
    nullableString(value.localName) &&
    range(value.range) &&
    nullableString(value.source) &&
    typeof value.typeOnly === "boolean"
  );
}
function call(value: unknown, hashed: boolean): boolean {
  return (
    exact(value, ["callee", "enclosingSymbolId", "id", "range"]) &&
    nonempty(value.callee) &&
    (value.enclosingSymbolId === null ||
      validId(value.enclosingSymbolId, hashed)) &&
    validId(value.id, hashed) &&
    range(value.range)
  );
}
function relationship(value: unknown, hashed: boolean): boolean {
  return (
    exact(value, ["id", "range", "sourceSymbolId", "targetName"]) &&
    validId(value.id, hashed) &&
    range(value.range) &&
    (value.sourceSymbolId === null || validId(value.sourceSymbolId, hashed)) &&
    nonempty(value.targetName)
  );
}
function reference(value: unknown, hashed: boolean): boolean {
  return (
    exact(value, ["enclosingSymbolId", "id", "name", "range", "role"]) &&
    (value.enclosingSymbolId === null ||
      validId(value.enclosingSymbolId, hashed)) &&
    validId(value.id, hashed) &&
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

export function sourceArtifactId(sourceDigest: string): string {
  return sha256(JSON.stringify(["source", sourceDigest]));
}
export function syntaxFactsArtifactId(facts: SyntaxFacts): string {
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

export function isSyntaxFacts<L extends string>(
  value: unknown,
  expected: WorkerExpectation<L>,
  validation: SyntaxFactsValidation<L>,
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
  const hashed = validation.hashedIds;
  if (
    !arrayOf(value.calls, (entry) => call(entry, hashed)) ||
    !arrayOf(value.diagnostics, diagnostic) ||
    !arrayOf(value.exports, (entry) => syntaxExport(entry, hashed)) ||
    !arrayOf(value.implementations, (entry) => relationship(entry, hashed)) ||
    !arrayOf(value.imports, (entry) => syntaxImport(entry, hashed)) ||
    !arrayOf(value.inheritance, (entry) => relationship(entry, hashed)) ||
    !Array.isArray(value.nodes) ||
    !arrayOf(value.nodes, (entry) => node(entry, hashed)) ||
    !arrayOf(value.references, (entry) => reference(entry, hashed)) ||
    !arrayOf(value.symbols, (entry) => symbol(entry, hashed)) ||
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
    !validId(value.rootNodeId, hashed)
  )
    return false;
  const facts = value as unknown as SyntaxFacts;
  const nodeIds = new Set(facts.nodes.map((entry) => entry.id));
  const symbolIds = new Set(facts.symbols.map((entry) => entry.id));
  const semantic = [
    ...facts.calls,
    ...facts.exports,
    ...facts.implementations,
    ...facts.imports,
    ...facts.inheritance,
    ...facts.references,
    ...facts.symbols,
  ];
  const unique = hashed
    ? uniqueIds([...facts.nodes, ...semantic])
    : uniqueIds(facts.nodes) && uniqueIds(semantic);
  const links =
    !validation.requireSemanticLinks ||
    (facts.calls.every(
      (entry) =>
        entry.enclosingSymbolId === null ||
        symbolIds.has(entry.enclosingSymbolId),
    ) &&
      [...facts.implementations, ...facts.inheritance].every(
        (entry) =>
          entry.sourceSymbolId === null || symbolIds.has(entry.sourceSymbolId),
      ) &&
      facts.references.every(
        (entry) =>
          entry.enclosingSymbolId === null ||
          symbolIds.has(entry.enclosingSymbolId),
      ));
  return (
    unique &&
    links &&
    facts.nodes.every((entry) =>
      uniqueIds(entry.childIds.map((id) => ({ id }))),
    ) &&
    nodeIds.has(facts.rootNodeId) &&
    facts.nodes.every(
      (entry) => entry.parentId === null || nodeIds.has(entry.parentId),
    ) &&
    facts.nodes.every((entry) =>
      entry.childIds.every((id) => nodeIds.has(id)),
    ) &&
    facts.sourceArtifactId === sourceArtifactId(expected.sourceDigest) &&
    facts.extractorFingerprint ===
      validation.extractorFingerprint(expected.languageId) &&
    facts.grammarFingerprint ===
      validation.grammarFingerprint(expected.languageId) &&
    facts.parserFingerprint === validation.parserFingerprint() &&
    facts.syntaxFactsArtifactId === syntaxFactsArtifactId(facts)
  );
}

export function isLanguageWorkerRequest<L extends string>(
  value: unknown,
  languageIds: ReadonlySet<L>,
): value is LanguageWorkerRequest<L> {
  if (!record(value) || !isLanguageWorkerId(value.id)) return false;
  if (value.type === "cancel") return exact(value, ["id", "type"]);
  return (
    value.type === "start" &&
    exact(value, ["id", "languageId", "source", "type"]) &&
    string(value.languageId) &&
    languageIds.has(value.languageId as L) &&
    string(value.source)
  );
}
export function isLanguageWorkerResult<L extends string>(
  value: unknown,
  expected: WorkerExpectation<L> | undefined,
  validateFacts: (
    value: unknown,
    expected: WorkerExpectation<L>,
  ) => value is SyntaxFacts,
): value is LanguageWorkerResult {
  if (
    !record(value) ||
    value.type !== "result" ||
    !isLanguageWorkerId(value.id) ||
    typeof value.ok !== "boolean"
  )
    return false;
  if (value.ok === false)
    return exact(value, ["error", "id", "ok", "type"]) && nonempty(value.error);
  return (
    exact(value, ["facts", "id", "ok", "type"]) &&
    expected !== undefined &&
    validateFacts(value.facts, expected)
  );
}

import type { EvidenceRange } from "../contracts/common.ts";

export type ParserLanguageId =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "css"
  | "html"
  | (string & {});

export interface SourceCoordinate {
  byteOffset: number;
  characterOffset: number;
  column: number;
  line: number;
  utf16Column: number;
  utf16Offset: number;
}

export interface ExactSourceRange extends EvidenceRange {
  endCoordinate: SourceCoordinate;
  startCoordinate: SourceCoordinate;
}

export interface NormalizedSyntaxNode {
  childIds: string[];
  id: string;
  kind: string;
  named: boolean;
  parentId: string | null;
  range: ExactSourceRange;
}

export type SyntaxSymbolKind =
  | "class"
  | "interface"
  | "function"
  | "method"
  | "variable"
  | "type"
  | "enum"
  | "namespace"
  | "unknown";

export interface SyntaxSymbol {
  declarationRange: ExactSourceRange;
  exported: boolean;
  id: string;
  kind: SyntaxSymbolKind;
  name: string;
  qualifiedName: string;
  range: ExactSourceRange;
}

export interface SyntaxImport {
  id: string;
  importedName: string;
  localName: string;
  range: ExactSourceRange;
  source: string;
  typeOnly: boolean;
}

export interface SyntaxExport {
  exportedName: string;
  id: string;
  localName: string | null;
  range: ExactSourceRange;
  source: string | null;
  typeOnly: boolean;
}

export interface SyntaxCall {
  callee: string;
  enclosingSymbolId: string | null;
  id: string;
  range: ExactSourceRange;
}

export interface SyntaxRelationship {
  id: string;
  range: ExactSourceRange;
  sourceSymbolId: string | null;
  targetName: string;
}

export interface SyntaxReference {
  enclosingSymbolId: string | null;
  id: string;
  name: string;
  range: ExactSourceRange;
  role: "read" | "write" | "type";
}

export interface SyntaxDiagnostic {
  code: "parse-error" | "missing-node" | "truncated";
  message: string;
  range: ExactSourceRange;
  severity: "error" | "warning";
}

export interface SyntaxFacts {
  calls: SyntaxCall[];
  diagnostics: SyntaxDiagnostic[];
  exports: SyntaxExport[];
  extractorFingerprint: string;
  grammarFingerprint: string;
  implementations: SyntaxRelationship[];
  imports: SyntaxImport[];
  inheritance: SyntaxRelationship[];
  languageId: ParserLanguageId;
  nodes: NormalizedSyntaxNode[];
  parserFingerprint: string;
  partial: boolean;
  references: SyntaxReference[];
  rootNodeId: string;
  schemaVersion: "ast-mcp.syntax-facts.v1";
  sourceArtifactId: string;
  sourceDigest: string;
  symbols: SyntaxSymbol[];
  syntaxFactsArtifactId: string;
}

export interface ParseSourceRequest {
  extractorVersion?: string;
  grammarVersion?: string;
  languageId: ParserLanguageId;
  maxNodes?: number;
  source: string;
}

export interface SerializedParserError {
  code:
    | "aborted"
    | "closed"
    | "invalid-language"
    | "invalid-request"
    | "queue-full"
    | "source-too-large"
    | "timeout"
    | "worker-error";
  message: string;
  retryable: boolean;
}

export class ParserError extends Error {
  readonly code: SerializedParserError["code"];
  readonly retryable: boolean;

  constructor(error: SerializedParserError) {
    super(error.message);
    this.name = "ParserError";
    this.code = error.code;
    this.retryable = error.retryable;
  }

  toJSON(): SerializedParserError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export interface StructuralMatch {
  id: string;
  kind: string;
  ordinal: number;
  range: ExactSourceRange;
  text: string;
}

export interface StructuralRewriteOperation {
  expectedMatches: number;
  pattern: string;
  replacement: string | readonly string[];
}

export interface StructuralRewriteCandidate {
  edits: Array<{
    matchId: string;
    range: ExactSourceRange;
    replacement: string;
  }>;
  matches: StructuralMatch[];
  source: string;
}

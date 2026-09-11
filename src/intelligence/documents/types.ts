import type { ExactSourceRange, SyntaxFacts } from "../parser/index.ts";

export type DocumentFormat =
  | "markdown"
  | "mdx"
  | "json"
  | "jsonc"
  | "toml"
  | "yaml"
  | "xml"
  | "html"
  | "txt"
  | "rtf";

export type DocumentReferenceKind =
  | "link"
  | "wikilink"
  | "adr"
  | "rfc"
  | "package"
  | "code";

export interface DocumentNode {
  childIds: string[];
  id: string;
  kind: string;
  name: string | null;
  parentId: string | null;
  range: ExactSourceRange;
  value: string | null;
}

export interface DocumentReference {
  id: string;
  kind: DocumentReferenceKind;
  range: ExactSourceRange;
  resolvedSymbolId: string | null;
  target: string;
}

export interface EmbeddedCodeRegion {
  facts: SyntaxFacts | null;
  hostRange: ExactSourceRange;
  languageId: string;
  ordinal: number;
  source: string;
}

export interface RtfTextSegment {
  extractedEnd: number;
  extractedStart: number;
  sourceRange: ExactSourceRange;
  text: string;
}

export interface DocumentDiagnostic {
  code: "malformed-document" | "unsupported-embedded-language";
  message: string;
  range: ExactSourceRange;
  severity: "error" | "warning";
}

export interface DocumentFacts {
  diagnostics: DocumentDiagnostic[];
  embeddedCode: EmbeddedCodeRegion[];
  encoding: string;
  format: DocumentFormat;
  nodes: DocumentNode[];
  references: DocumentReference[];
  rewriteSupported: boolean;
  rtfText: string | null;
  rtfTextSegments: RtfTextSegment[];
  schemaVersion: "ast-mcp.document-facts.v1";
  sourceByteLength: number;
  sourceDigest: string;
  syntaxFactsArtifactId: string;
}

export interface DocumentAnalyzeRequest {
  encoding?: string;
  format: DocumentFormat;
  parseEmbedded?: (
    languageId: string,
    source: string,
  ) => Promise<SyntaxFacts | null> | SyntaxFacts | null;
  source: string | Uint8Array;
}

export interface DocumentRewriteRequest {
  expectedText: string;
  facts: DocumentFacts;
  nodeId: string;
  range: ExactSourceRange;
  replacement: string;
  source: string;
}

export interface DocumentCapability {
  format: DocumentFormat;
  limitations: string[];
  parse: "supported" | "partial";
  provider: "structured" | "tokenizer";
  rewrite: "supported" | "unsupported";
  structuralRead: "supported" | "partial";
}

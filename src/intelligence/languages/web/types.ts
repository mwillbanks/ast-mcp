import type { Program } from "typescript-strada";

import type { LanguageCapability } from "../../contracts/language.ts";
import type {
  ExactSourceRange,
  ParserLanguageId,
  SyntaxFacts,
} from "../../parser/index.ts";

export type WebLanguageId =
  | "javascript"
  | "typescript"
  | "jsx"
  | "tsx"
  | "vue"
  | "svelte"
  | "astro"
  | "ejs"
  | "blade"
  | "razor";

export type ResolutionKind =
  | "import"
  | "export"
  | "call"
  | "inheritance"
  | "implementation";

export interface CompilerResolution {
  id: string;
  kind: ResolutionKind;
  name: string;
  range: ExactSourceRange;
  resolvedFile: string | null;
  resolvedName: string | null;
}

export interface EmbeddedRegion {
  endUtf16: number;
  hostLanguageId: WebLanguageId;
  languageId: ParserLanguageId;
  ordinal: number;
  source: string;
  startUtf16: number;
}

export interface WebLanguageAnalysis {
  diagnostics: WebLanguageDiagnostic[];
  embeddedRegions: EmbeddedRegion[];
  facts: SyntaxFacts;
  languageId: WebLanguageId;
  resolutions: CompilerResolution[];
}

export interface WebLanguageDiagnostic {
  code: "malformed-embedded-region" | "unsupported-construct";
  message: string;
  range: ExactSourceRange;
  severity: "error" | "warning";
}

export interface WebAnalyzeRequest {
  companionSources?: Readonly<Record<string, string>>;
  compilerProgram?: Program;
  fileName?: string;
  languageId: WebLanguageId;
  source: string;
}

export interface WebLanguageAdapter {
  analyze(request: WebAnalyzeRequest): WebLanguageAnalysis;
  capability: LanguageCapability;
  extensions: readonly string[];
  languageId: WebLanguageId;
}

export interface WebLanguageGroupManifest {
  adapters: readonly WebLanguageAdapter[];
  groupId: "web";
  implementationFingerprint: string;
  schemaVersion: "ast-mcp.intelligence.v1";
}

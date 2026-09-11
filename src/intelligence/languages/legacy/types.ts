import type { LanguageCapability } from "../../contracts/language.ts";
import type { SyntaxFacts } from "../../parser/index.ts";

export type LegacyLanguageId =
  | "pascal"
  | "ocaml"
  | "common-lisp"
  | "dreammaker"
  | "robot-framework";

export interface LegacyAnalyzeRequest {
  languageId: LegacyLanguageId;
  signal?: AbortSignal;
  source: string;
  timeoutMs?: number;
}

export interface LegacyLanguageAdapter {
  analyze(request: LegacyAnalyzeRequest): Promise<SyntaxFacts>;
  available: boolean;
  capability: LanguageCapability;
  extensions: readonly string[];
  languageId: LegacyLanguageId;
  unavailableReason: string | null;
}

export interface LegacyLanguageGroupManifest {
  adapters: readonly LegacyLanguageAdapter[];
  groupId: "legacy";
  implementationFingerprint: string;
  provenance: { graphifyRevision: string };
  schemaVersion: "ast-mcp.intelligence.v1";
}

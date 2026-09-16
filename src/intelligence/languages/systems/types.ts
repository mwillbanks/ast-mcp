import type { LanguageCapability } from "../../contracts/language.ts";
import type {
  DynamicGrammarAsset,
  DynamicGrammarManifest,
  SyntaxFacts,
} from "../../parser/index.ts";

export type SystemsLanguageId =
  | "c"
  | "cpp"
  | "objc"
  | "swift"
  | "rust"
  | "go"
  | "zig"
  | "dart";
export interface SystemsGrammarAssetConfig extends DynamicGrammarAsset {
  astGrepLanguage: string;
  grammarVersion: string;
  languageId: SystemsLanguageId;
}
export interface SystemsAnalyzeRequest {
  languageId: SystemsLanguageId;
  signal?: AbortSignal;
  source: string;
  timeoutMs?: number;
}
export interface SystemsLanguageAdapter {
  analyze(request: SystemsAnalyzeRequest): Promise<SyntaxFacts>;
  capability: LanguageCapability;
  extensions: readonly string[];
  languageId: SystemsLanguageId;
}
export interface SystemsLanguageGroupManifest {
  adapters: readonly SystemsLanguageAdapter[];
  createGrammarManifest(
    assets: readonly SystemsGrammarAssetConfig[],
  ): DynamicGrammarManifest;
  groupId: "systems";
  implementationFingerprint: string;
  schemaVersion: "ast-mcp.intelligence.v1";
}

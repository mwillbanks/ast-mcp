import type { LanguageCapability } from "../../contracts/language.ts";
import type {
  DynamicGrammarAsset,
  DynamicGrammarManifest,
  LanguageRegistry,
  SyntaxFacts,
} from "../../parser/index.ts";

export type JvmLanguageId =
  | "java"
  | "kotlin"
  | "scala"
  | "groovy"
  | "csharp"
  | "apex";

export interface JvmGrammarAssetConfig extends DynamicGrammarAsset {
  astGrepLanguage: string;
  grammarVersion: string;
  languageId: JvmLanguageId;
}

export interface JvmAnalyzeRequest {
  languageId: JvmLanguageId;
  registry?: LanguageRegistry;
  signal?: AbortSignal;
  source: string;
  timeoutMs?: number;
}

export interface JvmLanguageAdapter {
  analyze(request: JvmAnalyzeRequest): Promise<SyntaxFacts>;
  available: boolean;
  capability: LanguageCapability;
  extensions: readonly string[];
  languageId: JvmLanguageId;
  unavailableReason: string | null;
}

export interface JvmLanguageGroupManifest {
  adapters: readonly JvmLanguageAdapter[];
  createGrammarManifest(
    assets: readonly JvmGrammarAssetConfig[],
  ): DynamicGrammarManifest;
  groupId: "jvm";
  implementationFingerprint: string;
  schemaVersion: "ast-mcp.intelligence.v1";
}

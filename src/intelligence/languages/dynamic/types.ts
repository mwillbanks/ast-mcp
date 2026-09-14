import type { LanguageCapability } from "../../contracts/language.ts";
import type {
  DynamicGrammarAsset,
  DynamicGrammarManifest,
  SyntaxFacts,
} from "../../parser/index.ts";

export type DynamicLanguageId =
  | "python"
  | "ruby"
  | "php"
  | "lua"
  | "luau"
  | "r"
  | "julia"
  | "elixir";

export interface DynamicGrammarAssetConfig extends DynamicGrammarAsset {
  astGrepLanguage: string;
  grammarVersion: string;
  languageId: DynamicLanguageId;
}

export interface DynamicAnalyzeRequest {
  languageId: DynamicLanguageId;
  signal?: AbortSignal;
  source: string;
  timeoutMs?: number;
}

export interface DynamicLanguageAdapter {
  analyze(request: DynamicAnalyzeRequest): Promise<SyntaxFacts>;
  available: boolean;
  capability: LanguageCapability;
  extensions: readonly string[];
  languageId: DynamicLanguageId;
  unavailableReason: string | null;
}

export interface DynamicLanguageGroupManifest {
  adapters: readonly DynamicLanguageAdapter[];
  createGrammarManifest(
    assets: readonly DynamicGrammarAssetConfig[],
  ): DynamicGrammarManifest;
  groupId: "dynamic";
  implementationFingerprint: string;
  schemaVersion: "ast-mcp.intelligence.v1";
}

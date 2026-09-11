import type { LanguageCapability } from "../../contracts/language.ts";
import type {
  DynamicGrammarAsset,
  DynamicGrammarManifest,
  LanguageRegistry,
  SyntaxFacts,
} from "../../parser/index.ts";

export type InfraLanguageId =
  | "bash"
  | "powershell"
  | "sql"
  | "hcl"
  | "fortran"
  | "verilog"
  | "systemverilog";
export interface InfraGrammarAssetConfig extends DynamicGrammarAsset {
  astGrepLanguage: string;
  grammarVersion: string;
  languageId: InfraLanguageId;
}
export interface InfraAnalyzeRequest {
  languageId: InfraLanguageId;
  registry?: LanguageRegistry;
  signal?: AbortSignal;
  source: string;
  timeoutMs?: number;
}
export interface InfraLanguageAdapter {
  analyze(request: InfraAnalyzeRequest): Promise<SyntaxFacts>;
  available: boolean;
  capability: LanguageCapability;
  extensions: readonly string[];
  languageId: InfraLanguageId;
  unavailableReason: string | null;
}
export interface InfraLanguageGroupManifest {
  adapters: readonly InfraLanguageAdapter[];
  createGrammarManifest(
    assets: readonly InfraGrammarAssetConfig[],
  ): DynamicGrammarManifest;
  groupId: "infra";
  implementationFingerprint: string;
  schemaVersion: "ast-mcp.intelligence.v1";
}

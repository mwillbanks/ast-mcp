import { INTELLIGENCE_SCHEMA_VERSION } from "../../contracts/common.ts";
import {
  type CapabilityClaim,
  type LanguageCapability,
  LanguageCapabilitySchema,
} from "../../contracts/language.ts";
import {
  type DynamicGrammarManifest,
  type DynamicGrammarManifestEntry,
  type LanguageImplementation,
  sha256,
} from "../../parser/index.ts";
import { analyzeInfraLanguage, infraExtractorFingerprint } from "./analyzer.ts";
import type {
  InfraGrammarAssetConfig,
  InfraLanguageAdapter,
  InfraLanguageGroupManifest,
  InfraLanguageId,
} from "./types.ts";

const extensions: Record<InfraLanguageId, readonly string[]> = {
  bash: [".sh", ".bash"],
  fortran: [".f", ".f90", ".f95", ".f03", ".f08"],
  hcl: [".hcl", ".tf"],
  powershell: [".ps1", ".psm1", ".psd1"],
  sql: [".sql"],
  systemverilog: [".sv", ".svh"],
  verilog: [".v", ".vh"],
};
const treeSitter = new Set<InfraLanguageId>([
  "bash",
  "powershell",
  "systemverilog",
  "verilog",
]);
const implementation: LanguageImplementation = {
  callResolution: false,
  embeddedLanguages: false,
  exportResolution: false,
  importResolution: false,
  inheritanceResolution: false,
  match: false,
  parse: true,
  rewrite: false,
  structuralRead: true,
  symbolExtraction: false,
};
function claim(
  status: "supported" | "partial",
  provider: CapabilityClaim["provider"],
  limitations: string[] = [],
): CapabilityClaim {
  return {
    implementationFingerprint: infraExtractorFingerprint,
    limitations,
    provider,
    status,
  };
}
function unsupported(message: string): CapabilityClaim {
  return {
    implementationFingerprint: null,
    limitations: [message],
    provider: "none",
    status: "unsupported",
  };
}
function capability(languageId: InfraLanguageId): LanguageCapability {
  const provider = treeSitter.has(languageId) ? "tree-sitter" : "custom";
  const limitations = treeSitter.has(languageId)
    ? [
        "Extraction is syntactic and does not execute shells, preprocessors, elaborators, or runtimes",
      ]
    : [
        "A purpose-built structured parser covers declarations, dependencies, calls, and assignments; dialect-specific constructs can be partial",
      ];
  return LanguageCapabilitySchema.parse({
    callResolution: unsupported(
      "Call facts are extracted from syntax; runtime and environment resolution are not provided",
    ),
    embeddedLanguageIds: [],
    embeddedLanguages: unsupported(
      "Embedded command and template languages are not extracted",
    ),
    exportResolution: unsupported(
      "Export facts are syntactic; package and environment resolution are not provided",
    ),
    extensions: [...extensions[languageId]],
    importResolution: unsupported(
      "Dependency facts preserve syntax targets without filesystem, database, or module resolution",
    ),
    inheritanceResolution: unsupported(
      "Relationship facts are syntactic and are not resolved",
    ),
    languageId,
    match: unsupported(
      "The infrastructure adapters do not expose structural matching",
    ),
    parse: claim(
      languageId === "verilog" ? "partial" : "supported",
      provider,
      languageId === "verilog"
        ? [
            "Verilog uses the bundled SystemVerilog grammar compatibility subset",
          ]
        : [],
    ),
    rewrite: unsupported(
      "The infrastructure adapters do not expose structural rewrites",
    ),
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    structuralRead: claim("partial", provider, limitations),
    structuredParser: { mode: "none" },
    symbolExtraction: claim("partial", "custom", limitations),
  });
}
export const infraLanguageAdapters = (
  Object.keys(extensions) as InfraLanguageId[]
).map(
  (languageId): InfraLanguageAdapter => ({
    analyze: analyzeInfraLanguage,
    available: true,
    capability: capability(languageId),
    extensions: extensions[languageId],
    languageId,
    unavailableReason: null,
  }),
);
export function infraLanguageAdapter(
  languageId: InfraLanguageId,
): InfraLanguageAdapter {
  const adapter = infraLanguageAdapters.find(
    (candidate) => candidate.languageId === languageId,
  );
  if (!adapter)
    throw new TypeError(`Unsupported infrastructure language: ${languageId}`);
  return adapter;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
  }
  return value;
}
export function createInfraGrammarManifest(
  assets: readonly InfraGrammarAssetConfig[],
): DynamicGrammarManifest {
  const byLanguage = new Map<InfraLanguageId, InfraGrammarAssetConfig>();
  for (const asset of assets) {
    if (byLanguage.has(asset.languageId))
      throw new TypeError(
        `Duplicate infrastructure grammar: ${asset.languageId}`,
      );
    byLanguage.set(asset.languageId, asset);
  }
  const missing = infraLanguageAdapters
    .map(({ languageId }) => languageId)
    .filter((id) => !byLanguage.has(id));
  if (missing.length)
    throw new TypeError(
      `Missing infrastructure grammars: ${missing.join(", ")}`,
    );
  const entries: DynamicGrammarManifestEntry[] = [...byLanguage.values()]
    .sort((a, b) => a.languageId.localeCompare(b.languageId))
    .map((asset) => {
      if (!/^[a-f0-9]{64}$/.test(asset.sha256))
        throw new TypeError(`Invalid grammar SHA-256: ${asset.languageId}`);
      const dynamicAsset = {
        ...(asset.expandoChar ? { expandoChar: asset.expandoChar } : {}),
        ...(asset.languageSymbol
          ? { languageSymbol: asset.languageSymbol }
          : {}),
        libraryPath: asset.libraryPath,
        ...(asset.metaVarChar ? { metaVarChar: asset.metaVarChar } : {}),
        sha256: asset.sha256,
      };
      return {
        descriptor: {
          astGrepLanguage: asset.astGrepLanguage,
          dynamicAsset,
          extensions: extensions[asset.languageId],
          grammarFingerprint: sha256(
            JSON.stringify({
              astGrepLanguage: asset.astGrepLanguage,
              dynamicAsset,
              extensions: [...extensions[asset.languageId]],
              grammarVersion: asset.grammarVersion,
              languageId: asset.languageId,
            }),
          ),
          grammarVersion: asset.grammarVersion,
          languageId: asset.languageId,
        },
        implementation: { ...implementation },
      };
    });
  return deepFreeze({
    entries,
    fingerprint: sha256(JSON.stringify(entries)),
    schemaVersion: "ast-mcp.dynamic-grammars.v1",
  });
}
export const infraLanguageGroupManifest: InfraLanguageGroupManifest =
  deepFreeze({
    adapters: infraLanguageAdapters,
    createGrammarManifest: createInfraGrammarManifest,
    groupId: "infra",
    implementationFingerprint: sha256(
      JSON.stringify(
        infraLanguageAdapters.map((adapter) => [
          adapter.languageId,
          adapter.extensions,
          adapter.capability,
        ]),
      ),
    ),
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
  });

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
import {
  analyzeSystemsLanguage,
  systemsExtractorFingerprint,
} from "./analyzer.ts";
import type {
  SystemsGrammarAssetConfig,
  SystemsLanguageAdapter,
  SystemsLanguageGroupManifest,
  SystemsLanguageId,
} from "./types.ts";

const extensions: Record<SystemsLanguageId, readonly string[]> = {
  c: [".c", ".h"],
  cpp: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
  dart: [".dart"],
  go: [".go"],
  objc: [".m", ".mm"],
  rust: [".rs"],
  swift: [".swift"],
  zig: [".zig"],
};
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
  limitations: string[] = [],
): CapabilityClaim {
  return {
    implementationFingerprint: systemsExtractorFingerprint,
    limitations,
    provider: "tree-sitter",
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
function capability(languageId: SystemsLanguageId): LanguageCapability {
  return LanguageCapabilitySchema.parse({
    callResolution: unsupported(
      "Call facts are extracted without compiler or linker resolution",
    ),
    embeddedLanguageIds: [],
    embeddedLanguages: unsupported(
      "No embedded-language extraction is provided",
    ),
    exportResolution: unsupported(
      "Visibility facts are extracted without module resolution",
    ),
    extensions: [...extensions[languageId]],
    importResolution: unsupported(
      "Import facts are extracted without package or header resolution",
    ),
    inheritanceResolution: unsupported(
      "Heritage facts are extracted without compiler resolution",
    ),
    languageId,
    match: unsupported(
      "This adapter exposes extraction, not structural matching",
    ),
    parse: claim("supported"),
    rewrite: unsupported("This adapter does not expose structural rewrites"),
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    structuralRead: claim("supported"),
    structuredParser: { mode: "none" },
    symbolExtraction: claim("partial", [
      "Macros, conditional compilation, generated code, and compiler binding remain unresolved",
    ]),
  });
}
export const systemsLanguageAdapters = (
  Object.keys(extensions) as SystemsLanguageId[]
).map(
  (languageId): SystemsLanguageAdapter => ({
    analyze: analyzeSystemsLanguage,
    capability: capability(languageId),
    extensions: extensions[languageId],
    languageId,
  }),
);
export function systemsLanguageAdapter(
  languageId: SystemsLanguageId,
): SystemsLanguageAdapter {
  const adapter = systemsLanguageAdapters.find(
    (candidate) => candidate.languageId === languageId,
  );
  if (!adapter)
    throw new TypeError(`Unsupported systems language: ${languageId}`);
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

export function createSystemsGrammarManifest(
  assets: readonly SystemsGrammarAssetConfig[],
): DynamicGrammarManifest {
  const byLanguage = new Map<SystemsLanguageId, SystemsGrammarAssetConfig>();
  for (const asset of assets) {
    if (byLanguage.has(asset.languageId))
      throw new TypeError(`Duplicate dynamic grammar: ${asset.languageId}`);
    byLanguage.set(asset.languageId, asset);
  }
  const missing = systemsLanguageAdapters
    .map((adapter) => adapter.languageId)
    .filter((id) => !byLanguage.has(id));
  if (missing.length)
    throw new TypeError(`Missing dynamic grammars: ${missing.join(", ")}`);
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
      const grammarFingerprint = sha256(
        JSON.stringify({
          astGrepLanguage: asset.astGrepLanguage,
          dynamicAsset,
          extensions: [...extensions[asset.languageId]],
          grammarVersion: asset.grammarVersion,
          languageId: asset.languageId,
        }),
      );
      return {
        descriptor: {
          astGrepLanguage: asset.astGrepLanguage,
          dynamicAsset,
          extensions: [...extensions[asset.languageId]],
          grammarFingerprint,
          grammarVersion: asset.grammarVersion,
          languageId: asset.languageId,
        },
        implementation: { ...implementation },
      };
    });
  return deepFreeze({
    entries,
    fingerprint: sha256(JSON.stringify(entries)),
    schemaVersion: "ast-mcp.dynamic-grammars.v1" as const,
  });
}
export const systemsLanguageGroupManifest: SystemsLanguageGroupManifest = {
  adapters: systemsLanguageAdapters,
  createGrammarManifest: createSystemsGrammarManifest,
  groupId: "systems",
  implementationFingerprint: systemsExtractorFingerprint,
  schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
};

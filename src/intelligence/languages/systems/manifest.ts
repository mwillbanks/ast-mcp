import { INTELLIGENCE_SCHEMA_VERSION } from "../../contracts/common.ts";
import {
  type CapabilityClaim,
  type LanguageCapability,
  LanguageCapabilitySchema,
} from "../../contracts/language.ts";
import type { DynamicGrammarManifest } from "../../parser/index.ts";
import {
  buildGrammarManifest,
  createExtractionImplementation,
} from "../manifest-builders.ts";
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
const implementation = createExtractionImplementation();
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
function createSystemsLanguageAdapter(
  languageId: SystemsLanguageId,
): SystemsLanguageAdapter {
  return {
    analyze: analyzeSystemsLanguage,
    capability: capability(languageId),
    extensions: extensions[languageId],
    languageId,
  };
}
export const systemsLanguageAdapters = (
  Object.keys(extensions) as SystemsLanguageId[]
).map(createSystemsLanguageAdapter);
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

export function createSystemsGrammarManifest(
  assets: readonly SystemsGrammarAssetConfig[],
): DynamicGrammarManifest {
  return buildGrammarManifest({
    assets,
    cloneDescriptorExtensions: true,
    duplicateLabel: "dynamic grammar",
    extensions,
    freeze: true,
    implementation,
    missingLabel: "dynamic grammar",
    requiredLanguageIds: systemsLanguageAdapters.map(
      ({ languageId }) => languageId,
    ),
  });
}
export const systemsLanguageGroupManifest: SystemsLanguageGroupManifest = {
  adapters: systemsLanguageAdapters,
  createGrammarManifest: createSystemsGrammarManifest,
  groupId: "systems",
  implementationFingerprint: systemsExtractorFingerprint,
  schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
};

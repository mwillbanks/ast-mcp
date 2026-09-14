import { INTELLIGENCE_SCHEMA_VERSION } from "../../contracts/common.ts";
import {
  type CapabilityClaim,
  type LanguageCapability,
  LanguageCapabilitySchema,
} from "../../contracts/language.ts";
import { type DynamicGrammarManifest, sha256 } from "../../parser/index.ts";
import { deepFreeze } from "../immutable.ts";
import {
  buildGrammarManifest,
  createExtractionImplementation,
} from "../manifest-builders.ts";
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
const implementation = createExtractionImplementation();
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
function createInfraLanguageAdapter(
  languageId: InfraLanguageId,
): InfraLanguageAdapter {
  return {
    analyze: analyzeInfraLanguage,
    available: true,
    capability: capability(languageId),
    extensions: extensions[languageId],
    languageId,
    unavailableReason: null,
  };
}
export const infraLanguageAdapters = (
  Object.keys(extensions) as InfraLanguageId[]
).map(createInfraLanguageAdapter);
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
export function createInfraGrammarManifest(
  assets: readonly InfraGrammarAssetConfig[],
): DynamicGrammarManifest {
  return buildGrammarManifest({
    assets,
    duplicateLabel: "infrastructure grammar",
    extensions,
    freeze: true,
    implementation,
    missingLabel: "infrastructure grammar",
    requiredLanguageIds: infraLanguageAdapters.map(
      ({ languageId }) => languageId,
    ),
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

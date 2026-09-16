import { INTELLIGENCE_SCHEMA_VERSION } from "../../contracts/common.ts";
import {
  type CapabilityClaim,
  type LanguageCapability,
  LanguageCapabilitySchema,
} from "../../contracts/language.ts";
import { type DynamicGrammarManifest, sha256 } from "../../parser/index.ts";
import {
  buildGrammarManifest,
  createExtractionImplementation,
} from "../manifest-builders.ts";
import { analyzeJvmLanguage, jvmExtractorFingerprint } from "./analyzer.ts";
import type {
  JvmGrammarAssetConfig,
  JvmLanguageAdapter,
  JvmLanguageGroupManifest,
  JvmLanguageId,
} from "./types.ts";

const extensions: Record<JvmLanguageId, readonly string[]> = {
  apex: [".cls", ".trigger"],
  csharp: [".cs"],
  groovy: [".groovy", ".gradle"],
  java: [".java"],
  kotlin: [".kt", ".kts"],
  scala: [".scala", ".sc"],
};
const implementation = createExtractionImplementation();
function claim(
  status: "supported" | "partial",
  provider: CapabilityClaim["provider"],
  limitations: string[] = [],
): CapabilityClaim {
  return {
    implementationFingerprint: jvmExtractorFingerprint,
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
const languageLimits: Record<JvmLanguageId, string> = {
  apex: "Apex runtime schema, SOQL binding, and dynamic dispatch require Salesforce metadata",
  csharp:
    "Assembly references, partial types, extension methods, and dynamic dispatch require Roslyn",
  groovy:
    "Dynamic metaprogramming, scripts, and runtime dispatch cannot be resolved statically",
  java: "Classpath, overload selection, reflection, and runtime dispatch require a Java compiler",
  kotlin:
    "Extension functions, delegated members, multiplatform expect/actual, and overloads require the Kotlin compiler",
  scala:
    "Implicits, givens, extension methods, macros, and overloads require the Scala compiler",
};
function capability(languageId: JvmLanguageId): LanguageCapability {
  const limitation = languageLimits[languageId];
  return LanguageCapabilitySchema.parse({
    callResolution: unsupported(`Resolution is not provided: ${limitation}`),
    embeddedLanguageIds: [],
    embeddedLanguages: unsupported(
      "No embedded language extraction is provided for this adapter group",
    ),
    exportResolution: unsupported(
      "Export facts are extracted from syntax; module resolution is not provided",
    ),
    extensions: [...extensions[languageId]],
    importResolution: unsupported(
      "Import facts preserve AST targets; classpath and assembly resolution are not provided",
    ),
    inheritanceResolution: unsupported(
      `Resolution is not provided: ${limitation}`,
    ),
    languageId,
    match: unsupported(
      "The JVM adapter exposes extraction, not structural matching",
    ),
    parse: claim(
      languageId === "apex" ? "partial" : "supported",
      "tree-sitter",
      languageId === "apex"
        ? [
            "Apex uses the bundled Java grammar as an AST-compatible subset parser",
          ]
        : [],
    ),
    rewrite: unsupported("The JVM adapter does not expose structural rewrites"),
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    structuralRead:
      languageId === "apex"
        ? claim("partial", "tree-sitter", [
            "Apex structural reads cover only nodes accepted by the bundled Java-compatible subset parser",
          ])
        : claim("supported", "tree-sitter"),
    structuredParser: { mode: "none" },
    symbolExtraction: claim("partial", "custom", [
      "Declarations are extracted from bundled Tree-sitter WASM grammars without compiler binding",
    ]),
  });
}

function createJvmLanguageAdapter(
  languageId: JvmLanguageId,
): JvmLanguageAdapter {
  return {
    analyze: analyzeJvmLanguage,
    available: true,
    capability: capability(languageId),
    extensions: extensions[languageId],
    languageId,
    unavailableReason: null,
  };
}
export const jvmLanguageAdapters = (
  Object.keys(extensions) as JvmLanguageId[]
).map(createJvmLanguageAdapter);
export function jvmLanguageAdapter(
  languageId: JvmLanguageId,
): JvmLanguageAdapter {
  const adapter = jvmLanguageAdapters.find(
    (candidate) => candidate.languageId === languageId,
  );
  if (!adapter) throw new TypeError(`Unsupported JVM language: ${languageId}`);
  return adapter;
}
export function createJvmGrammarManifest(
  assets: readonly JvmGrammarAssetConfig[],
): DynamicGrammarManifest {
  return buildGrammarManifest({
    assets,
    duplicateLabel: "dynamic grammar",
    extensions,
    implementation,
    missingLabel: "dynamic grammar",
    normalizedFingerprintAsset: true,
    requiredLanguageIds: jvmLanguageAdapters
      .filter((adapter) => adapter.available)
      .map(({ languageId }) => languageId),
  });
}
export const jvmLanguageGroupManifest: JvmLanguageGroupManifest = {
  adapters: jvmLanguageAdapters,
  createGrammarManifest: createJvmGrammarManifest,
  groupId: "jvm",
  implementationFingerprint: sha256(
    JSON.stringify(
      jvmLanguageAdapters.map((adapter) => [
        adapter.languageId,
        adapter.extensions,
        adapter.capability,
      ]),
    ),
  ),
  schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
};

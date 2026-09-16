import { INTELLIGENCE_SCHEMA_VERSION } from "../../contracts/common.ts";
import {
  type CapabilityClaim,
  LanguageCapabilitySchema,
} from "../../contracts/language.ts";
import type { DynamicGrammarManifest } from "../../parser/index.ts";
import {
  buildGrammarManifest,
  createExtractionImplementation,
} from "../manifest-builders.ts";
import {
  analyzeDynamicLanguage,
  dynamicExtractorFingerprint,
} from "./analyzer.ts";
import type {
  DynamicGrammarAssetConfig,
  DynamicLanguageAdapter,
  DynamicLanguageGroupManifest,
  DynamicLanguageId,
} from "./types.ts";

const extensions: Record<DynamicLanguageId, readonly string[]> = {
  elixir: [".ex", ".exs"],
  julia: [".jl"],
  lua: [".lua"],
  luau: [".luau"],
  php: [".php", ".phtml"],
  python: [".py", ".pyi"],
  r: [".r", ".R"],
  ruby: [".rb", ".rake", ".gemspec"],
};

export const GRAPHIFY_DYNAMIC_BASELINE_REVISION =
  "3f82bf7f837a07fb0f7668fbdbd5662801906942";

const unavailableReason =
  "tree-sitter-wasm 1.1.8 does not include a Luau grammar";

const grammarImplementation = createExtractionImplementation();

function unsupported(message: string): CapabilityClaim {
  return {
    implementationFingerprint: null,
    limitations: [message],
    provider: "none",
    status: "unsupported",
  };
}

function claim(
  status: "supported" | "partial",
  limitations: string[] = [],
): CapabilityClaim {
  return {
    implementationFingerprint: dynamicExtractorFingerprint,
    limitations,
    provider: "tree-sitter",
    status,
  };
}

function unavailableAdapter(
  languageId: DynamicLanguageId,
): DynamicLanguageAdapter {
  const available = true;
  const unavailable = unsupported(unavailableReason);
  const syntaxOnly = claim("partial", [
    "Results contain syntax facts only and do not resolve environment-dependent bindings",
  ]);
  const noResolution = unsupported(
    "Environment-dependent resolution is unavailable; inspect syntax facts instead",
  );
  return {
    analyze: analyzeDynamicLanguage,
    available,
    capability: LanguageCapabilitySchema.parse({
      callResolution: noResolution,
      embeddedLanguageIds: [],
      embeddedLanguages: unsupported(
        "No embedded-language boundary is available",
      ),
      exportResolution: noResolution,
      extensions: [...extensions[languageId]],
      importResolution: noResolution,
      inheritanceResolution: noResolution,
      languageId,
      match: unsupported(
        "The WASM provider does not expose ast-grep structural matching",
      ),
      parse:
        languageId === "luau"
          ? claim("partial", [
              "Uses the Lua grammar; Luau-only constructs produce explicit parse diagnostics",
            ])
          : claim("supported"),
      rewrite: unsupported(
        "The WASM provider does not expose structural rewriting",
      ),
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      structuralRead:
        languageId === "luau"
          ? claim("partial", [
              "Structural reads cover Lua-compatible syntax only; facts inside Luau parse-error regions are suppressed",
            ])
          : available
            ? claim("supported")
            : unavailable,
      structuredParser: { mode: "none" },
      symbolExtraction: available ? syntaxOnly : unavailable,
    }),
    extensions: extensions[languageId],
    languageId,
    unavailableReason: available ? null : unavailableReason,
  };
}
export const dynamicLanguageAdapters = (
  Object.keys(extensions) as DynamicLanguageId[]
).map(unavailableAdapter);

export function dynamicLanguageAdapter(
  languageId: DynamicLanguageId,
): DynamicLanguageAdapter {
  const adapter = dynamicLanguageAdapters.find(
    (candidate) => candidate.languageId === languageId,
  );
  if (!adapter) {
    throw new TypeError(`Unsupported dynamic language: ${languageId}`);
  }
  return adapter;
}

export function createDynamicGrammarManifest(
  assets: readonly DynamicGrammarAssetConfig[],
): DynamicGrammarManifest {
  return buildGrammarManifest({
    assets,
    duplicateLabel: "dynamic grammar",
    extensions,
    implementation: grammarImplementation,
    normalizedFingerprintAsset: true,
  });
}

export const dynamicLanguageGroupManifest: DynamicLanguageGroupManifest = {
  adapters: dynamicLanguageAdapters,
  createGrammarManifest: createDynamicGrammarManifest,
  groupId: "dynamic",
  implementationFingerprint: dynamicExtractorFingerprint,
  schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
};

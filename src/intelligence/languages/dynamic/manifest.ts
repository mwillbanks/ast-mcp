import { INTELLIGENCE_SCHEMA_VERSION } from "../../contracts/common.ts";
import {
  type CapabilityClaim,
  LanguageCapabilitySchema,
} from "../../contracts/language.ts";
import {
  type DynamicGrammarManifest,
  type DynamicGrammarManifestEntry,
  type LanguageImplementation,
  sha256,
} from "../../parser/index.ts";
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

const grammarImplementation: LanguageImplementation = {
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
  const seen = new Set<DynamicLanguageId>();
  const entries: DynamicGrammarManifestEntry[] = [...assets]
    .sort((left, right) => left.languageId.localeCompare(right.languageId))
    .map((asset) => {
      if (seen.has(asset.languageId)) {
        throw new TypeError(`Duplicate dynamic grammar: ${asset.languageId}`);
      }
      seen.add(asset.languageId);
      if (!/^[a-f0-9]{64}$/.test(asset.sha256)) {
        throw new TypeError(`Invalid grammar SHA-256: ${asset.languageId}`);
      }
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
          dynamicAsset: {
            expandoChar: asset.expandoChar ?? null,
            languageSymbol: asset.languageSymbol ?? null,
            libraryPath: asset.libraryPath,
            metaVarChar: asset.metaVarChar ?? null,
            sha256: asset.sha256,
          },
          extensions: [...extensions[asset.languageId]],
          grammarVersion: asset.grammarVersion,
          languageId: asset.languageId,
        }),
      );
      return {
        descriptor: {
          astGrepLanguage: asset.astGrepLanguage,
          dynamicAsset,
          extensions: extensions[asset.languageId],
          grammarFingerprint,
          grammarVersion: asset.grammarVersion,
          languageId: asset.languageId,
        },
        implementation: { ...grammarImplementation },
      };
    });
  return {
    entries,
    fingerprint: sha256(JSON.stringify(entries)),
    schemaVersion: "ast-mcp.dynamic-grammars.v1",
  };
}

export const dynamicLanguageGroupManifest: DynamicLanguageGroupManifest = {
  adapters: dynamicLanguageAdapters,
  createGrammarManifest: createDynamicGrammarManifest,
  groupId: "dynamic",
  implementationFingerprint: dynamicExtractorFingerprint,
  schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
};

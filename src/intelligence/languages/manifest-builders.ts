import type {
  DynamicGrammarManifest,
  DynamicGrammarManifestEntry,
  LanguageImplementation,
} from "../parser/index.ts";
import { sha256 } from "../parser/index.ts";
import { deepFreeze } from "./immutable.ts";

export function createExtractionImplementation(): LanguageImplementation {
  return {
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
}

export interface GrammarAssetConfig<L extends string> {
  astGrepLanguage: string;
  expandoChar?: string;
  grammarVersion: string;
  languageId: L;
  languageSymbol?: string;
  libraryPath: string;
  metaVarChar?: string;
  sha256: string;
}

interface GrammarManifestOptions<
  L extends string,
  A extends GrammarAssetConfig<L>,
> {
  assets: readonly A[];
  cloneDescriptorExtensions?: boolean;
  duplicateLabel: string;
  extensions: Readonly<Record<L, readonly string[]>>;
  freeze?: boolean;
  implementation: LanguageImplementation;
  missingLabel?: string;
  normalizedFingerprintAsset?: boolean;
  requiredLanguageIds?: readonly L[];
}

export function buildGrammarManifest<
  L extends string,
  A extends GrammarAssetConfig<L>,
>(options: GrammarManifestOptions<L, A>): DynamicGrammarManifest {
  const byLanguage = new Map<L, A>();
  let orderedAssets: A[];
  if (options.requiredLanguageIds) {
    for (const asset of options.assets) {
      if (byLanguage.has(asset.languageId))
        throw new TypeError(
          `Duplicate ${options.duplicateLabel}: ${asset.languageId}`,
        );
      byLanguage.set(asset.languageId, asset);
    }
    const missing = options.requiredLanguageIds.filter(
      (languageId) => !byLanguage.has(languageId),
    );
    if (missing.length)
      throw new TypeError(
        `Missing ${options.missingLabel ?? options.duplicateLabel}s: ${missing.join(", ")}`,
      );
    orderedAssets = [...byLanguage.values()].sort((left, right) =>
      left.languageId.localeCompare(right.languageId),
    );
  } else {
    orderedAssets = [...options.assets].sort((left, right) =>
      left.languageId.localeCompare(right.languageId),
    );
  }

  const entries: DynamicGrammarManifestEntry[] = orderedAssets.map((asset) => {
    if (!options.requiredLanguageIds) {
      if (byLanguage.has(asset.languageId))
        throw new TypeError(
          `Duplicate ${options.duplicateLabel}: ${asset.languageId}`,
        );
      byLanguage.set(asset.languageId, asset);
    }
    if (!/^[a-f0-9]{64}$/.test(asset.sha256))
      throw new TypeError(`Invalid grammar SHA-256: ${asset.languageId}`);
    const dynamicAsset = {
      ...(asset.expandoChar ? { expandoChar: asset.expandoChar } : {}),
      ...(asset.languageSymbol ? { languageSymbol: asset.languageSymbol } : {}),
      libraryPath: asset.libraryPath,
      ...(asset.metaVarChar ? { metaVarChar: asset.metaVarChar } : {}),
      sha256: asset.sha256,
    };
    const fingerprintAsset = options.normalizedFingerprintAsset
      ? {
          expandoChar: asset.expandoChar ?? null,
          languageSymbol: asset.languageSymbol ?? null,
          libraryPath: asset.libraryPath,
          metaVarChar: asset.metaVarChar ?? null,
          sha256: asset.sha256,
        }
      : dynamicAsset;
    return {
      descriptor: {
        astGrepLanguage: asset.astGrepLanguage,
        dynamicAsset,
        extensions: options.cloneDescriptorExtensions
          ? [...options.extensions[asset.languageId]]
          : options.extensions[asset.languageId],
        grammarFingerprint: sha256(
          JSON.stringify({
            astGrepLanguage: asset.astGrepLanguage,
            dynamicAsset: fingerprintAsset,
            extensions: [...options.extensions[asset.languageId]],
            grammarVersion: asset.grammarVersion,
            languageId: asset.languageId,
          }),
        ),
        grammarVersion: asset.grammarVersion,
        languageId: asset.languageId,
      },
      implementation: { ...options.implementation },
    };
  });
  const manifest: DynamicGrammarManifest = {
    entries,
    fingerprint: sha256(JSON.stringify(entries)),
    schemaVersion: "ast-mcp.dynamic-grammars.v1",
  };
  return options.freeze ? deepFreeze(manifest) : manifest;
}

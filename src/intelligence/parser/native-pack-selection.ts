import type { ResolvedConfig } from "../../config";
import type { NativePackAsset } from "../../language-packs/index.ts";
import { sha256 } from "./coordinates.ts";

export interface NativeGrammarSet {
  assets: Readonly<Record<string, NativePackAsset>>;
  identity: string;
}

export function isNativePackLanguage(language: string): boolean {
  return language === "python" || language === "go" || language === "sql";
}

export async function nativeGrammarSet(
  languages: Iterable<string>,
  config: ResolvedConfig,
  checkoutRoot: string,
  options: { allowDownload?: boolean; signal?: AbortSignal } = {},
): Promise<NativeGrammarSet | undefined> {
  const selected = [...new Set(languages)].filter(isNativePackLanguage).sort();
  if (!selected.length || !config.languagePacks) return undefined;

  const { resolveNativeLanguagePack } =
    await import("../../language-packs/index.ts");
  const results = await Promise.all(
    selected.map(async (language) => {
      options.signal?.throwIfAborted();
      const asset = await resolveNativeLanguagePack(config, language, {
        ...options,
        checkoutRoot,
      });
      return [language, asset] as const;
    }),
  );
  options.signal?.throwIfAborted();
  const assets = Object.fromEntries(
    results.flatMap(([language, asset]) => (asset ? [[language, asset]] : [])),
  );
  if (!Object.keys(assets).length) return undefined;
  return {
    assets,
    identity: sha256(JSON.stringify([checkoutRoot, config.generation, assets])),
  };
}

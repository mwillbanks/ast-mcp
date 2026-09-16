import bash from "@ast-grep/lang-bash";
import c from "@ast-grep/lang-c";
import cpp from "@ast-grep/lang-cpp";
import csharp from "@ast-grep/lang-csharp";
import dart from "@ast-grep/lang-dart";
import elixir from "@ast-grep/lang-elixir";
import go from "@ast-grep/lang-go";
import java from "@ast-grep/lang-java";
import kotlin from "@ast-grep/lang-kotlin";
import lua from "@ast-grep/lang-lua";
import markdown from "@ast-grep/lang-markdown";
import php from "@ast-grep/lang-php";
import python from "@ast-grep/lang-python";
import ruby from "@ast-grep/lang-ruby";
import rust from "@ast-grep/lang-rust";
import scala from "@ast-grep/lang-scala";
import sql from "@ast-grep/lang-sql";
import swift from "@ast-grep/lang-swift";
import toml from "@ast-grep/lang-toml";
import yaml from "@ast-grep/lang-yaml";
import { Lang } from "@ast-grep/napi";
import type { ParserLanguageId } from "./types.ts";

export interface GrammarRegistration {
  expandoChar?: string;
  extensions: string[];
  languageSymbol?: string;
  libraryPath: string;
  metaVarChar?: string;
}

export interface LanguageCatalogEntry {
  analysis: {
    symbolExtraction: boolean;
  };
  astGrepLanguage: Lang | string;
  extensions: readonly string[];
  grammarVersion: string;
  languageId: ParserLanguageId;
  registration: GrammarRegistration | null;
  structuralOperations: {
    match: boolean;
    parse: boolean;
    rewrite: boolean;
    structuralRead: boolean;
  };
}

const structuralOperations = Object.freeze({
  match: true,
  parse: true,
  rewrite: true,
  structuralRead: true,
});

function builtIn(
  languageId: ParserLanguageId,
  astGrepLanguage: Lang,
  extensions: readonly string[],
  symbolExtraction: boolean,
): LanguageCatalogEntry {
  return {
    analysis: { symbolExtraction },
    astGrepLanguage,
    extensions,
    grammarVersion: `@ast-grep/napi@0.45.3:${astGrepLanguage}`,
    languageId,
    registration: null,
    structuralOperations,
  };
}

function packaged(
  languageId: ParserLanguageId,
  version: string,
  registration: GrammarRegistration,
  symbolExtraction: boolean,
): LanguageCatalogEntry {
  return {
    analysis: { symbolExtraction },
    astGrepLanguage: languageId,
    extensions: registration.extensions.map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    ),
    grammarVersion: `@ast-grep/lang-${languageId}@${version}`,
    languageId,
    registration,
    structuralOperations,
  };
}

export const LANGUAGE_CAPABILITY_CATALOG: readonly LanguageCatalogEntry[] =
  Object.freeze([
    builtIn("javascript", Lang.JavaScript, [".js", ".mjs", ".cjs"], true),
    builtIn("jsx", Lang.JavaScript, [".jsx"], true),
    builtIn("typescript", Lang.TypeScript, [".ts", ".mts", ".cts"], true),
    builtIn("tsx", Lang.Tsx, [".tsx"], true),
    builtIn("css", Lang.Css, [".css"], false),
    builtIn("html", Lang.Html, [".html", ".htm"], false),
    packaged("c", "0.0.6", c, true),
    packaged("cpp", "0.0.6", cpp, true),
    packaged("csharp", "0.0.6", csharp, true),
    packaged("go", "0.0.6", go, true),
    packaged("python", "0.0.6", python, true),
    packaged("yaml", "0.0.6", yaml, false),
    packaged("markdown", "0.0.6", markdown, false),
    packaged("dart", "0.0.7", dart, true),
    packaged("elixir", "0.0.7", elixir, true),
    packaged("java", "0.0.7", java, true),
    packaged("kotlin", "0.0.7", kotlin, true),
    packaged("lua", "0.0.7", lua, true),
    packaged("php", "0.0.7", php, true),
    packaged("ruby", "0.0.7", ruby, true),
    packaged("rust", "0.0.7", rust, true),
    packaged("scala", "0.0.7", scala, true),
    packaged("bash", "0.0.8", bash, true),
    packaged("sql", "0.0.8", sql, true),
    packaged("swift", "0.0.8", swift, true),
    packaged("toml", "0.0.9", toml, false),
  ]);

if (
  new Set(LANGUAGE_CAPABILITY_CATALOG.map((entry) => entry.languageId)).size !==
  LANGUAGE_CAPABILITY_CATALOG.length
) {
  throw new TypeError(
    "Language capability catalog contains duplicate languages",
  );
}

export const PINNED_GRAMMAR_REGISTRATIONS: Readonly<
  Record<string, GrammarRegistration>
> = Object.freeze(
  Object.fromEntries(
    LANGUAGE_CAPABILITY_CATALOG.flatMap((entry) =>
      entry.registration
        ? [[String(entry.astGrepLanguage), entry.registration] as const]
        : [],
    ),
  ),
);

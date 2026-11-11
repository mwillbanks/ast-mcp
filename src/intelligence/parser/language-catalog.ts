import { createRequire } from "node:module";

import { Lang } from "@ast-grep/napi";
import { version as napiVersion } from "@ast-grep/napi/package.json";

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
  packaged: boolean;
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
    grammarVersion: `@ast-grep/napi@${napiVersion}:${astGrepLanguage}`,
    languageId,
    packaged: false,
    structuralOperations,
  };
}

function packaged(
  languageId: ParserLanguageId,
  version: string,
  extensions: readonly string[],
  symbolExtraction: boolean,
): LanguageCatalogEntry {
  return {
    analysis: { symbolExtraction },
    astGrepLanguage: languageId,
    extensions,
    grammarVersion: `@ast-grep/lang-${languageId}@${version}`,
    languageId,
    packaged: true,
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
    packaged("c", "0.0.6", [".c", ".h"], true),
    packaged(
      "cpp",
      "0.0.6",
      [".cc", ".hpp", ".cpp", ".hh", ".cxx", ".cu", ".ino"],
      true,
    ),
    packaged("csharp", "0.0.6", [".cs"], true),
    packaged("go", "0.0.6", [".go"], true),
    packaged("python", "0.0.6", [".py"], true),
    packaged("yaml", "0.0.6", [".yaml", ".yml"], false),
    packaged("markdown", "0.0.6", [".md"], false),
    packaged("dart", "0.0.7", [".dart"], true),
    packaged("elixir", "0.0.7", [".ex", ".exs"], true),
    packaged("java", "0.0.7", [".java"], true),
    packaged("kotlin", "0.0.7", [".kt", ".ktm", ".kts"], true),
    packaged("lua", "0.0.7", [".lua"], true),
    packaged("php", "0.0.7", [".php"], true),
    packaged("ruby", "0.0.7", [".rb", ".rbw", ".gemspec"], true),
    packaged("rust", "0.0.7", [".rs"], true),
    packaged("scala", "0.0.7", [".scala", ".sc", ".sbt"], true),
    packaged(
      "bash",
      "0.0.8",
      [
        ".bash",
        ".bats",
        ".cgi",
        ".command",
        ".env",
        ".fcgi",
        ".ksh",
        ".sh",
        ".tmux",
        ".tool",
        ".zsh",
      ],
      true,
    ),
    packaged("sql", "0.0.8", [".sql"], true),
    packaged("swift", "0.0.8", [".swift"], true),
    packaged("toml", "0.0.9", [".toml"], false),
  ]);

if (
  new Set(LANGUAGE_CAPABILITY_CATALOG.map((entry) => entry.languageId)).size !==
  LANGUAGE_CAPABILITY_CATALOG.length
) {
  throw new TypeError(
    "Language capability catalog contains duplicate languages",
  );
}

const requireGrammar = createRequire(import.meta.url);

export function pinnedGrammarRegistration(
  language: ParserLanguageId,
): GrammarRegistration {
  return requireGrammar(`@ast-grep/lang-${language}`) as GrammarRegistration;
}

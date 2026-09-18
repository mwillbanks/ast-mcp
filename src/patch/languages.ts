import path from "node:path";

import { defaultLanguageRegistry } from "../intelligence/parser/registry.ts";

const structuredLanguages: Readonly<Record<string, string>> = {
  ".json": "json",
  ".jsonc": "jsonc",
};
export function languageForExtension(extension: string): string | undefined {
  const normalized = extension.toLowerCase();
  const registered = defaultLanguageRegistry
    .list()
    .find((grammar) => grammar.extensions.includes(normalized));
  return registered?.languageId ?? structuredLanguages[normalized];
}

export function detectAstLanguage(filePath: string): string | undefined {
  return languageForExtension(path.extname(filePath));
}

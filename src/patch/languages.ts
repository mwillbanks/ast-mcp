import path from "node:path";
import { defaultLanguageRegistry } from "../intelligence/parser/registry.ts";

const languages: Record<string, string> = {
  ".cc": "cpp",
  ".cjs": "javascript",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".cts": "typescript",
  ".cxx": "cpp",
  ".ddl": "sql",
  ".dml": "sql",
  ".go": "go",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".htm": "html",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsonc": "json",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".markdown": "markdown",
  ".md": "markdown",
  ".mdown": "markdown",
  ".mdx": "markdown",
  ".mjs": "javascript",
  ".mts": "typescript",
  ".php": "php",
  ".py": "python",
  ".pyi": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".scala": "scala",
  ".sql": "sql",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".yaml": "yaml",
  ".yml": "yaml",
};
export function languageForExtension(extension: string): string | undefined {
  const normalized = extension.toLowerCase();
  const registered = defaultLanguageRegistry
    .list()
    .find((grammar) => grammar.extensions.includes(normalized));
  return registered?.languageId ?? languages[normalized];
}

export function detectAstLanguage(filePath: string): string | undefined {
  return languageForExtension(path.extname(filePath));
}

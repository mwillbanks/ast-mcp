import path from "node:path";

const languages: Record<string, string> = {
  ".cc": "cpp",
  ".cjs": "javascript",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".cxx": "cpp",
  ".ddl": "sql",
  ".dml": "sql",
  ".go": "go",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".markdown": "markdown",
  ".md": "markdown",
  ".mdown": "markdown",
  ".mdx": "markdown",
  ".mjs": "javascript",
  ".php": "php",
  ".py": "python",
  ".pyi": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".scala": "scala",
  ".sql": "sql",
  ".ts": "typescript",
  ".tsx": "tsx",
};
export function detectAstLanguage(filePath: string): string | undefined {
  return languages[path.extname(filePath).toLowerCase()];
}

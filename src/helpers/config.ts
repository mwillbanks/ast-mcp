import path from "node:path";

type ConfigLayer = {
  dependencies?: {
    ast_bro_binary?: string;
    dprint_binary?: string;
  };
  formatting?: {
    dprint_config?: string;
    formatters?: Array<{
      command: string;
      extensions?: string[];
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  workspace?: { roots?: string[] };
  [key: string]: unknown;
};

function resolvedPath(value: string, base: string): string {
  return path.resolve(base, value);
}

function resolvedCommand(value: string, base: string): string {
  return path.isAbsolute(value) ||
    (!value.includes("/") && !value.includes("\\"))
    ? value
    : path.resolve(base, value);
}

function normalizeDependencies(
  dependencies: ConfigLayer["dependencies"],
  base: string,
): ConfigLayer["dependencies"] {
  if (!dependencies) return undefined;
  return {
    ast_bro_binary: dependencies.ast_bro_binary
      ? resolvedCommand(dependencies.ast_bro_binary, base)
      : undefined,
    dprint_binary: dependencies.dprint_binary
      ? resolvedCommand(dependencies.dprint_binary, base)
      : undefined,
  };
}

function normalizeFormatting(
  formatting: ConfigLayer["formatting"],
  base: string,
): ConfigLayer["formatting"] {
  if (!formatting) return undefined;
  return {
    ...formatting,
    dprint_config: formatting.dprint_config
      ? resolvedPath(formatting.dprint_config, base)
      : undefined,
    formatters: formatting.formatters?.map((formatter) => ({
      ...formatter,
      command: resolvedCommand(formatter.command, base),
      extensions: formatter.extensions?.map((extension) =>
        extension.toLowerCase(),
      ),
    })),
  };
}

export function normalizeConfigLayer<T extends ConfigLayer>(
  value: T,
  filePath: string,
): T {
  const base = path.dirname(filePath);
  return {
    ...value,
    dependencies: normalizeDependencies(value.dependencies, base),
    formatting: normalizeFormatting(value.formatting, base),
    workspace: value.workspace?.roots
      ? { roots: value.workspace.roots.map((item) => resolvedPath(item, base)) }
      : value.workspace,
  } as T;
}

const pathKeys = new Set([
  "destination",
  "file",
  "filePath",
  "filePaths",
  "path",
  "paths",
  "root",
]);
const keyedBatchExclusions = new Set([
  "files",
  "filePaths",
  "path",
  "paths",
  "root",
]);

export function collectRequestPaths(value: unknown): string[] {
  const paths: string[] = [];
  visitRequestPaths(value, paths);
  return paths;
}

function visitArrayPaths(values: unknown[], paths: string[], key?: string) {
  for (const value of values) visitRequestPaths(value, paths, key);
}

function visitObjectPaths(
  value: Record<string, unknown>,
  paths: string[],
  key?: string,
) {
  for (const [childKey, child] of Object.entries(value)) {
    if (isKeyedBatchPath(key, childKey, child)) paths.push(childKey);
    visitRequestPaths(child, paths, childKey);
  }
}

function visitRequestPaths(
  value: unknown,
  paths: string[],
  key?: string,
): void {
  if (typeof value === "string") {
    if (key && pathKeys.has(key)) paths.push(value);
    return;
  }
  if (Array.isArray(value)) {
    visitArrayPaths(value, paths, key);
    return;
  }
  if (value && typeof value === "object")
    visitObjectPaths(value as Record<string, unknown>, paths, key);
}

function isKeyedBatchPath(
  parentKey: string | undefined,
  childKey: string,
  child: unknown,
): boolean {
  return (
    parentKey === undefined &&
    Boolean(child) &&
    typeof child === "object" &&
    !Array.isArray(child) &&
    !keyedBatchExclusions.has(childKey)
  );
}

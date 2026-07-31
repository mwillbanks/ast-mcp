import { AsyncLocalStorage } from "node:async_hooks";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createFormatterSchema,
  createHookSchema,
  dependenciesSchema,
  httpSchema,
  workspaceSchema,
} from "./config-schema-common";
import {
  fileV2Schema,
  type PathPolicy,
  type PathRuleV2,
} from "./config-v2-schema";
import { collectRequestPaths, normalizeConfigLayer } from "./helpers/config";
import { canonicalizePath } from "./runtime/path-utils";

const schemaVersion = 1 as const;
const hookSchema = createHookSchema(64);

const formatterSchema = createFormatterSchema({});
const fileV1Schema = z
  .object({
    dependencies: dependenciesSchema.optional(),
    formatting: z
      .object({
        dprint_config: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        formatters: z.array(formatterSchema).max(64).optional(),
      })
      .strict()
      .optional(),
    http: httpSchema.optional(),
    safety: z
      .object({
        allow_any_path: z.boolean().optional(),
        allow_external_roots: z.boolean().optional(),
        allow_temp_directory: z.boolean().optional(),
        follow_symlinks: z.boolean().optional(),
        hook: hookSchema.optional(),
        require_hash: z.boolean().optional(),
      })
      .strict()
      .optional(),
    version: z.literal(schemaVersion).optional(),
    workspace: workspaceSchema.optional(),
  })
  .strict();

type AstMcpFileConfig =
  | z.infer<typeof fileV1Schema>
  | z.infer<typeof fileV2Schema>;

export interface ResolvedConfig {
  dependencies: { astBroBinary?: string; dprintBinary?: string };
  files: {
    patch: {
      aiderMatchers: Array<
        "exact" | "whitespace" | "relative-indentation" | "diff-match-patch"
      >;
      strategies: Array<"ast" | "aider_block">;
    };
    read: { modes: Array<"ast" | "text"> };
  };
  formatting: {
    dprintConfig: string;
    enabled: boolean;
    fallback: "preserve" | "dprint" | "reject";
    formatters: Array<{
      args: string[];
      command: string;
      enabled?: boolean;
      extensions: string[];
      globs: string[];
      id: string;
      mode: "stdout" | "in_place";
      timeoutMs: number;
    }>;
  };
  generation: number;
  http: {
    host: string;
    port: number;
    sessionTimeoutMs: number;
    sessionSweepIntervalMs: number;
  };
  paths: Array<{
    excludes: string[];
    followSymlinks: boolean;
    id: string;
    includes: string[];
    path: string;
    policies: { delete: PathPolicy; read: PathPolicy; write: PathPolicy };
    source: "global" | "project";
  }>;
  projectRoot: string;
  provenance: Record<string, "default" | "global" | "project" | "environment">;
  safety: {
    allowAnyPath: boolean;
    allowExternalRoots: boolean;
    allowTempDirectory: boolean;
    followSymlinks: boolean;
    hook: { allowTools: string[]; blockTools: string[]; enabled: boolean };
    requireHash: boolean;
  };
  sources: { project?: string; global?: string; environment: string[] };
  trustedRoots: string[];
  version: 1 | 2;
  workspace: { roots: string[] };
}

export interface ResolveConfigOptions {
  clientRoots?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  requestPaths?: string[];
}

interface LoadedLayer {
  fingerprint: string;
  path: string;
  value?: AstMcpFileConfig;
}

interface InternalConfig {
  dependencies?: { ast_bro_binary?: string; dprint_binary?: string };
  files?: {
    patch?: {
      aider_matchers?: Array<
        "exact" | "whitespace" | "relative-indentation" | "diff-match-patch"
      >;
      strategies?: Array<"ast" | "aider_block">;
    };
    read?: { modes?: Array<"ast" | "text"> };
  };
  formatting?: {
    dprint_config?: string;
    enabled?: boolean;
    fallback?: "preserve" | "dprint" | "reject";
    formatters?: Array<{
      args?: string[];
      command: string;
      enabled?: boolean;
      extensions?: string[];
      globs?: string[];
      id?: string;
      mode?: "stdout" | "in_place";
      timeout_ms?: number;
    }>;
  };
  http?: {
    host?: string;
    port?: number;
    session_timeout_ms?: number;
    session_sweep_interval_ms?: number;
  };
  paths?: Array<{
    excludes?: string[];
    follow_symlinks?: boolean;
    id: string;
    includes?: string[];
    path: string;
    policies: { delete?: PathPolicy; read: PathPolicy; write: PathPolicy };
  }>;
  safety?: {
    allow_any_path?: boolean;
    allow_external_roots?: boolean;
    allow_temp_directory?: boolean;
    follow_symlinks?: boolean;
    hook?: {
      allow_tools?: string[];
      block_tools?: string[];
      enabled?: boolean;
    };
    require_hash?: boolean;
  };
  version?: 1 | 2;
  workspace?: { roots?: string[] };
}

class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

const layerCache = new Map<
  string,
  { fingerprint: string; promise: Promise<LoadedLayer> }
>();
const resolvedCache = new Map<
  string,
  { fingerprint: string; value: ResolvedConfig }
>();
const dprintConfigCache = new Map<
  string,
  { fingerprint: string; promise: Promise<string> }
>();

function packageDprintConfig() {
  return path.resolve(import.meta.dir, "../dprint.json");
}
async function validateDprintConfig(filePath: string): Promise<string> {
  const metadata = await stat(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!metadata)
    throw new ConfigurationError(
      `formatting.dprint_config does not exist: ${filePath}`,
    );
  if (!metadata.isFile())
    throw new ConfigurationError(
      `formatting.dprint_config is not a file: ${filePath}`,
    );
  const fingerprint = `${metadata.mtimeMs}:${metadata.size}`;
  const cached = dprintConfigCache.get(filePath);
  if (cached?.fingerprint === fingerprint) return cached.promise;
  const promise = Bun.file(filePath)
    .text()
    .then((source) => {
      let parsed: unknown;
      try {
        parsed = Bun.JSONC.parse(source);
      } catch (error) {
        throw new ConfigurationError(
          `Invalid dprint configuration at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new ConfigurationError(
          `Invalid dprint configuration at ${filePath}: expected an object`,
        );
      return fingerprint;
    });
  dprintConfigCache.set(filePath, { fingerprint, promise });
  return promise;
}

function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveFileUri(value: string) {
  if (!value.startsWith("file:")) return value;
  try {
    return fileURLToPath(value);
  } catch (error) {
    throw new ConfigurationError(
      `Invalid MCP workspace root "${value}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function existingDirectory(value: string) {
  const absolute = path.resolve(value);
  const metadata = await stat(absolute).catch(() => undefined);
  if (!metadata?.isDirectory())
    throw new ConfigurationError(
      `Configuration project root is not a directory: ${absolute}`,
    );
  return absolute;
}

export function globalConfigPath(options: ResolveConfigOptions = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  if (platform === "win32")
    return path.join(
      env.APPDATA ?? path.join(home, "AppData", "Roaming"),
      "ast-mcp",
      "ast-mcp.toml",
    );
  return path.join(
    env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
    "ast-mcp",
    "ast-mcp.toml",
  );
}

async function projectConfigPath(projectRoot: string) {
  let current = projectRoot;
  while (true) {
    const candidate = path.join(current, "ast-mcp.toml");
    if (
      await stat(candidate)
        .then(() => true)
        .catch(() => false)
    )
      return candidate;
    if (
      await stat(path.join(current, ".git"))
        .then(() => true)
        .catch(() => false)
    )
      return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function diagnostic(error: z.ZodError) {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function _pathValue(value: string, base: string) {
  if (path.isAbsolute(value) || (!value.includes("/") && !value.includes("\\")))
    return value;
  return path.resolve(base, value);
}

async function canonicalConfigurationPath(value: string): Promise<string> {
  return canonicalizePath(value);
}

async function normalizeLayer(
  value: AstMcpFileConfig,
  filePath: string,
): Promise<AstMcpFileConfig> {
  const normalized = normalizeConfigLayer(value, filePath);
  if (normalized.version !== 2 || !normalized.paths) return normalized;
  return {
    ...normalized,
    paths: await Promise.all(
      normalized.paths.map(async (rule) => ({
        ...rule,
        path: await canonicalConfigurationPath(rule.path),
      })),
    ),
  };
}

async function parseLayerValue(filePath: string): Promise<AstMcpFileConfig> {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(await Bun.file(filePath).text());
  } catch (error) {
    throw new ConfigurationError(
      `${filePath}: invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const version =
    parsed &&
    typeof parsed === "object" &&
    "version" in parsed &&
    parsed.version === 2
      ? 2
      : 1;
  const result = (version === 2 ? fileV2Schema : fileV1Schema).safeParse(
    parsed,
  );
  if (!result.success)
    throw new ConfigurationError(
      `${filePath}: invalid configuration: ${diagnostic(result.error)}`,
    );
  return { ...result.data, version } as AstMcpFileConfig;
}

async function loadLayer(filePath: string): Promise<LoadedLayer> {
  const metadata = await stat(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const fingerprint = metadata
    ? `${metadata.mtimeMs}:${metadata.size}`
    : "missing";
  const cached = layerCache.get(filePath);
  if (cached?.fingerprint === fingerprint) return cached.promise;

  const promise = (async () => {
    if (!metadata) return { fingerprint, path: filePath };
    return {
      fingerprint,
      path: await canonicalConfigurationPath(filePath),
      value: await normalizeLayer(await parseLayerValue(filePath), filePath),
    };
  })();
  layerCache.set(filePath, { fingerprint, promise });
  return promise;
}

function integerEnvironment(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new ConfigurationError(
      `Environment variable ${name} must be an integer from ${minimum} to ${maximum}; received "${raw}"`,
    );
  return value;
}

function booleanEnvironment(env: NodeJS.ProcessEnv, name: string) {
  const raw = env[name];
  if (raw === undefined) return undefined;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new ConfigurationError(
    `Environment variable ${name} must be 1, 0, true, or false; received "${raw}"`,
  );
}

class EnvironmentUsage {
  readonly names: string[] = [];

  use<T>(name: string, value: T | undefined) {
    if (value !== undefined) this.names.push(name);
    return value;
  }
}

function environmentRoots(
  env: NodeJS.ProcessEnv,
  cwd: string,
  usage: EnvironmentUsage,
) {
  const roots = env.AST_MCP_ROOTS?.split(path.delimiter)
    .filter(Boolean)
    .map((item) => path.resolve(cwd, item));
  if (env.AST_MCP_ROOTS !== undefined && !roots?.length)
    throw new ConfigurationError(
      "Environment variable AST_MCP_ROOTS must contain at least one path",
    );
  return usage.use("AST_MCP_ROOTS", roots);
}

function environmentDependencies(
  env: NodeJS.ProcessEnv,
  usage: EnvironmentUsage,
) {
  const astBroBinary = usage.use("AST_BRO_BINARY", env.AST_BRO_BINARY);
  const dprintBinary = usage.use("DPRINT_BINARY", env.DPRINT_BINARY);
  return astBroBinary || dprintBinary
    ? { ast_bro_binary: astBroBinary, dprint_binary: dprintBinary }
    : undefined;
}

function environmentFormatting(
  env: NodeJS.ProcessEnv,
  cwd: string,
  usage: EnvironmentUsage,
) {
  const configured = env.AST_MCP_DPRINT_CONFIG
    ? path.resolve(cwd, env.AST_MCP_DPRINT_CONFIG)
    : undefined;
  const dprintConfig = usage.use("AST_MCP_DPRINT_CONFIG", configured);
  return dprintConfig ? { dprint_config: dprintConfig } : undefined;
}

function environmentHttp(env: NodeJS.ProcessEnv, usage: EnvironmentUsage) {
  const host = usage.use("AST_MCP_HTTP_HOST", env.AST_MCP_HTTP_HOST);
  const port = usage.use("PORT", integerEnvironment(env, "PORT", 1, 65_535));
  const sessionTimeout = usage.use(
    "AST_MCP_SESSION_TIMEOUT_MS",
    integerEnvironment(env, "AST_MCP_SESSION_TIMEOUT_MS", 1),
  );
  const sessionSweep = usage.use(
    "AST_MCP_SESSION_SWEEP_INTERVAL_MS",
    integerEnvironment(env, "AST_MCP_SESSION_SWEEP_INTERVAL_MS", 1),
  );
  if (!host && !port && !sessionTimeout && !sessionSweep) return undefined;
  return {
    host,
    port,
    session_sweep_interval_ms: sessionSweep,
    session_timeout_ms: sessionTimeout,
  };
}

function environmentSafety(env: NodeJS.ProcessEnv, usage: EnvironmentUsage) {
  const allowAnyPath = usage.use(
    "AST_MCP_ALLOW_ANY_PATH",
    booleanEnvironment(env, "AST_MCP_ALLOW_ANY_PATH"),
  );
  const allowExternalRoots = usage.use(
    "AST_MCP_ALLOW_EXTERNAL_ROOTS",
    booleanEnvironment(env, "AST_MCP_ALLOW_EXTERNAL_ROOTS"),
  );
  const allowTempDirectory = usage.use(
    "AST_MCP_ALLOW_TEMP_DIRECTORY",
    booleanEnvironment(env, "AST_MCP_ALLOW_TEMP_DIRECTORY"),
  );
  if (
    allowAnyPath === undefined &&
    allowExternalRoots === undefined &&
    allowTempDirectory === undefined
  )
    return undefined;
  return {
    allow_any_path: allowAnyPath,
    allow_external_roots: allowExternalRoots,
    allow_temp_directory: allowTempDirectory,
  };
}

function environmentLayer(
  env: NodeJS.ProcessEnv,
  cwd: string,
): { names: string[]; value: InternalConfig } {
  const usage = new EnvironmentUsage();
  const roots = environmentRoots(env, cwd, usage);
  const safety = environmentSafety(env, usage);
  const formatting = environmentFormatting(env, cwd, usage);
  const dependencies = environmentDependencies(env, usage);
  const http = environmentHttp(env, usage);
  return {
    names: usage.names,
    value: {
      dependencies,
      formatting,
      http,
      safety,
      workspace: roots ? { roots } : undefined,
    },
  };
}

const leaves = [
  "version",
  "workspace.roots",
  "paths",
  "safety.allow_any_path",
  "safety.allow_external_roots",
  "safety.allow_temp_directory",
  "safety.follow_symlinks",
  "safety.hook.allow_tools",
  "safety.hook.block_tools",
  "safety.hook.enabled",
  "safety.require_hash",
  "files.read.modes",
  "files.patch.strategies",
  "files.patch.aider_matchers",
  "formatting.dprint_config",
  "formatting.enabled",
  "formatting.fallback",
  "formatting.formatters",
  "dependencies.ast_bro_binary",
  "dependencies.dprint_binary",
  "http.host",
  "http.port",
  "http.session_timeout_ms",
  "http.session_sweep_interval_ms",
] as const;

function leaf(value: InternalConfig, dotted: (typeof leaves)[number]) {
  return dotted
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

const mergeSections = [
  "workspace",
  "safety",
  "files",
  "formatting",
  "dependencies",
  "http",
] as const;

type MergeSection = (typeof mergeSections)[number];

function definedProperties(value: object): object {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function mergeSafetyHook(
  result: InternalConfig,
  incoming: InternalConfig["safety"],
  previousHook: NonNullable<InternalConfig["safety"]>["hook"],
): void {
  if (!incoming?.hook) return;
  result.safety = {
    ...result.safety,
    hook: {
      ...previousHook,
      ...definedProperties(incoming.hook),
    },
  };
}

function mergeFileMethods(
  result: InternalConfig,
  incoming: InternalConfig["files"],
  previous: InternalConfig["files"],
): void {
  if (!incoming) return;
  result.files = {
    patch: { ...previous?.patch, ...incoming.patch },
    read: { ...previous?.read, ...incoming.read },
  };
}

function mergeSection(
  result: InternalConfig,
  layer: InternalConfig,
  section: MergeSection,
): void {
  const incoming = layer[section];
  if (!incoming) return;
  const previousHook = result.safety?.hook;
  const previousFiles = result.files;
  result[section] = {
    ...(result[section] as object | undefined),
    ...definedProperties(incoming),
  } as never;
  if (section === "safety")
    mergeSafetyHook(result, incoming as InternalConfig["safety"], previousHook);
  if (section === "files")
    mergeFileMethods(
      result,
      incoming as InternalConfig["files"],
      previousFiles,
    );
}

function merge(...layers: InternalConfig[]): InternalConfig {
  const result: InternalConfig = {};
  for (const layer of layers) {
    if (layer.version !== undefined) result.version = layer.version;
    for (const section of mergeSections) mergeSection(result, layer, section);
  }
  return result;
}

async function projectRoots(options: ResolveConfigOptions) {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const withCanonical = async (roots: string[]) => [
    ...new Set([
      ...roots,
      ...(await Promise.all(roots.map(canonicalConfigurationPath))),
    ]),
  ];
  const clientRoots = await Promise.all(
    (options.clientRoots ?? []).map((item) =>
      existingDirectory(resolveFileUri(item)),
    ),
  );
  if (clientRoots.length)
    return {
      candidates: clientRoots,
      trustedRoots: await withCanonical(clientRoots),
    };

  if (env.AST_MCP_PROJECT_ROOT) {
    const selected = path.resolve(cwd, env.AST_MCP_PROJECT_ROOT);
    return {
      candidates: [selected],
      trustedRoots: await withCanonical([selected]),
    };
  }

  const legacy = env.AST_MCP_ROOTS?.split(path.delimiter).filter(Boolean);
  if (legacy?.length) {
    const candidates = legacy.map((item) => path.resolve(cwd, item));
    return {
      candidates,
      trustedRoots: await withCanonical([cwd]),
    };
  }

  return {
    candidates: [cwd],
    trustedRoots: await withCanonical([cwd]),
  };
}

function matchedProjectRoots(
  candidates: string[],
  requestPaths: string[],
): string[] {
  const absolute = requestPaths
    .filter((item) => path.isAbsolute(item))
    .map((item) => path.resolve(item));
  const matched = candidates.filter((root) =>
    absolute.some((item) => within(root, item)),
  );
  return matched.length ? matched : [candidates[0] as string];
}

function defaultInternalConfig(candidates: string[]): InternalConfig {
  return {
    dependencies: {},
    formatting: {
      dprint_config: packageDprintConfig(),
      enabled: true,
      formatters: [],
    },
    http: {
      host: "127.0.0.1",
      port: 3768,
      session_sweep_interval_ms: 60 * 1000,
      session_timeout_ms: 30 * 60 * 1000,
    },
    safety: {
      hook: { allow_tools: [], block_tools: [], enabled: true },
      require_hash: true,
    },
    version: 1,
    workspace: { roots: candidates },
  };
}

type ConfigLayer = {
  name: "default" | "global" | "project" | "environment";
  value: InternalConfig;
};

function configProvenance(layers: ConfigLayer[]) {
  const provenance: ResolvedConfig["provenance"] = {};
  for (const dotted of leaves)
    for (const layer of layers)
      if (leaf(layer.value, dotted) !== undefined)
        provenance[dotted] = layer.name;
  return provenance;
}

function resolvedFormatting(
  value: InternalConfig,
  dprintConfig: string,
): ResolvedConfig["formatting"] {
  const version = value.version ?? 1;
  return {
    dprintConfig,
    enabled: value.formatting?.enabled ?? true,
    fallback:
      value.formatting?.fallback ?? (version === 2 ? "preserve" : "dprint"),
    formatters: (value.formatting?.formatters ?? []).map(
      (formatter, index) => ({
        args: formatter.args ?? [],
        command: formatter.command,
        enabled: formatter.enabled,
        extensions: formatter.extensions ?? [],
        globs: formatter.globs ?? [],
        id: formatter.id ?? `legacy-${index + 1}`,
        mode: formatter.mode ?? "stdout",
        timeoutMs: formatter.timeout_ms ?? 30_000,
      }),
    ),
  };
}

function resolvedFiles(value: InternalConfig): ResolvedConfig["files"] {
  return {
    patch: {
      aiderMatchers: value.files?.patch?.aider_matchers ?? [
        "exact",
        "whitespace",
        "relative-indentation",
        "diff-match-patch",
      ],
      strategies: value.files?.patch?.strategies ?? ["ast", "aider_block"],
    },
    read: { modes: value.files?.read?.modes ?? ["ast", "text"] },
  };
}

function resolvedHttp(value: InternalConfig): ResolvedConfig["http"] {
  return {
    host: value.http?.host ?? "127.0.0.1",
    port: value.http?.port ?? 3768,
    sessionSweepIntervalMs: value.http?.session_sweep_interval_ms ?? 60 * 1000,
    sessionTimeoutMs: value.http?.session_timeout_ms ?? 30 * 60 * 1000,
  };
}

function withDefault<T>(value: T | undefined, fallback: T) {
  return value === undefined ? fallback : value;
}

function resolvedHook(value: InternalConfig["safety"]) {
  return {
    allowTools: withDefault(value?.hook?.allow_tools, []),
    blockTools: withDefault(value?.hook?.block_tools, []),
    enabled: withDefault(value?.hook?.enabled, true),
  };
}

type ConfiguredPathRule = PathRuleV2;

function resolvedSafety(value: InternalConfig): ResolvedConfig["safety"] {
  const version = value.version ?? 1;
  return {
    allowAnyPath: withDefault(value.safety?.allow_any_path, false),
    allowExternalRoots: withDefault(value.safety?.allow_external_roots, false),
    allowTempDirectory: withDefault(
      value.safety?.allow_temp_directory,
      version === 1,
    ),
    followSymlinks: withDefault(value.safety?.follow_symlinks, false),
    hook: resolvedHook(value.safety),
    requireHash: withDefault(value.safety?.require_hash, true),
  };
}

function layerPathRules(
  layer: LoadedLayer,
  source: "global" | "project",
): Array<{ rule: ConfiguredPathRule; source: "global" | "project" }> {
  if (layer.value?.version !== 2) return [];
  return (layer.value.paths ?? []).map((rule) => ({ rule, source }));
}

function resolvedConfiguration(args: {
  candidates: string[];
  dprintConfig: string;
  environment: ReturnType<typeof environmentLayer>;
  global: LoadedLayer;
  project: LoadedLayer;
  projectRoot: string;
  provenance: ResolvedConfig["provenance"];
  trustedRoots: string[];
  value: InternalConfig;
}): ResolvedConfig {
  const {
    candidates,
    dprintConfig,
    environment,
    global,
    project,
    projectRoot,
    provenance,
    trustedRoots,
    value,
  } = args;
  const pathRules = [
    ...layerPathRules(global, "global"),
    ...layerPathRules(project, "project"),
  ];
  return {
    dependencies: {
      astBroBinary: value.dependencies?.ast_bro_binary,
      dprintBinary: value.dependencies?.dprint_binary,
    },
    files: resolvedFiles(value),
    formatting: resolvedFormatting(value, dprintConfig),
    generation: 0,
    http: resolvedHttp(value),
    paths: pathRules.map(({ rule, source }) => ({
      excludes: rule.excludes ?? [],
      followSymlinks: rule.follow_symlinks ?? false,
      id: rule.id,
      includes: rule.includes ?? ["**/*"],
      path: rule.path,
      policies: {
        delete: rule.policies.delete ?? rule.policies.write,
        read: rule.policies.read,
        write: rule.policies.write,
      },
      source,
    })),
    projectRoot,
    provenance,
    safety: resolvedSafety(value),
    sources: {
      environment: environment.names,
      global: global.value ? global.path : undefined,
      project: project.value ? project.path : undefined,
    },
    trustedRoots,
    version: value.version ?? 1,
    workspace: { roots: value.workspace?.roots ?? candidates },
  };
}

function resolutionRuntime(options: ResolveConfigOptions) {
  return {
    cwd: path.resolve(options.cwd ?? process.cwd()),
    env: options.env ?? process.env,
  };
}

function missingProjectLayer(projectRoot: string): LoadedLayer {
  return {
    fingerprint: "missing",
    path: path.join(projectRoot, "ast-mcp.toml"),
  };
}

async function loadResolutionLayers(
  globalPath: string,
  projectPath: string | undefined,
  projectRoot: string,
) {
  return await Promise.all([
    loadLayer(globalPath),
    projectPath
      ? loadLayer(projectPath)
      : Promise.resolve(missingProjectLayer(projectRoot)),
  ]);
}

async function resolvedDprint(value: InternalConfig) {
  const enabled = value.formatting?.enabled ?? true;
  const config = value.formatting?.dprint_config ?? packageDprintConfig();
  const fingerprint = enabled ? await validateDprintConfig(config) : "disabled";
  return { config, fingerprint };
}

function resolutionCacheKey(args: {
  candidates: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  environment: ReturnType<typeof environmentLayer>;
  globalPath: string;
  projectPath: string | undefined;
  projectRoot: string;
  trustedRoots: string[];
}) {
  return JSON.stringify({
    candidates: args.candidates,
    cwd: args.cwd,
    environment: args.environment.names.map((name) => [name, args.env[name]]),
    globalPath: args.globalPath,
    projectPath: args.projectPath,
    projectRoot: args.projectRoot,
    trustedRoots: args.trustedRoots,
  });
}

async function resolveForProject(
  projectRoot: string,
  candidates: string[],
  trustedRoots: string[],
  options: ResolveConfigOptions,
) {
  const { cwd, env } = resolutionRuntime(options);
  const globalPath = globalConfigPath(options);
  const projectPath = await projectConfigPath(projectRoot);
  const [global, project] = await loadResolutionLayers(
    globalPath,
    projectPath,
    projectRoot,
  );
  const environment = environmentLayer(env, cwd);
  const layers: ConfigLayer[] = [
    { name: "default", value: defaultInternalConfig(candidates) },
    { name: "global", value: global.value ?? {} },
    { name: "project", value: project.value ?? {} },
    { name: "environment", value: environment.value },
  ];
  const value = merge(...layers.map((item) => item.value));
  const sourceVersions = [global.value?.version, project.value?.version].filter(
    (version): version is 1 | 2 => version !== undefined,
  );
  if (sourceVersions.includes(1)) value.version = 1;
  const dprint = await resolvedDprint(value);
  const key = resolutionCacheKey({
    candidates,
    cwd,
    env,
    environment,
    globalPath,
    projectPath,
    projectRoot,
    trustedRoots,
  });
  const fingerprint = `${global.fingerprint}|${project.fingerprint}|${dprint.fingerprint}`;
  const cached = resolvedCache.get(key);
  if (cached?.fingerprint === fingerprint) return cached.value;
  const resolved = resolvedConfiguration({
    candidates,
    dprintConfig: dprint.config,
    environment,
    global,
    project,
    projectRoot,
    provenance: configProvenance(layers),
    trustedRoots,
    value,
  });
  resolvedCache.set(key, { fingerprint, value: resolved });
  return resolved;
}

function projectRelativePolicyPath(
  config: ResolvedConfig,
  rule: ResolvedConfig["paths"][number],
): string | undefined {
  if (rule.source !== "project" || !config.sources.project) return undefined;
  const relative = path.relative(
    path.dirname(config.sources.project),
    rule.path,
  );
  const outside =
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  return outside ? undefined : relative || ".";
}

function policy(config: ResolvedConfig) {
  return JSON.stringify({
    dependencies: config.dependencies,
    files: config.files,
    formatting: config.formatting,
    safety: config.safety,
  });
}

function pathRulePolicy(rule: ResolvedConfig["paths"][number]) {
  const { path: _path, ...policy } = rule;
  return JSON.stringify({
    ...policy,
    excludes: [...policy.excludes].sort(),
    includes: [...policy.includes].sort(),
  });
}

function pathRuleEquivalent(
  leftConfig: ResolvedConfig,
  rightConfig: ResolvedConfig,
  left: ResolvedConfig["paths"][number],
  right: ResolvedConfig["paths"][number],
) {
  if (pathRulePolicy(left) !== pathRulePolicy(right)) return false;
  if (left.path === right.path) return true;
  const leftRelative = projectRelativePolicyPath(leftConfig, left);
  const rightRelative = projectRelativePolicyPath(rightConfig, right);
  return leftRelative !== undefined && leftRelative === rightRelative;
}

function pathPoliciesEquivalent(left: ResolvedConfig, right: ResolvedConfig) {
  if (left.paths.length !== right.paths.length) return false;
  const unmatched = [...right.paths];
  for (const rule of left.paths) {
    const index = unmatched.findIndex((candidate) =>
      pathRuleEquivalent(left, right, rule, candidate),
    );
    if (index < 0) return false;
    unmatched.splice(index, 1);
  }
  return true;
}

function policiesEquivalent(left: ResolvedConfig, right: ResolvedConfig) {
  return policy(left) === policy(right) && pathPoliciesEquivalent(left, right);
}

export async function resolveConfig(
  options: ResolveConfigOptions = {},
): Promise<ResolvedConfig> {
  const { candidates, trustedRoots } = await projectRoots(options);
  const matched = matchedProjectRoots(candidates, options.requestPaths ?? []);
  const configs = await Promise.all(
    matched.map((root) =>
      resolveForProject(root, candidates, trustedRoots, options),
    ),
  );
  const first = configs[0] as ResolvedConfig;
  if (configs.some((config) => !policiesEquivalent(config, first)))
    throw new ConfigurationError(
      `Request spans workspace roots with conflicting ast-mcp policies: ${matched.join(", ")}`,
    );
  return first;
}

export function configRequestPaths(value: unknown): string[] {
  return [...new Set(collectRequestPaths(value))];
}

const activeConfig = new AsyncLocalStorage<ResolvedConfig>();

export async function currentConfig(): Promise<ResolvedConfig> {
  return activeConfig.getStore() ?? resolveConfig();
}

export async function withConfig<T>(
  options: ResolveConfigOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const config = await resolveConfig(options);
  return activeConfig.run(config, operation);
}

export async function withResolvedConfig<T>(
  config: ResolvedConfig,
  operation: () => Promise<T>,
): Promise<T> {
  return activeConfig.run(config, operation);
}

export function clearConfigCache() {
  dprintConfigCache.clear();
  layerCache.clear();
  resolvedCache.clear();
}

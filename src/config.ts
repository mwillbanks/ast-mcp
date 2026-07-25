import { AsyncLocalStorage } from "node:async_hooks";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { collectRequestPaths, normalizeConfigLayer } from "./helpers/config";

const positiveInteger = z.number().int().positive();
const toolNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[a-zA-Z0-9_.:-]+$/,
    "tool names may contain letters, digits, _, ., :, and - only",
  );
const hookSchema = z
  .object({
    allow_tools: z.array(toolNameSchema).max(64).optional(),
    block_tools: z.array(toolNameSchema).max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const allowed = new Set(
      (value.allow_tools ?? []).map((tool) => tool.toLowerCase()),
    );
    for (const tool of value.block_tools ?? [])
      if (allowed.has(tool.toLowerCase()))
        context.addIssue({
          code: "custom",
          message: `hook tool "${tool}" cannot be both allowed and blocked`,
          path: ["block_tools"],
        });
  });
const formatterSchema = z
  .object({
    args: z.array(z.string().max(4096)).max(64).optional(),
    command: z.string().min(1).max(4096),
    extensions: z
      .array(
        z.string().regex(/^\.[^./\\]+$/, "extensions must begin with a dot"),
      )
      .max(64)
      .optional(),
    globs: z.array(z.string().min(1).max(4096)).max(64).optional(),
    timeout_ms: positiveInteger.max(120_000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(value.extensions?.length) || Boolean(value.globs?.length),
    "formatter requires at least one extension or glob",
  );
const fileSchema = z
  .object({
    dependencies: z
      .object({
        ast_bro_binary: z.string().min(1).optional(),
        dprint_binary: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    formatting: z
      .object({
        dprint_config: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        formatters: z.array(formatterSchema).max(64).optional(),
      })
      .strict()
      .optional(),
    http: z
      .object({
        host: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65_535).optional(),
        session_sweep_interval_ms: positiveInteger.optional(),
        session_timeout_ms: positiveInteger.optional(),
      })
      .strict()
      .optional(),
    safety: z
      .object({
        allow_external_roots: z.boolean().optional(),
        follow_symlinks: z.boolean().optional(),
        hook: hookSchema.optional(),
        require_hash: z.boolean().optional(),
      })
      .strict()
      .optional(),
    version: z.literal(1).optional(),
    workspace: z
      .object({ roots: z.array(z.string().min(1)).min(1).optional() })
      .strict()
      .optional(),
  })
  .strict();

type AstMcpFileConfig = z.infer<typeof fileSchema>;

export interface ResolvedConfig {
  dependencies: { astBroBinary?: string; dprintBinary?: string };
  formatting: {
    dprintConfig: string;
    enabled: boolean;
    formatters: Array<{
      args: string[];
      command: string;
      extensions: string[];
      globs: string[];
      timeoutMs: number;
    }>;
  };
  http: {
    host: string;
    port: number;
    sessionTimeoutMs: number;
    sessionSweepIntervalMs: number;
  };
  projectRoot: string;
  provenance: Record<string, "default" | "global" | "project" | "environment">;
  safety: {
    allowExternalRoots: boolean;
    followSymlinks: boolean;
    hook: { allowTools: string[]; blockTools: string[]; enabled: boolean };
    requireHash: boolean;
  };
  sources: {
    project?: string;
    global?: string;
    environment: string[];
  };
  trustedRoots: string[];
  version: 1;
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
  formatting?: {
    dprint_config?: string;
    enabled?: boolean;
    formatters?: Array<{
      args?: string[];
      command: string;
      extensions?: string[];
      globs?: string[];
      timeout_ms?: number;
    }>;
  };
  http?: {
    host?: string;
    port?: number;
    session_timeout_ms?: number;
    session_sweep_interval_ms?: number;
  };
  safety?: {
    allow_external_roots?: boolean;
    follow_symlinks?: boolean;
    hook?: {
      allow_tools?: string[];
      block_tools?: string[];
      enabled?: boolean;
    };
    require_hash?: boolean;
  };
  version?: 1;
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

function normalizeLayer(
  value: AstMcpFileConfig,
  filePath: string,
): AstMcpFileConfig {
  return normalizeConfigLayer(value, filePath);
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
    let parsed: unknown;
    try {
      parsed = Bun.TOML.parse(await Bun.file(filePath).text());
    } catch (error) {
      throw new ConfigurationError(
        `${filePath}: invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const result = fileSchema.safeParse(parsed);
    if (!result.success)
      throw new ConfigurationError(
        `${filePath}: invalid configuration: ${diagnostic(result.error)}`,
      );
    return {
      fingerprint,
      path: filePath,
      value: normalizeLayer(result.data, filePath),
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
  const allowExternal = usage.use(
    "AST_MCP_ALLOW_EXTERNAL_ROOTS",
    booleanEnvironment(env, "AST_MCP_ALLOW_EXTERNAL_ROOTS"),
  );
  return allowExternal === undefined
    ? undefined
    : { allow_external_roots: allowExternal };
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
  "safety.allow_external_roots",
  "safety.follow_symlinks",
  "safety.hook.allow_tools",
  "safety.hook.block_tools",
  "safety.hook.enabled",
  "safety.require_hash",
  "formatting.dprint_config",
  "formatting.enabled",
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

function merge(...layers: InternalConfig[]): InternalConfig {
  const result: InternalConfig = {};
  for (const layer of layers) {
    if (layer.version !== undefined) result.version = layer.version;
    for (const section of [
      "workspace",
      "safety",
      "formatting",
      "dependencies",
      "http",
    ] as const) {
      const incoming = layer[section];
      if (!incoming) continue;
      const previousHook = result.safety?.hook;
      const defined = Object.fromEntries(
        Object.entries(incoming).filter(([, value]) => value !== undefined),
      );
      result[section] = {
        ...(result[section] as object | undefined),
        ...defined,
      } as never;
      if (section === "safety") {
        const safetyIncoming = incoming as InternalConfig["safety"];
        if (safetyIncoming?.hook)
          result.safety = {
            ...result.safety,
            hook: {
              ...previousHook,
              ...Object.fromEntries(
                Object.entries(safetyIncoming.hook).filter(
                  ([, value]) => value !== undefined,
                ),
              ),
            },
          };
      }
    }
  }
  return result;
}

async function projectRoots(options: ResolveConfigOptions) {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const clientRoots = await Promise.all(
    (options.clientRoots ?? []).map((item) =>
      existingDirectory(resolveFileUri(item)),
    ),
  );
  if (clientRoots.length)
    return { candidates: clientRoots, trustedRoots: clientRoots };

  if (env.AST_MCP_PROJECT_ROOT) {
    const selected = path.resolve(cwd, env.AST_MCP_PROJECT_ROOT);
    return { candidates: [selected], trustedRoots: [selected] };
  }

  const legacy = env.AST_MCP_ROOTS?.split(path.delimiter).filter(Boolean);
  if (legacy?.length)
    return {
      candidates: legacy.map((item) => path.resolve(cwd, item)),
      trustedRoots: [cwd],
    };

  return { candidates: [cwd], trustedRoots: [cwd] };
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
      allow_external_roots: false,
      follow_symlinks: false,
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
  return {
    dprintConfig,
    enabled: value.formatting?.enabled ?? true,
    formatters: (value.formatting?.formatters ?? []).map((formatter) => ({
      args: formatter.args ?? [],
      command: formatter.command,
      extensions: formatter.extensions ?? [],
      globs: formatter.globs ?? [],
      timeoutMs: formatter.timeout_ms ?? 30_000,
    })),
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

function resolvedSafety(value: InternalConfig): ResolvedConfig["safety"] {
  return {
    allowExternalRoots: withDefault(value.safety?.allow_external_roots, false),
    followSymlinks: withDefault(value.safety?.follow_symlinks, false),
    hook: resolvedHook(value.safety),
    requireHash: withDefault(value.safety?.require_hash, true),
  };
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
  return {
    dependencies: {
      astBroBinary: value.dependencies?.ast_bro_binary,
      dprintBinary: value.dependencies?.dprint_binary,
    },
    formatting: resolvedFormatting(value, dprintConfig),
    http: resolvedHttp(value),
    projectRoot,
    provenance,
    safety: resolvedSafety(value),
    sources: {
      environment: environment.names,
      global: global.value ? global.path : undefined,
      project: project.value ? project.path : undefined,
    },
    trustedRoots,
    version: 1,
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

function policy(config: ResolvedConfig) {
  return JSON.stringify({
    dependencies: config.dependencies,
    formatting: config.formatting,
    safety: config.safety,
  });
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
  if (configs.some((config) => policy(config) !== policy(first)))
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

export function clearConfigCache() {
  dprintConfigCache.clear();
  layerCache.clear();
  resolvedCache.clear();
}

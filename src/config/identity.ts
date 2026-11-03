import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  canonicalizePathSync,
  canonicalPathWithin,
} from "../runtime/path-utils";
import type { ResolveConfigOptions, ResolvedConfig } from "./index";

const resolutionOptions = new WeakMap<
  Readonly<ResolvedConfig>,
  ResolveConfigOptions
>();

export function bindConfigurationResolution<T extends Readonly<ResolvedConfig>>(
  config: T,
  options: ResolveConfigOptions,
): T {
  resolutionOptions.set(config, captureResolutionOptions(options));
  return config;
}

export function configurationResolutionOptions(
  config: Readonly<ResolvedConfig>,
): ResolveConfigOptions | undefined {
  const options = resolutionOptions.get(config);
  return options ? captureResolutionOptions(options) : undefined;
}

const environmentNames = [
  "APPDATA",
  "XDG_CONFIG_HOME",
  "AST_MCP_PROJECT_ROOT",
  "AST_MCP_ROOTS",
  "CLAUDE_PROJECT_DIR",
  "AST_MCP_ALLOW_ANY_PATH",
  "AST_MCP_ALLOW_EXTERNAL_ROOTS",
  "AST_MCP_ALLOW_TEMP_DIRECTORY",
  "AST_MCP_DPRINT_CONFIG",
  "AST_MCP_EMBEDDING_MODEL",
  "DPRINT_BINARY",
  "AST_MCP_HTTP_HOST",
  "PORT",
  "AST_MCP_SESSION_TIMEOUT_MS",
  "AST_MCP_SESSION_SWEEP_INTERVAL_MS",
] as const;

/** Freeze ambient selection inputs before any asynchronous filesystem work. */
export function captureResolutionOptions(
  options: ResolveConfigOptions,
): ResolveConfigOptions {
  const launchCwd = path.resolve(options.launchCwd ?? process.cwd());
  const environment = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const name of environmentNames) {
    const value = environment[name];
    if (value !== undefined) env[name] = value;
  }
  for (const name of ["APPDATA", "XDG_CONFIG_HOME"] as const) {
    if (env[name] !== undefined) env[name] = path.resolve(launchCwd, env[name]);
  }
  return {
    ...options,
    cwd:
      options.cwd === undefined
        ? undefined
        : path.resolve(launchCwd, options.cwd),
    launchCwd,
    env,
    home: path.resolve(launchCwd, options.home ?? os.homedir()),
    platform: options.platform ?? process.platform,
    clientRoots: options.clientRoots?.map((value) =>
      path.resolve(
        launchCwd,
        value.startsWith("file:") ? Bun.fileURLToPath(new URL(value)) : value,
      ),
    ),
    requestPaths: options.requestPaths ? [...options.requestPaths] : undefined,
  };
}

export function configuredSelectionRoots(
  clientRoots: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): string[] {
  if (clientRoots.length) return clientRoots;
  if (env.AST_MCP_PROJECT_ROOT)
    return [path.resolve(cwd, env.AST_MCP_PROJECT_ROOT)];
  return (env.AST_MCP_ROOTS?.split(path.delimiter).filter(Boolean) ?? []).map(
    (root) => path.resolve(cwd, root),
  );
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

/** Discover configuration with the resolver's lexical ancestor boundaries. */
export function projectConfigurationPath(
  projectRoot: string,
): string | undefined {
  let current = projectRoot;
  while (true) {
    const candidate = path.join(current, "ast-mcp.toml");
    if (existsSync(candidate)) return candidate;
    if (existsSync(path.join(current, ".git"))) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** A resolution identity never depends on identities produced by resolution. */
export function configurationResolutionKey(
  options: ResolveConfigOptions,
): string {
  const captured = captureResolutionOptions(options);
  const cwd = captured.cwd ?? captured.launchCwd!;
  const env = captured.env!;
  const clientRoots = captured.clientRoots ?? [];
  const selectionRoots = configuredSelectionRoots(clientRoots, cwd, env);
  const requestPaths = (captured.requestPaths ?? []).filter(path.isAbsolute);
  const matched = selectionRoots.filter((root) =>
    requestPaths.some((requestPath) => canonicalPathWithin(root, requestPath)),
  );
  const selected = matched.length ? matched : [selectionRoots[0] ?? cwd];
  const relativeEnvironment = [
    env.AST_MCP_DPRINT_CONFIG,
    env.DPRINT_BINARY?.includes("/") || env.DPRINT_BINARY?.includes("\\")
      ? env.DPRINT_BINARY
      : undefined,
  ].some((value) => value !== undefined && !path.isAbsolute(value));
  return JSON.stringify({
    clientRoots: clientRoots.map(canonicalizePathSync),
    cwd:
      !clientRoots.length || relativeEnvironment
        ? canonicalizePathSync(cwd)
        : undefined,
    explicitCwd:
      !selectionRoots.length &&
      env.CLAUDE_PROJECT_DIR &&
      path.isAbsolute(env.CLAUDE_PROJECT_DIR)
        ? captured.cwd !== undefined
        : undefined,
    env,
    home: canonicalizePathSync(captured.home!),
    globalConfiguration: path.resolve(globalConfigPath(captured)),
    platform: captured.platform,
    selectedRoots: selected.map(canonicalizePathSync),
    // Lexical roots determine prospective ancestor walks and relative policy
    // anchors. Keep them stable when discovered files appear or disappear.
    selectionRoots: selected.map((root) => path.resolve(root)),
  });
}

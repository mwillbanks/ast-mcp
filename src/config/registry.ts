import { type FSWatcher, watch } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { setApprovalConfigInvalidator } from "../runtime/approval";
import { canonicalPathWithin } from "../runtime/path-utils";
import {
  clearConfigCache,
  globalConfigPath,
  hostProjectRootCandidate,
  type ResolveConfigOptions,
  type ResolvedConfig,
  resolveConfig,
} from "./index";

export interface ConfigSnapshot {
  config?: Readonly<ResolvedConfig>;
  error?: string;
  fingerprints: Record<string, string>;
  generation: number;
  healthy: boolean;
  key: string;
  loadedAt: string;
}

interface RegistryEntry {
  options: ResolveConfigOptions;
  fingerprintRoles?: Record<string, FingerprintRole>;
  promise?: Promise<Readonly<ConfigSnapshot>>;
  reloadTimer?: ReturnType<typeof setTimeout>;
  snapshot?: Readonly<ConfigSnapshot>;
  watchers: FSWatcher[];
}

function capturedOptions(options: ResolveConfigOptions): ResolveConfigOptions {
  const launchCwd = path.resolve(options.launchCwd ?? process.cwd());
  const cwd =
    options.cwd === undefined
      ? undefined
      : path.resolve(launchCwd, options.cwd);
  const env = environmentFingerprint(options.env ?? process.env);
  for (const name of ["APPDATA", "XDG_CONFIG_HOME"] as const) {
    if (env[name] !== undefined) env[name] = path.resolve(launchCwd, env[name]);
  }
  return {
    ...options,
    cwd,
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

function environmentFingerprint(environment: NodeJS.ProcessEnv) {
  const fingerprint: Record<string, string> = {};
  for (const name of [
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
  ]) {
    const value = environment[name];
    if (value !== undefined) fingerprint[name] = value;
  }
  return fingerprint;
}

function selectedRoots(
  clientRoots: string[],
  requestPaths: string[],
  cwd: string,
): string[] {
  const matched = clientRoots.filter((root) =>
    requestPaths.some((requestPath) => canonicalPathWithin(root, requestPath)),
  );
  if (matched.length > 0) return matched;
  return [clientRoots[0] ?? cwd];
}

function configuredSelectionRoots(
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

function keyFor(options: ResolveConfigOptions): string {
  const cwd = options.cwd ?? options.launchCwd!;
  const env = options.env!;
  const clientRoots = options.clientRoots ?? [];
  const selectionRoots = configuredSelectionRoots(clientRoots, cwd, env);
  const requestPaths = (options.requestPaths ?? [])
    .filter((item) => path.isAbsolute(item))
    .map((item) => path.resolve(item));
  return JSON.stringify({
    clientRoots,
    cwd,
    explicitCwd: options.cwd !== undefined,
    env: environmentFingerprint(env),
    home: options.home,
    platform: options.platform,
    revisionId: options.revisionId,
    selectedRoots: selectedRoots(selectionRoots, requestPaths, cwd),
    storageDomainId: options.storageDomainId,
    workspaceId: options.workspaceId,
  });
}

type FingerprintRole = "configuration" | "identity" | "boundary";

async function fingerprint(
  filePath: string,
  role: FingerprintRole,
): Promise<string> {
  const metadata = await stat(filePath).catch(() => undefined);
  if (!metadata) return "missing";
  const physicalPath = await realpath(filePath).catch(() => undefined);
  return JSON.stringify([
    metadata.isDirectory() ? "directory" : "file",
    metadata.dev,
    metadata.ino,
    physicalPath,
    ...(role === "configuration" || (role === "boundary" && metadata.isFile())
      ? [metadata.mtimeMs, metadata.size]
      : []),
  ]);
}

async function projectConfigCandidates(
  projectRoot: string,
): Promise<Array<[string, FingerprintRole]>> {
  const candidates: Array<[string, FingerprintRole]> = [];
  let current = path.resolve(projectRoot);
  while (true) {
    candidates.push(
      [path.join(current, "ast-mcp.toml"), "configuration"],
      [path.join(current, ".git"), "boundary"],
    );
    const boundary = await stat(path.join(current, ".git")).then(
      () => true,
      () => false,
    );
    if (boundary) return candidates;
    const parent = path.dirname(current);
    if (parent === current) return candidates;
    current = parent;
  }
}

async function fingerprints(
  config: ResolvedConfig | undefined,
  options: ResolveConfigOptions,
) {
  const projectRoot = config?.projectRoot ?? options.cwd ?? options.launchCwd!;
  const hostRoot = hostProjectRootCandidate(options);
  const selectionRoots = configuredSelectionRoots(
    options.clientRoots ?? [],
    options.cwd ?? options.launchCwd!,
    options.env!,
  );
  const identityRoots = new Set([
    projectRoot,
    ...selectionRoots,
    ...(config?.trustedRoots ?? []),
    ...(config?.workspace.roots ?? []),
  ]);
  const sources = new Map<string, FingerprintRole>([
    ...[...identityRoots].map((root): [string, FingerprintRole] => [
      root,
      "identity",
    ]),
    ...(hostRoot
      ? [
          [hostRoot, "identity"] as [string, FingerprintRole],
          ...(await projectConfigCandidates(hostRoot)),
        ]
      : []),
    [globalConfigPath(options), "configuration"],
    ...(await projectConfigCandidates(projectRoot)),
    ...(config?.sources.global
      ? [[config.sources.global, "configuration"] as [string, FingerprintRole]]
      : []),
    ...(config?.sources.project
      ? [[config.sources.project, "configuration"] as [string, FingerprintRole]]
      : []),
  ]);
  return {
    roles: Object.fromEntries(sources),
    values: Object.fromEntries(
      await Promise.all(
        [...sources].map(async ([source, role]) => [
          source,
          await fingerprint(source, role),
        ]),
      ),
    ),
  };
}

export class ConfigRegistry {
  readonly #entries = new Map<string, RegistryEntry>();
  readonly #reconcileTimer: ReturnType<typeof setInterval>;
  constructor(
    readonly debounceMs = 75,
    readonly reconcileMs = 30_000,
    readonly maxEntries = 128,
  ) {
    this.#reconcileTimer = setInterval(
      () => void this.reconcile(),
      reconcileMs,
    );
    this.#reconcileTimer.unref?.();
  }
  async get(options: ResolveConfigOptions = {}): Promise<ResolvedConfig> {
    const snapshot = await this.snapshot(options);
    if (!snapshot.healthy || !snapshot.config)
      throw new Error(
        snapshot.error ??
          "ast-mcp configuration is unavailable; run config_status",
      );
    return snapshot.config as ResolvedConfig;
  }
  #evictOldest(): void {
    const oldestKey = this.#entries.keys().next().value;
    if (oldestKey === undefined) return;
    const oldest = this.#entries.get(oldestKey);
    if (oldest?.reloadTimer) clearTimeout(oldest.reloadTimer);
    for (const watcher of oldest?.watchers ?? []) watcher.close();
    this.#entries.delete(oldestKey);
  }

  #entry(key: string, options: ResolveConfigOptions): RegistryEntry {
    const existing = this.#entries.get(key);
    if (existing) {
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return existing;
    }
    if (this.#entries.size >= this.maxEntries) this.#evictOldest();
    const entry = { options: { ...options }, watchers: [] };
    this.#entries.set(key, entry);
    return entry;
  }

  async snapshot(
    options: ResolveConfigOptions = {},
  ): Promise<Readonly<ConfigSnapshot>> {
    const captured = capturedOptions(options);
    const key = keyFor(captured);
    const entry = this.#entry(key, captured);
    if (!entry.promise) entry.promise = this.#reload(key, entry);
    return entry.promise;
  }
  invalidate(options: ResolveConfigOptions = {}): void {
    const key = keyFor(capturedOptions(options));
    const entry = this.#entries.get(key);
    if (Object.keys(options).length === 0) {
      for (const [entryKey, entryValue] of this.#entries)
        this.#queueReload(entryKey, entryValue);
    } else if (entry) this.#schedule(key, entry);
  }
  async reload(): Promise<Array<Readonly<ConfigSnapshot>>> {
    this.invalidate();
    return Promise.all(
      [...this.#entries.values()].flatMap((entry) =>
        entry.promise ? [entry.promise] : [],
      ),
    );
  }
  async reconcile(): Promise<void> {
    await Promise.all(
      [...this.#entries.entries()].map(async ([key, entry]) => {
        const snapshot = entry.snapshot;
        const roles = entry.fingerprintRoles;
        if (!snapshot || !roles) return;
        for (const [source, previous] of Object.entries(
          snapshot.fingerprints,
        )) {
          if ((await fingerprint(source, roles[source]!)) !== previous) {
            if (entry.snapshot === snapshot && this.#entries.get(key) === entry)
              this.#schedule(key, entry);
            break;
          }
        }
      }),
    );
  }

  close(): void {
    clearInterval(this.#reconcileTimer);
    for (const entry of this.#entries.values()) {
      if (entry.reloadTimer) clearTimeout(entry.reloadTimer);
      for (const watcher of entry.watchers) watcher.close();
    }
    this.#entries.clear();
  }
  #queueReload(key: string, entry: RegistryEntry): void {
    const previous = entry.promise;
    const next = (
      previous ? previous.catch(() => undefined) : Promise.resolve()
    ).then(() => this.#reload(key, entry));
    entry.promise = next;
    void next.catch(() => undefined);
  }

  #schedule(key: string, entry: RegistryEntry): void {
    if (entry.reloadTimer) clearTimeout(entry.reloadTimer);
    entry.reloadTimer = setTimeout(() => {
      this.#queueReload(key, entry);
    }, this.debounceMs);
    entry.reloadTimer.unref?.();
  }
  async #reload(
    key: string,
    entry: RegistryEntry,
  ): Promise<Readonly<ConfigSnapshot>> {
    clearConfigCache();
    const generation = (entry.snapshot?.generation ?? 0) + 1;
    let snapshot: Readonly<ConfigSnapshot>;
    try {
      const resolved = await resolveConfig(entry.options);
      const config = Object.freeze({ ...resolved, generation });
      const collected = await fingerprints(resolved, entry.options);
      entry.fingerprintRoles = collected.roles;
      snapshot = Object.freeze({
        config,
        fingerprints: collected.values,
        generation,
        healthy: true,
        key,
        loadedAt: new Date().toISOString(),
      });
    } catch (error) {
      const collected = await fingerprints(
        entry.snapshot?.config,
        entry.options,
      );
      entry.fingerprintRoles = collected.roles;
      snapshot = Object.freeze({
        config: entry.snapshot?.config,
        error: error instanceof Error ? error.message : String(error),
        fingerprints: collected.values,
        generation,
        healthy: false,
        key,
        loadedAt: new Date().toISOString(),
      });
    }
    entry.snapshot = snapshot;
    if (!entry.promise) entry.promise = Promise.resolve(snapshot);
    if (this.#entries.get(key) === entry) this.#watch(key, entry, snapshot);
    return snapshot;
  }

  #watch(
    key: string,
    entry: RegistryEntry,
    snapshot: Readonly<ConfigSnapshot>,
  ): void {
    for (const watcher of entry.watchers) watcher.close();
    entry.watchers = [];
    const directories = new Set(
      Object.keys(snapshot.fingerprints).map((source) => path.dirname(source)),
    );
    for (const directory of directories) {
      try {
        const watcher = watch(directory, (_event, filename) => {
          if (this.#entries.get(key) !== entry) return;
          if (
            !filename ||
            filename.toString() === "ast-mcp.toml" ||
            filename.toString() === ".git" ||
            Object.hasOwn(
              snapshot.fingerprints,
              path.join(directory, filename.toString()),
            )
          )
            void this.reconcile();
        });
        watcher.unref?.();
        entry.watchers.push(watcher);
      } catch {
        // Periodic fingerprint reconciliation remains authoritative.
      }
    }
  }
}

export const configRegistry = new ConfigRegistry();
setApprovalConfigInvalidator(() => configRegistry.invalidate());

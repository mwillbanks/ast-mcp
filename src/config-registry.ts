import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearConfigCache,
  globalConfigPath,
  type ResolveConfigOptions,
  type ResolvedConfig,
  resolveConfig,
} from "./config";
import { setApprovalConfigInvalidator } from "./runtime/approval";

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
  promise?: Promise<Readonly<ConfigSnapshot>>;
  reloadTimer?: ReturnType<typeof setTimeout>;
  snapshot?: Readonly<ConfigSnapshot>;
  watchers: FSWatcher[];
}

function normalizedClientRoot(value: string): string {
  return path.resolve(
    value.startsWith("file:") ? fileURLToPath(new URL(value)) : value,
  );
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function environmentFingerprint(environment: NodeJS.ProcessEnv) {
  const fingerprint: Record<string, string> = {};
  for (const name of [
    "APPDATA",
    "XDG_CONFIG_HOME",
    "AST_MCP_PROJECT_ROOT",
    "AST_MCP_ROOTS",
    "AST_MCP_ALLOW_ANY_PATH",
    "AST_MCP_ALLOW_EXTERNAL_ROOTS",
    "AST_MCP_ALLOW_TEMP_DIRECTORY",
    "AST_MCP_DPRINT_CONFIG",
    "AST_BRO_BINARY",
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
    requestPaths.some((requestPath) => within(root, requestPath)),
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
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const clientRoots = (options.clientRoots ?? []).map(normalizedClientRoot);
  const selectionRoots = configuredSelectionRoots(clientRoots, cwd, env);
  const requestPaths = (options.requestPaths ?? [])
    .filter((item) => path.isAbsolute(item))
    .map((item) => path.resolve(item));
  return JSON.stringify({
    clientRoots,
    cwd,
    env: environmentFingerprint(env),
    home: options.home,
    platform: options.platform,
    selectedRoots: selectedRoots(selectionRoots, requestPaths, cwd),
  });
}

async function fingerprint(filePath: string): Promise<string> {
  const metadata = await stat(filePath).catch(() => undefined);
  return metadata ? `${metadata.mtimeMs}:${metadata.size}` : "missing";
}

async function projectConfigCandidates(projectRoot: string): Promise<string[]> {
  const candidates: string[] = [];
  let current = path.resolve(projectRoot);
  while (true) {
    candidates.push(path.join(current, "ast-mcp.toml"));
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
): Promise<Record<string, string>> {
  const projectRoot = config?.projectRoot ?? options.cwd ?? process.cwd();
  const sources = [
    globalConfigPath(options),
    ...(await projectConfigCandidates(projectRoot)),
    config?.sources.global,
    config?.sources.project,
  ].filter(
    (item, index, all): item is string =>
      Boolean(item) && all.indexOf(item) === index,
  );
  return Object.fromEntries(
    await Promise.all(
      sources.map(async (source) => [source, await fingerprint(source)]),
    ),
  );
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
    const key = keyFor(options);
    const entry = this.#entry(key, options);
    if (!entry.promise) entry.promise = this.#reload(key, entry);
    return entry.promise;
  }
  invalidate(options: ResolveConfigOptions = {}): void {
    const key = keyFor(options);
    const entry = this.#entries.get(key);
    if (Object.keys(options).length === 0) {
      for (const [entryKey, entryValue] of this.#entries)
        this.#queueReload(entryKey, entryValue);
    } else if (entry) this.#schedule(key, entry);
  }
  async reconcile(): Promise<void> {
    await Promise.all(
      [...this.#entries.entries()].map(async ([key, entry]) => {
        const snapshot = entry.snapshot;
        if (!snapshot) return;
        for (const [source, previous] of Object.entries(
          snapshot.fingerprints,
        )) {
          if ((await fingerprint(source)) !== previous) {
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
      snapshot = Object.freeze({
        config,
        fingerprints: await fingerprints(resolved, entry.options),
        generation,
        healthy: true,
        key,
        loadedAt: new Date().toISOString(),
      });
    } catch (error) {
      snapshot = Object.freeze({
        config: entry.snapshot?.config,
        error: error instanceof Error ? error.message : String(error),
        fingerprints: await fingerprints(entry.snapshot?.config, entry.options),
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
          if (!filename || filename.toString() === "ast-mcp.toml")
            this.#schedule(key, entry);
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

import { type FSWatcher, watch } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { setApprovalConfigInvalidator } from "../runtime/approval";
import {
  captureResolutionOptions,
  configurationResolutionKey,
  configuredSelectionRoots,
} from "./identity";
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
  reloadForce?: boolean;
  snapshot?: Readonly<ConfigSnapshot>;
  watchers: FSWatcher[];
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

function sameFingerprints(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

function configurationIdentity(
  config: Readonly<ResolvedConfig> | undefined,
): string {
  return JSON.stringify(config ? { ...config, generation: 0 } : null);
}

async function stableResolution(entry: RegistryEntry) {
  let previous = entry.snapshot?.config;
  for (let attempt = 0; ; attempt += 1) {
    const before = await fingerprints(previous, entry.options);
    clearConfigCache();
    let resolved: ResolvedConfig | undefined;
    let error: string | undefined;
    try {
      resolved = await resolveConfig(entry.options);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const collected = await fingerprints(resolved ?? previous, entry.options);
    if (sameFingerprints(before.values, collected.values))
      return { collected, error, resolved };
    if (attempt >= 2)
      return {
        collected,
        error:
          "ast-mcp configuration changed during resolution; run config_status again",
        resolved: undefined,
      };
    previous = resolved ?? previous;
  }
}

export class ConfigRegistry {
  readonly #entries = new Map<string, RegistryEntry>();
  #generation = 0;
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
    const captured = captureResolutionOptions(options);
    const key = configurationResolutionKey(captured);
    const entry = this.#entry(key, captured);
    if (!entry.promise) entry.promise = this.#reload(key, entry);
    return entry.promise;
  }
  invalidate(options: ResolveConfigOptions = {}): void {
    const key = configurationResolutionKey(options);
    const entry = this.#entries.get(key);
    if (Object.keys(options).length === 0) {
      for (const [entryKey, entryValue] of this.#entries)
        this.#queueReload(entryKey, entryValue, true);
    } else if (entry) this.#schedule(key, entry, true);
  }
  async reload(): Promise<Array<Readonly<ConfigSnapshot>>> {
    return Promise.all(
      [...this.#entries.entries()].map(([key, entry]) =>
        this.#queueReload(key, entry),
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
  #queueReload(
    key: string,
    entry: RegistryEntry,
    force = false,
  ): Promise<Readonly<ConfigSnapshot>> {
    if (entry.reloadTimer) clearTimeout(entry.reloadTimer);
    entry.reloadTimer = undefined;
    const forced = force || entry.reloadForce === true;
    entry.reloadForce = false;
    const previous = entry.promise;
    const next = (
      previous ? previous.catch(() => undefined) : Promise.resolve()
    ).then(() => this.#reload(key, entry, forced));
    entry.promise = next;
    void next.catch(() => undefined);
    return next;
  }

  #schedule(key: string, entry: RegistryEntry, force = false): void {
    if (entry.reloadTimer) clearTimeout(entry.reloadTimer);
    entry.reloadForce = force || entry.reloadForce === true;
    entry.reloadTimer = setTimeout(() => {
      this.#queueReload(key, entry);
    }, this.debounceMs);
    entry.reloadTimer.unref?.();
  }
  async #reload(
    key: string,
    entry: RegistryEntry,
    force = false,
  ): Promise<Readonly<ConfigSnapshot>> {
    const { collected, error, resolved } = await stableResolution(entry);
    const previous = entry.snapshot;
    const healthy = resolved !== undefined;
    entry.fingerprintRoles = collected.roles;
    if (
      !force &&
      previous &&
      previous.healthy === healthy &&
      previous.error === error &&
      sameFingerprints(previous.fingerprints, collected.values) &&
      (!resolved ||
        configurationIdentity(previous.config) ===
          configurationIdentity(resolved))
    )
      return previous;
    const generation = ++this.#generation;
    const snapshot = Object.freeze({
      config: resolved
        ? Object.freeze({ ...resolved, generation })
        : previous?.config,
      ...(error === undefined ? {} : { error }),
      fingerprints: collected.values,
      generation,
      healthy,
      key,
      loadedAt: new Date().toISOString(),
    });
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

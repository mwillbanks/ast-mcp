import { opendir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { globalConfigPath } from "../../config/identity.ts";
import { sha256 } from "../../runtime/hash.ts";
import { pathWithin } from "../../runtime/path-utils.ts";
import {
  createStorageDomainId,
  INTELLIGENCE_SCHEMA_VERSION,
  type StorageDomain,
  type StoragePlacement,
  StoragePlacementSchema,
} from "../contracts/index.ts";

export interface StorageResolutionOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

function legacyGlobalStorageRoot(options: StorageResolutionOptions): string {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  if (env.XDG_CACHE_HOME) return path.resolve(env.XDG_CACHE_HOME);
  if ((options.platform ?? process.platform) === "win32" && env.LOCALAPPDATA)
    return path.resolve(env.LOCALAPPDATA);
  return path.resolve(home, ".cache");
}

function parentAnchor(anchor: string, levels: number): string {
  let current = anchor;
  for (let index = 0; index < levels; index += 1) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export function resolveStorageDomain(
  repositoryAnchor: string,
  input: StoragePlacement = { kind: "global" },
  options: StorageResolutionOptions = {},
  checkoutRoot = repositoryAnchor,
): StorageDomain {
  const placement = StoragePlacementSchema.parse(input);
  const storagePath =
    placement.kind === "global"
      ? path.join(path.dirname(globalConfigPath(options)), "intelligence")
      : placement.kind === "local"
        ? path.join(checkoutRoot, ".ast-mcp", "intelligence")
        : placement.kind === "parent"
          ? path.join(
              parentAnchor(repositoryAnchor, placement.levels),
              ".ast-mcp",
              "intelligence",
            )
          : path.resolve(placement.path);
  return createStorageDomain(placement, storagePath);
}

export function legacyStorageDomain(
  repositoryAnchor: string,
  placement: StoragePlacement,
  options: StorageResolutionOptions,
): StorageDomain | undefined {
  if (placement.kind === "global")
    return createStorageDomain(
      placement,
      path.join(legacyGlobalStorageRoot(options), "ast-mcp", "intelligence"),
    );
  if (placement.kind === "local")
    return createStorageDomain(
      placement,
      path.join(repositoryAnchor, ".ast-mcp", "intelligence"),
    );
  return undefined;
}

function createStorageDomain(
  placement: StoragePlacement,
  storagePath: string,
): StorageDomain {
  const coordinates = {
    engine: "lancedb" as const,
    placement,
    pool: "shared" as const,
    storagePath: path.resolve(storagePath),
  };
  return {
    ...coordinates,
    domainId: createStorageDomainId(coordinates),
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
  };
}

async function hasLanceTable(storagePath: string, name: string) {
  const directory = path.join(storagePath, `${name}.lance`, "_versions");
  try {
    const versions = await opendir(directory);
    for await (const item of versions) {
      if (item.isFile() && /^\d+\.manifest$/u.test(item.name)) return true;
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function findExistingNestedStorageDomain(
  candidates: readonly StorageDomain[],
  checkoutRoot: string,
  checkout: { repositoryId: string; revisionId: string },
  workspaceId: (domain: StorageDomain) => string,
): Promise<StorageDomain | undefined> {
  const { readRefreshStateForCheckout } =
    await import("../mutation/experimental-deferred-refresh.ts");
  const state = await readRefreshStateForCheckout(checkoutRoot);
  const recovery = candidates.find(
    (domain) => state?.storageScope === sha256(domain.domainId),
  );
  if (recovery) return recovery;

  for (const domain of candidates) {
    if (!(await hasLanceTable(domain.storagePath, "publications"))) continue;
    const { LanceIntelligenceStore } = await import("../storage/store.ts");
    if (
      (await LanceIntelligenceStore.hasPublishedWorkspace(
        domain,
        workspaceId(domain),
      )) ||
      (await LanceIntelligenceStore.hasPublishedSyntheticCheckout(
        domain,
        checkout,
      ))
    )
      return domain;
  }
  return undefined;
}

export async function selectExistingStorageDomain(
  preferred: StorageDomain,
  legacy: StorageDomain,
  checkoutRoot: string,
  workspaceId: (domain: StorageDomain) => Promise<string>,
  syntheticCheckout?: { repositoryId: string; revisionId: string },
): Promise<StorageDomain> {
  const { readRefreshStateForCheckout } =
    await import("../mutation/experimental-deferred-refresh.ts");
  const state = await readRefreshStateForCheckout(checkoutRoot);
  if (state?.storageScope === sha256(preferred.domainId)) return preferred;
  if (state?.storageScope === sha256(legacy.domainId)) return legacy;
  if (!(await hasLanceTable(legacy.storagePath, "publications")))
    return preferred;

  const { LanceIntelligenceStore } = await import("../storage/store.ts");
  const hasExact = async (domain: StorageDomain) =>
    LanceIntelligenceStore.hasPublishedWorkspace(
      domain,
      await workspaceId(domain),
    );
  const exactLegacy = await hasExact(legacy);
  if (!exactLegacy && !syntheticCheckout) return preferred;
  const preferredExists = await hasLanceTable(
    preferred.storagePath,
    "publications",
  );
  if (preferredExists && (await hasExact(preferred))) return preferred;
  if (exactLegacy) return legacy;

  if (!syntheticCheckout) return preferred;
  const hasSynthetic = (domain: StorageDomain) =>
    LanceIntelligenceStore.hasPublishedSyntheticCheckout(
      domain,
      syntheticCheckout,
    );
  if (preferredExists && (await hasSynthetic(preferred))) return preferred;
  return (await hasSynthetic(legacy)) ? legacy : preferred;
}

/** Keep reserved checkout storage and the selected domain out of source scans. */
export function managedStorageFilter(
  checkoutRoot: string,
  storagePath?: string,
): (filePath: string) => boolean {
  const reserved = path.join(checkoutRoot, ".ast-mcp");
  const active =
    storagePath !== undefined &&
    path.relative(checkoutRoot, storagePath) !== "" &&
    pathWithin(checkoutRoot, storagePath)
      ? storagePath
      : undefined;
  return (filePath) => {
    const absolute = path.resolve(checkoutRoot, filePath);
    return (
      pathWithin(reserved, absolute) ||
      (active !== undefined && pathWithin(active, absolute))
    );
  };
}

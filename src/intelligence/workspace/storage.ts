import os from "node:os";
import path from "node:path";

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

function globalStorageRoot(options: StorageResolutionOptions): string {
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
): StorageDomain {
  const placement = StoragePlacementSchema.parse(input);
  const storagePath =
    placement.kind === "global"
      ? path.join(globalStorageRoot(options), "ast-mcp", "intelligence")
      : placement.kind === "local"
        ? path.join(repositoryAnchor, ".ast-mcp", "intelligence")
        : placement.kind === "parent"
          ? path.join(
              parentAnchor(repositoryAnchor, placement.levels),
              ".ast-mcp",
              "intelligence",
            )
          : path.resolve(placement.path);
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

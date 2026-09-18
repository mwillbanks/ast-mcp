import { createHash } from "node:crypto";

import {
  documentCapabilities,
  documentCapabilityFingerprint,
} from "./documents/manifest.ts";
import { dynamicLanguageGroupManifest } from "./languages/dynamic/manifest.ts";
import { deepFreeze } from "./languages/immutable.ts";
import { infraLanguageGroupManifest } from "./languages/infra/manifest.ts";
import { jvmLanguageGroupManifest } from "./languages/jvm/manifest.ts";
import { legacyLanguageGroupManifest } from "./languages/legacy/manifest.ts";
import { projectLanguageGroupManifest } from "./languages/project/manifest.ts";
import { systemsLanguageGroupManifest } from "./languages/systems/manifest.ts";
import { webLanguageGroupManifest } from "./languages/web/manifest.ts";

export interface IntelligenceManifestEntry {
  capability: Readonly<Record<string, unknown>>;
  extensions: readonly string[];
  fingerprint: string;
  id: string;
  kind: "document" | "language" | "project";
  providerGroup: string;
}

export interface IntelligenceManifestRegistry {
  entries: readonly IntelligenceManifestEntry[];
  fingerprint: string;
  schemaVersion: "ast-mcp.intelligence-manifest-registry.v1";
}

type AdapterGroup = {
  readonly adapters: readonly {
    readonly capability: Readonly<Record<string, unknown>>;
    readonly extensions: readonly string[];
    readonly languageId: string;
  }[];
  readonly groupId: string;
  readonly implementationFingerprint: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createIntelligenceManifestRegistry(
  groups: readonly AdapterGroup[],
  extraEntries: readonly IntelligenceManifestEntry[] = [],
): IntelligenceManifestRegistry {
  const entries: IntelligenceManifestEntry[] = [];
  for (const group of groups) {
    if (!/^[a-f0-9]{64}$/.test(group.implementationFingerprint))
      throw new Error("invalid_manifest_fingerprint");
    for (const adapter of group.adapters) {
      entries.push({
        capability: adapter.capability,
        extensions: [...adapter.extensions],
        fingerprint: group.implementationFingerprint,
        id: `language:${adapter.languageId}`,
        kind: "language",
        providerGroup: group.groupId,
      });
    }
  }
  entries.push(...extraEntries);
  entries.sort((left, right) => left.id.localeCompare(right.id));
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id))
      throw new Error(`duplicate_manifest_id:${entry.id}`);
    seenIds.add(entry.id);
    if (
      !entry.extensions.length ||
      entry.extensions.some((item) => !item.trim())
    )
      throw new Error(`invalid_manifest_extensions:${entry.id}`);
    if (!/^[a-f0-9]{64}$/.test(entry.fingerprint))
      throw new Error(`invalid_manifest_fingerprint:${entry.id}`);
  }
  const fingerprint = sha256(JSON.stringify(entries));
  return deepFreeze({
    entries,
    fingerprint,
    schemaVersion: "ast-mcp.intelligence-manifest-registry.v1",
  });
}

const projectEntries: IntelligenceManifestEntry[] =
  projectLanguageGroupManifest.capabilities.map((capability) => ({
    capability: capability as unknown as Readonly<Record<string, unknown>>,
    extensions: capability.extensions,
    fingerprint: projectLanguageGroupManifest.implementationFingerprint,
    id: `project:${capability.format}`,
    kind: "project",
    providerGroup: projectLanguageGroupManifest.groupId,
  }));

const documentEntries: IntelligenceManifestEntry[] = documentCapabilities.map(
  (capability) => ({
    capability: capability as unknown as Readonly<Record<string, unknown>>,
    extensions: [
      capability.format === "markdown" ? ".md" : `.${capability.format}`,
    ],
    fingerprint: documentCapabilityFingerprint,
    id: `document:${capability.format}`,
    kind: "document",
    providerGroup: "documents",
  }),
);

export const acceptedIntelligenceManifestRegistry =
  createIntelligenceManifestRegistry(
    [
      webLanguageGroupManifest,
      dynamicLanguageGroupManifest,
      infraLanguageGroupManifest,
      jvmLanguageGroupManifest,
      legacyLanguageGroupManifest,
      systemsLanguageGroupManifest,
    ] as readonly AdapterGroup[],
    [...projectEntries, ...documentEntries],
  );

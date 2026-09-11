import { INTELLIGENCE_SCHEMA_VERSION } from "../../contracts/common.ts";
import {
  type CapabilityClaim,
  LanguageCapabilitySchema,
} from "../../contracts/language.ts";
import { sha256 } from "../../parser/index.ts";
import {
  analyzeLegacyLanguage,
  legacyExtractorFingerprint,
} from "./analyzer.ts";
import type {
  LegacyLanguageAdapter,
  LegacyLanguageGroupManifest,
  LegacyLanguageId,
} from "./types.ts";

export const GRAPHIFY_LEGACY_BASELINE_REVISION =
  "3f82bf7f837a07fb0f7668fbdbd5662801906942";

const extensions: Record<LegacyLanguageId, readonly string[]> = {
  "common-lisp": [".lisp", ".lsp", ".cl"],
  dreammaker: [".dm", ".dme"],
  ocaml: [".ml", ".mli"],
  pascal: [".pas", ".pp", ".dpr"],
  "robot-framework": [".robot", ".resource"],
};

function unsupported(message: string): CapabilityClaim {
  return {
    implementationFingerprint: null,
    limitations: [message],
    provider: "none",
    status: "unsupported",
  };
}
function partial(languageId: LegacyLanguageId): CapabilityClaim {
  const treeSitter = languageId === "ocaml" || languageId === "common-lisp";
  return {
    implementationFingerprint: legacyExtractorFingerprint,
    limitations: [
      treeSitter
        ? "Tree-sitter syntax facts exclude environment-dependent resolution"
        : "The custom structured parser covers documented declarations, calls, dependencies, and bindings",
    ],
    provider: treeSitter ? "tree-sitter" : "custom",
    status: "partial",
  };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const legacyLanguageAdapters = deepFreeze(
  (Object.keys(extensions) as LegacyLanguageId[]).map(
    (languageId): LegacyLanguageAdapter => {
      const noResolution = unsupported(
        "Environment-dependent resolution is unavailable",
      );
      const structure = partial(languageId);
      return {
        analyze: analyzeLegacyLanguage,
        available: true,
        capability: LanguageCapabilitySchema.parse({
          callResolution: noResolution,
          embeddedLanguageIds: [],
          embeddedLanguages: unsupported(
            "No embedded-language boundary is available",
          ),
          exportResolution: noResolution,
          extensions: [...extensions[languageId]],
          importResolution: noResolution,
          inheritanceResolution: noResolution,
          languageId,
          match: unsupported(
            "The parser provider does not expose ast-grep matching",
          ),
          parse: structure,
          rewrite: unsupported(
            "The parser provider does not expose structural rewriting",
          ),
          schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
          structuralRead: structure,
          structuredParser: { mode: "none" },
          symbolExtraction: structure,
        }),
        extensions: extensions[languageId],
        languageId,
        unavailableReason: null,
      };
    },
  ),
);

export function legacyLanguageAdapter(
  languageId: LegacyLanguageId,
): LegacyLanguageAdapter {
  const adapter = legacyLanguageAdapters.find(
    (candidate) => candidate.languageId === languageId,
  );
  if (!adapter)
    throw new TypeError(`Unsupported legacy language: ${languageId}`);
  return adapter;
}

export const legacyLanguageGroupManifest: LegacyLanguageGroupManifest =
  deepFreeze({
    adapters: legacyLanguageAdapters,
    groupId: "legacy",
    implementationFingerprint: sha256(
      JSON.stringify(
        legacyLanguageAdapters.map((adapter) => [
          adapter.languageId,
          adapter.extensions,
          adapter.capability,
        ]),
      ),
    ),
    provenance: { graphifyRevision: GRAPHIFY_LEGACY_BASELINE_REVISION },
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
  });

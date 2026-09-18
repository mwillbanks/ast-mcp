import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { type Lang, registerDynamicLanguage } from "@ast-grep/napi";

import { INTELLIGENCE_SCHEMA_VERSION } from "../contracts/common.ts";
import {
  type LanguageCapability,
  LanguageCapabilitySchema,
} from "../contracts/language.ts";
import { sha256 } from "./coordinates.ts";
import {
  LANGUAGE_CAPABILITY_CATALOG,
  type LanguageCatalogEntry,
  PINNED_GRAMMAR_REGISTRATIONS,
} from "./language-catalog.ts";
import type { ParserLanguageId } from "./types.ts";

export const DEFAULT_EXTRACTOR_VERSION = "ast-mcp.ts-js.v1";

export interface DynamicGrammarAsset {
  expandoChar?: string;
  languageSymbol?: string;
  libraryPath: string;
  metaVarChar?: string;
  sha256: string;
}

export interface GrammarDescriptor {
  astGrepLanguage: Lang | string;
  dynamicAsset: DynamicGrammarAsset | null;
  extensions: readonly string[];
  grammarFingerprint: string;
  grammarVersion: string;
  languageId: ParserLanguageId;
}

export interface DynamicGrammarManifestEntry {
  descriptor: GrammarDescriptor;
  implementation: LanguageImplementation;
}

export interface DynamicGrammarManifest {
  entries: readonly DynamicGrammarManifestEntry[];
  fingerprint: string;
  schemaVersion: "ast-mcp.dynamic-grammars.v1";
}

export interface LanguageImplementation {
  callResolution: boolean;
  embeddedLanguages: boolean;
  exportResolution: boolean;
  importResolution: boolean;
  inheritanceResolution: boolean;
  match: boolean;
  parse: boolean;
  rewrite: boolean;
  structuralRead: boolean;
  symbolExtraction: boolean;
}

const fingerprint = (value: unknown): string => sha256(JSON.stringify(value));

export function snapshotDynamicGrammarManifest(
  manifest: DynamicGrammarManifest,
): DynamicGrammarManifest {
  let cloned: DynamicGrammarManifest;
  try {
    cloned = structuredClone(manifest);
  } catch {
    throw new TypeError("Dynamic grammar manifest must be cloneable");
  }
  if (cloned.schemaVersion !== "ast-mcp.dynamic-grammars.v1") {
    throw new TypeError("Unsupported dynamic grammar manifest version");
  }
  if (!Array.isArray(cloned.entries)) {
    throw new TypeError("Dynamic grammar manifest entries must be an array");
  }
  if (!/^[a-f0-9]{64}$/.test(cloned.fingerprint)) {
    throw new TypeError("Dynamic grammar manifest fingerprint is invalid");
  }
  if (fingerprint(cloned.entries) !== cloned.fingerprint) {
    throw new TypeError("Dynamic grammar manifest fingerprint mismatch");
  }
  const entries = cloned.entries.map((entry) => {
    if (!entry.descriptor.dynamicAsset) {
      throw new TypeError("Dynamic grammar manifest entry requires an asset");
    }
    return Object.freeze({
      descriptor: Object.freeze({
        ...entry.descriptor,
        dynamicAsset: Object.freeze({ ...entry.descriptor.dynamicAsset }),
        extensions: Object.freeze([...entry.descriptor.extensions]),
      }),
      implementation: Object.freeze({ ...entry.implementation }),
    });
  });
  return Object.freeze({
    entries: Object.freeze(entries),
    fingerprint: cloned.fingerprint,
    schemaVersion: cloned.schemaVersion,
  });
}

function catalogGrammar(entry: LanguageCatalogEntry): GrammarDescriptor {
  return {
    astGrepLanguage: entry.astGrepLanguage,
    dynamicAsset: null,
    extensions: entry.extensions,
    grammarFingerprint: fingerprint({
      astGrepLanguage: entry.astGrepLanguage,
      extensions: [...entry.extensions],
      grammarVersion: entry.grammarVersion,
      languageId: entry.languageId,
    }),
    grammarVersion: entry.grammarVersion,
    languageId: entry.languageId,
  };
}

const CATALOG_GRAMMARS = LANGUAGE_CAPABILITY_CATALOG.map(catalogGrammar);
const registeredPinnedGrammarFingerprints = new WeakMap<
  typeof registerDynamicLanguage,
  string
>();
const registeredDynamicGrammarFingerprints = new WeakMap<
  typeof registerDynamicLanguage,
  string
>();

const implementationFor = (
  entry: LanguageCatalogEntry,
): LanguageImplementation => ({
  callResolution: false,
  embeddedLanguages: false,
  exportResolution: false,
  importResolution: false,
  inheritanceResolution: false,
  match: entry.structuralOperations.match,
  parse: entry.structuralOperations.parse,
  rewrite: entry.structuralOperations.rewrite,
  structuralRead: entry.structuralOperations.structuralRead,
  symbolExtraction: entry.analysis.symbolExtraction,
});

const unsupported = (limitation: string) => ({
  implementationFingerprint: null,
  limitations: [limitation],
  provider: "none" as const,
  status: "unsupported" as const,
});

const supported = (
  provider: "ast-grep" | "custom",
  implementationFingerprint: string,
) => ({
  implementationFingerprint,
  limitations: [],
  provider,
  status: "supported" as const,
});

export class LanguageRegistry {
  readonly #dynamicRegistrar: typeof registerDynamicLanguage;
  readonly #grammars = new Map<ParserLanguageId, GrammarDescriptor>(
    CATALOG_GRAMMARS.map((grammar) => [grammar.languageId, grammar]),
  );
  readonly #implementations = new Map<ParserLanguageId, LanguageImplementation>(
    LANGUAGE_CAPABILITY_CATALOG.map((entry) => [
      entry.languageId,
      implementationFor(entry),
    ]),
  );
  #dynamicRegistered = false;

  constructor(
    dynamicRegistrar: typeof registerDynamicLanguage = registerDynamicLanguage,
  ) {
    this.#dynamicRegistrar = dynamicRegistrar;
  }

  get(languageId: ParserLanguageId): GrammarDescriptor {
    const grammar = this.#grammars.get(languageId);
    if (!grammar)
      throw new TypeError(`Unsupported parser language: ${languageId}`);
    return grammar;
  }

  list(): GrammarDescriptor[] {
    return [...this.#grammars.values()].sort((left, right) =>
      left.languageId.localeCompare(right.languageId),
    );
  }

  capabilities(languageId: ParserLanguageId): LanguageCapability {
    const grammar = this.get(languageId);
    const implementation = this.#implementations.get(languageId);
    if (!implementation) throw new TypeError("Missing language implementation");
    const extractionFingerprint = fingerprint({
      extractor: DEFAULT_EXTRACTOR_VERSION,
      languageId,
    });
    const parseClaim = supported("ast-grep", grammar.grammarFingerprint);
    const extractionClaim = implementation.symbolExtraction
      ? supported("custom", extractionFingerprint)
      : unsupported("This adapter does not extract code symbols");
    return this.assertHonest(languageId, {
      callResolution: unsupported(
        "Call resolution requires an environment-specific resolver",
      ),
      embeddedLanguageIds: [],
      embeddedLanguages: unsupported(
        "No embedded-language extractor is registered",
      ),
      exportResolution: unsupported(
        "Export resolution requires an environment-specific resolver",
      ),
      extensions: [...grammar.extensions],
      importResolution: unsupported(
        "Import resolution requires an environment-specific resolver",
      ),
      inheritanceResolution: unsupported(
        "Inheritance resolution requires an environment-specific resolver",
      ),
      languageId,
      match: parseClaim,
      parse: parseClaim,
      rewrite: parseClaim,
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      structuralRead: parseClaim,
      structuredParser: { mode: "none" },
      symbolExtraction: extractionClaim,
    });
  }

  assertHonest(
    languageId: ParserLanguageId,
    claim: LanguageCapability,
  ): LanguageCapability {
    const parsed = LanguageCapabilitySchema.parse(claim);
    const implementation = this.#implementations.get(languageId);
    if (!implementation) throw new TypeError("Missing language implementation");
    const checks: Array<
      [keyof LanguageImplementation, keyof LanguageCapability]
    > = [
      ["parse", "parse"],
      ["structuralRead", "structuralRead"],
      ["match", "match"],
      ["rewrite", "rewrite"],
      ["symbolExtraction", "symbolExtraction"],
      ["importResolution", "importResolution"],
      ["exportResolution", "exportResolution"],
      ["callResolution", "callResolution"],
      ["inheritanceResolution", "inheritanceResolution"],
      ["embeddedLanguages", "embeddedLanguages"],
    ];
    for (const [implementationKey, claimKey] of checks) {
      const advertised = parsed[claimKey] as LanguageCapability["parse"];
      if (
        !implementation[implementationKey] &&
        advertised.status !== "unsupported"
      ) {
        throw new TypeError(
          `Capability ${String(claimKey)} has no registered implementation`,
        );
      }
      if (
        implementation[implementationKey] &&
        advertised.status === "unsupported"
      ) {
        throw new TypeError(
          `Capability ${String(claimKey)} hides a registered implementation`,
        );
      }
    }
    return parsed;
  }

  async addDynamic(
    descriptor: Omit<GrammarDescriptor, "grammarFingerprint"> & {
      grammarFingerprint?: string;
    },
    implementation: LanguageImplementation,
  ): Promise<void> {
    if (this.#dynamicRegistered) {
      throw new TypeError("Dynamic grammars must be configured before parsing");
    }
    if (this.#grammars.has(descriptor.languageId)) {
      throw new TypeError(
        `Parser language is already registered: ${descriptor.languageId}`,
      );
    }
    if (!descriptor.dynamicAsset) {
      throw new TypeError("Dynamic grammars require a native library asset");
    }
    await validateGrammarAsset(descriptor.dynamicAsset);
    const dynamicAsset = {
      expandoChar: descriptor.dynamicAsset.expandoChar ?? null,
      languageSymbol: descriptor.dynamicAsset.languageSymbol ?? null,
      libraryPath: resolve(descriptor.dynamicAsset.libraryPath),
      metaVarChar: descriptor.dynamicAsset.metaVarChar ?? null,
      sha256: descriptor.dynamicAsset.sha256,
    };
    const computed = fingerprint({
      astGrepLanguage: descriptor.astGrepLanguage,
      dynamicAsset,
      extensions: [...descriptor.extensions],
      grammarVersion: descriptor.grammarVersion,
      languageId: descriptor.languageId,
    });
    if (
      descriptor.grammarFingerprint &&
      descriptor.grammarFingerprint !== computed
    ) {
      throw new TypeError(
        "Dynamic grammar fingerprint does not match its asset",
      );
    }
    this.#grammars.set(descriptor.languageId, {
      ...descriptor,
      dynamicAsset: {
        ...descriptor.dynamicAsset,
        libraryPath: dynamicAsset.libraryPath,
      },
      grammarFingerprint: computed,
    });
    this.#implementations.set(descriptor.languageId, implementation);
  }

  dynamicManifest(): DynamicGrammarManifest {
    const entries = [...this.#grammars.values()]
      .filter((grammar) => grammar.dynamicAsset !== null)
      .sort((left, right) => left.languageId.localeCompare(right.languageId))
      .map((grammar) => {
        const implementation = this.#implementations.get(grammar.languageId);
        if (!implementation)
          throw new TypeError("Missing language implementation");
        const dynamicAsset = grammar.dynamicAsset;
        if (!dynamicAsset) throw new TypeError("Missing dynamic grammar asset");
        const descriptor = Object.freeze({
          ...grammar,
          dynamicAsset: Object.freeze({ ...dynamicAsset }),
          extensions: Object.freeze([...grammar.extensions]),
        });
        return Object.freeze({
          descriptor,
          implementation: Object.freeze({ ...implementation }),
        });
      });
    const immutableEntries = Object.freeze(entries);
    return snapshotDynamicGrammarManifest({
      entries: immutableEntries,
      fingerprint: fingerprint(immutableEntries),
      schemaVersion: "ast-mcp.dynamic-grammars.v1",
    });
  }

  async loadDynamicManifest(manifest: DynamicGrammarManifest): Promise<void> {
    const snapshot = snapshotDynamicGrammarManifest(manifest);
    for (const entry of snapshot.entries) {
      await this.addDynamic(entry.descriptor, entry.implementation);
    }
  }

  registerDynamicGrammars(): void {
    if (this.#dynamicRegistered) return;
    const pinnedFingerprint = fingerprint(PINNED_GRAMMAR_REGISTRATIONS);
    const registeredPinnedFingerprint = registeredPinnedGrammarFingerprints.get(
      this.#dynamicRegistrar,
    );
    if (registeredPinnedFingerprint === undefined) {
      this.#dynamicRegistrar(PINNED_GRAMMAR_REGISTRATIONS);
      registeredPinnedGrammarFingerprints.set(
        this.#dynamicRegistrar,
        pinnedFingerprint,
      );
    } else if (registeredPinnedFingerprint !== pinnedFingerprint) {
      throw new TypeError(
        "A different pinned grammar set is already registered in this process",
      );
    }

    const registrations: Record<
      string,
      {
        libraryPath: string;
        extensions: string[];
        languageSymbol?: string;
        metaVarChar?: string;
        expandoChar?: string;
      }
    > = {};
    for (const grammar of this.#grammars.values()) {
      if (!grammar.dynamicAsset) continue;
      registrations[grammar.astGrepLanguage] = {
        extensions: [...grammar.extensions],
        libraryPath: resolve(grammar.dynamicAsset.libraryPath),
        ...(grammar.dynamicAsset.languageSymbol
          ? { languageSymbol: grammar.dynamicAsset.languageSymbol }
          : {}),
        ...(grammar.dynamicAsset.metaVarChar
          ? { metaVarChar: grammar.dynamicAsset.metaVarChar }
          : {}),
        ...(grammar.dynamicAsset.expandoChar
          ? { expandoChar: grammar.dynamicAsset.expandoChar }
          : {}),
      };
    }
    if (Object.keys(registrations).length > 0) {
      const registrationFingerprint = fingerprint(registrations);
      const registeredDynamicGrammarFingerprint =
        registeredDynamicGrammarFingerprints.get(this.#dynamicRegistrar);
      if (registeredDynamicGrammarFingerprint === undefined) {
        this.#dynamicRegistrar(registrations);
        registeredDynamicGrammarFingerprints.set(
          this.#dynamicRegistrar,
          registrationFingerprint,
        );
      } else if (
        registeredDynamicGrammarFingerprint !== registrationFingerprint
      ) {
        throw new TypeError(
          "A different dynamic grammar set is already registered in this process",
        );
      }
    }
    this.#dynamicRegistered = true;
  }
}

export async function validateGrammarAsset(
  asset: DynamicGrammarAsset,
): Promise<void> {
  if (!isAbsolute(asset.libraryPath)) {
    throw new TypeError("Dynamic grammar library path must be absolute");
  }
  if (!/\.(?:dylib|dll|node|so)$/i.test(asset.libraryPath)) {
    throw new TypeError(
      "Dynamic grammar asset must use a native library filename",
    );
  }
  const metadata = await stat(asset.libraryPath);
  if (!metadata.isFile()) {
    throw new TypeError("Dynamic grammar asset is not a file");
  }
  const header = new Uint8Array(
    await Bun.file(asset.libraryPath).slice(0, 4).arrayBuffer(),
  );
  const magic = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  ).getUint32(0);
  const recognized =
    magic === 0x7f454c46 ||
    (header[0] === 0x4d && header[1] === 0x5a) ||
    magic === 0xcafebabe ||
    magic === 0xbebafeca ||
    magic === 0xcffaedfe ||
    magic === 0xcefaedfe ||
    magic === 0xfeedfacf ||
    magic === 0xfeedface;
  if (!recognized) {
    throw new TypeError(
      "Dynamic grammar asset is not a recognized native library",
    );
  }
  const digest = new Bun.CryptoHasher("sha256");
  digest.update(await Bun.file(asset.libraryPath).arrayBuffer());
  if (digest.digest("hex") !== asset.sha256) {
    throw new TypeError("Dynamic grammar asset fingerprint mismatch");
  }
}

export const defaultLanguageRegistry = new LanguageRegistry();

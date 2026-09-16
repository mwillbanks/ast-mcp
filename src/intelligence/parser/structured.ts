import { INTELLIGENCE_SCHEMA_VERSION } from "../contracts/common.ts";
import {
  type CapabilityClaim,
  type LanguageCapability,
  LanguageCapabilitySchema,
} from "../contracts/language.ts";

export type StructuredDocumentFormat =
  | "json"
  | "jsonc"
  | "yaml"
  | "toml"
  | "markdown"
  | "rtf";

export interface StructuredParserAdapter<T = unknown> {
  extensions: readonly string[];
  format: StructuredDocumentFormat;
  implementationFingerprint: string;
  languageId: string;
  match?: (document: T, query: unknown) => readonly unknown[];
  parse: (source: string) => T | Promise<T>;
  preservesComments: boolean;
  rewrite?: (document: T, edits: readonly unknown[]) => string;
  structuralRead: (document: T, selector: string) => unknown;
}

const unsupported = (message: string): CapabilityClaim => ({
  implementationFingerprint: null,
  limitations: [message],
  provider: "none",
  status: "unsupported",
});

const implemented = (adapter: StructuredParserAdapter): CapabilityClaim => ({
  implementationFingerprint: adapter.implementationFingerprint,
  limitations: [],
  provider: "structured-parser",
  status: "supported",
});

export class StructuredParserRegistry {
  readonly #adapters: Map<string, StructuredParserAdapter>;

  constructor() {
    this.#adapters = new Map();
  }

  register(adapter: StructuredParserAdapter): void {
    if (
      !/^[a-f0-9]{64}$/.test(adapter.implementationFingerprint) ||
      adapter.languageId.trim().length === 0 ||
      adapter.extensions.length === 0
    ) {
      throw new TypeError(
        "Structured parser adapters require an identity, extensions, and a SHA-256 fingerprint",
      );
    }
    if (this.#adapters.has(adapter.languageId)) {
      throw new TypeError(
        `Structured parser adapter is already registered: ${adapter.languageId}`,
      );
    }
    this.#adapters.set(adapter.languageId, adapter);
  }

  get(languageId: string): StructuredParserAdapter {
    const adapter = this.#adapters.get(languageId);
    if (!adapter) {
      throw new TypeError(
        `Unsupported structured parser language: ${languageId}`,
      );
    }
    return adapter;
  }

  capabilities(languageId: string): LanguageCapability {
    const adapter = this.get(languageId);
    const parse = implemented(adapter);
    return LanguageCapabilitySchema.parse({
      callResolution: unsupported(
        "Structured documents do not provide call resolution",
      ),
      embeddedLanguageIds: [],
      embeddedLanguages: unsupported(
        "No embedded-language adapter is registered",
      ),
      exportResolution: unsupported(
        "Structured documents do not provide export resolution",
      ),
      extensions: [...adapter.extensions],
      importResolution: unsupported(
        "Structured documents do not provide import resolution",
      ),
      inheritanceResolution: unsupported(
        "Structured documents do not provide inheritance resolution",
      ),
      languageId,
      match: adapter.match
        ? implemented(adapter)
        : unsupported("This structured parser has no match implementation"),
      parse,
      rewrite: adapter.rewrite
        ? implemented(adapter)
        : unsupported("This structured parser has no rewrite implementation"),
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      structuralRead: parse,
      structuredParser: {
        formats: [adapter.format],
        mode: "native",
        preservesComments: adapter.preservesComments,
      },
      symbolExtraction: unsupported(
        "This structured parser does not extract code symbols",
      ),
    });
  }

  parse(languageId: string, source: string): Promise<unknown> {
    return Promise.resolve(this.get(languageId).parse(source));
  }

  list(): string[] {
    return [...this.#adapters.keys()].sort();
  }
}

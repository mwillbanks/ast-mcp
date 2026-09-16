import path from "node:path";
import {
  analyzeDocument,
  type DocumentFacts,
  type DocumentFormat,
} from "../documents/index.ts";
import {
  closeDynamicLanguageWorker,
  drainDynamicLanguageWorker,
  dynamicLanguageAdapters,
} from "../languages/dynamic/index.ts";
import { infraLanguageAdapters } from "../languages/infra/index.ts";
import {
  closeInfraLanguageWorker,
  drainInfraLanguageWorker,
} from "../languages/infra/worker-client.ts";
import {
  closeJvmLanguageWorker,
  drainJvmLanguageWorker,
  jvmLanguageAdapters,
} from "../languages/jvm/index.ts";
import {
  closeLegacyLanguageWorker,
  drainLegacyLanguageWorker,
  legacyLanguageAdapters,
} from "../languages/legacy/index.ts";
import {
  analyzeProjectFormat,
  type ProjectFacts,
  type ProjectFormatId,
  projectFormatCapabilities,
} from "../languages/project/index.ts";
import {
  closeSystemsLanguageWorker,
  drainSystemsLanguageWorker,
  systemsLanguageAdapters,
} from "../languages/systems/index.ts";
import {
  type WebLanguageAnalysis,
  webLanguageAdapters,
} from "../languages/web/index.ts";
import {
  defaultLanguageRegistry,
  type ParserLanguageId,
  type ParseSourceRequest,
  type SyntaxFacts,
} from "../parser/index.ts";

const DOCUMENT_FORMATS: Readonly<Record<string, DocumentFormat>> = {
  ".htm": "html",
  ".html": "html",
  ".json": "json",
  ".jsonc": "jsonc",
  ".md": "markdown",
  ".mdx": "mdx",
  ".rtf": "rtf",
  ".toml": "toml",
  ".txt": "txt",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
};

export type IntelligenceAnalysis =
  | {
      facts: SyntaxFacts;
      group:
        | "dynamic"
        | "infra"
        | "jvm"
        | "legacy"
        | "systems"
        | "web"
        | "parser";
      kind: "code";
      languageId: string;
      web?: WebLanguageAnalysis;
    }
  | {
      facts: DocumentFacts;
      format: DocumentFormat;
      group: "document";
      kind: "document";
    }
  | {
      facts: ProjectFacts;
      format: ProjectFormatId;
      group: "project";
      kind: "project";
    };

export interface IntelligenceDispatchRequest {
  filePath: string;
  signal?: AbortSignal;
  source: string;
}

export interface IntelligenceSourceDispatcherOptions {
  parse: (
    request: ParseSourceRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<SyntaxFacts>;
}

function matchingExtension(
  filePath: string,
  extensions: readonly string[],
): string | null {
  const name = path.basename(filePath).toLowerCase();
  return (
    [...extensions]
      .sort((left, right) => right.length - left.length)
      .find((extension) => name.endsWith(extension.toLowerCase())) ?? null
  );
}

function projectFormatFor(filePath: string): ProjectFormatId | null {
  const candidates = projectFormatCapabilities
    .flatMap((capability) =>
      capability.extensions.map((extension) => ({
        extension,
        format: capability.format,
      })),
    )
    .sort((left, right) => right.extension.length - left.extension.length);
  return (
    candidates.find(({ extension }) => matchingExtension(filePath, [extension]))
      ?.format ?? null
  );
}

function documentFormatFor(filePath: string): DocumentFormat | null {
  return DOCUMENT_FORMATS[path.extname(filePath).toLowerCase()] ?? null;
}

export function supportsIntelligenceSource(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return (
    projectFormatFor(filePath) !== null ||
    webLanguageAdapters.some((adapter) =>
      matchingExtension(filePath, adapter.extensions),
    ) ||
    dynamicLanguageAdapters.some((adapter) =>
      matchingExtension(filePath, adapter.extensions),
    ) ||
    infraLanguageAdapters.some((adapter) =>
      matchingExtension(filePath, adapter.extensions),
    ) ||
    jvmLanguageAdapters.some((adapter) =>
      matchingExtension(filePath, adapter.extensions),
    ) ||
    legacyLanguageAdapters.some((adapter) =>
      matchingExtension(filePath, adapter.extensions),
    ) ||
    systemsLanguageAdapters.some((adapter) =>
      matchingExtension(filePath, adapter.extensions),
    ) ||
    documentFormatFor(filePath) !== null ||
    defaultLanguageRegistry
      .list()
      .some((candidate) => candidate.extensions.includes(extension))
  );
}

let activeDispatcherLeases = 0;
let dispatcherShutdown: Promise<void> | null = null;

async function drainLanguageWorkers(): Promise<void> {
  await Promise.all([
    drainDynamicLanguageWorker(),
    drainInfraLanguageWorker(),
    drainJvmLanguageWorker(),
    drainLegacyLanguageWorker(),
    drainSystemsLanguageWorker(),
  ]);
}

async function closeLanguageWorkers(): Promise<void> {
  await drainLanguageWorkers();
  await Promise.all([
    closeDynamicLanguageWorker(),
    closeInfraLanguageWorker(),
    closeJvmLanguageWorker(),
    closeLegacyLanguageWorker(),
    closeSystemsLanguageWorker(),
  ]);
}

function acquireDispatcherLease(): Promise<void> {
  activeDispatcherLeases += 1;
  return dispatcherShutdown ?? Promise.resolve();
}

async function releaseDispatcherLease(ready: Promise<void>): Promise<void> {
  await ready;
  activeDispatcherLeases = Math.max(0, activeDispatcherLeases - 1);
  if (activeDispatcherLeases > 0) return;
  const shutdown = closeLanguageWorkers();
  dispatcherShutdown = shutdown;
  try {
    await shutdown;
  } finally {
    if (dispatcherShutdown === shutdown) dispatcherShutdown = null;
  }
}

export class IntelligenceSourceDispatcher {
  readonly #leaseReady: Promise<void>;
  readonly #parse: IntelligenceSourceDispatcherOptions["parse"];
  #closed = false;

  constructor(options: IntelligenceSourceDispatcherOptions) {
    this.#parse = options.parse;
    this.#leaseReady = acquireDispatcherLease();
  }

  // fallow-ignore-next-line unused-class-member
  supports(filePath: string): boolean {
    return supportsIntelligenceSource(filePath);
  }

  async analyze(
    request: IntelligenceDispatchRequest,
  ): Promise<IntelligenceAnalysis | null> {
    if (this.#closed) throw new Error("intelligence_dispatcher_closed");
    await this.#leaseReady;
    const { filePath, signal, source } = request;

    const projectFormat = projectFormatFor(filePath);
    if (projectFormat) {
      return {
        facts: analyzeProjectFormat({
          format: projectFormat,
          source,
          sourcePath: filePath,
        }),
        format: projectFormat,
        group: "project",
        kind: "project",
      };
    }

    const web = webLanguageAdapters.find((adapter) =>
      matchingExtension(filePath, adapter.extensions),
    );
    if (web) {
      const analysis = await web.analyze({
        fileName: filePath,
        languageId: web.languageId,
        source,
      });
      return {
        facts: analysis.facts,
        group: "web",
        kind: "code",
        languageId: web.languageId,
        web: analysis,
      };
    }

    const dynamic = dynamicLanguageAdapters.find((adapter) =>
      matchingExtension(filePath, adapter.extensions),
    );
    if (dynamic) {
      return {
        facts: await dynamic.analyze({
          languageId: dynamic.languageId,
          signal,
          source,
        }),
        group: "dynamic",
        kind: "code",
        languageId: dynamic.languageId,
      };
    }

    const infra = infraLanguageAdapters.find((adapter) =>
      matchingExtension(filePath, adapter.extensions),
    );
    if (infra) {
      return {
        facts: await infra.analyze({
          languageId: infra.languageId,
          signal,
          source,
        }),
        group: "infra",
        kind: "code",
        languageId: infra.languageId,
      };
    }

    const jvm = jvmLanguageAdapters.find((adapter) =>
      matchingExtension(filePath, adapter.extensions),
    );
    if (jvm) {
      return {
        facts: await jvm.analyze({
          languageId: jvm.languageId,
          signal,
          source,
        }),
        group: "jvm",
        kind: "code",
        languageId: jvm.languageId,
      };
    }

    const legacy = legacyLanguageAdapters.find((adapter) =>
      matchingExtension(filePath, adapter.extensions),
    );
    if (legacy) {
      return {
        facts: await legacy.analyze({
          languageId: legacy.languageId,
          signal,
          source,
        }),
        group: "legacy",
        kind: "code",
        languageId: legacy.languageId,
      };
    }

    const systems = systemsLanguageAdapters.find((adapter) =>
      matchingExtension(filePath, adapter.extensions),
    );
    if (systems) {
      return {
        facts: await systems.analyze({
          languageId: systems.languageId,
          signal,
          source,
        }),
        group: "systems",
        kind: "code",
        languageId: systems.languageId,
      };
    }

    const format = documentFormatFor(filePath);
    if (format) {
      return {
        facts: await analyzeDocument({ format, source }),
        format,
        group: "document",
        kind: "document",
      };
    }

    const extension = path.extname(filePath).toLowerCase();
    const grammar = defaultLanguageRegistry
      .list()
      .find((candidate) => candidate.extensions.includes(extension));
    if (!grammar) return null;
    return {
      facts: await this.#parse(
        {
          extractorVersion: "ast-mcp.dispatcher.v1",
          languageId: grammar.languageId as ParserLanguageId,
          source,
        },
        { signal },
      ),
      group: "parser",
      kind: "code",
      languageId: grammar.languageId,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await releaseDispatcherLease(this.#leaseReady);
  }
}

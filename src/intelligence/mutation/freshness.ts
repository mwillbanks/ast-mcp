import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createIdentity,
  resolvedRelationshipsArtifactIdentity,
  revisionManifestArtifactIdentity,
  sourceArtifactIdentity,
  syntaxFactsArtifactIdentity,
} from "../contracts/index.ts";
import {
  analyzeDocument,
  type DocumentFacts,
  type DocumentFormat,
} from "../documents/index.ts";
import { graphFromResolution } from "../graph/from-resolution.ts";
import { LanceGraphRepository } from "../graph/repository.ts";
import type {
  IntelligenceAnalysis,
  IntelligenceDispatchRequest,
} from "../lifecycle/dispatcher.ts";
import {
  defaultLanguageRegistry,
  type ParserLanguageId,
  type ParseSourceRequest,
  parseSource,
  type SyntaxFacts,
  sha256,
} from "../parser/index.ts";
import { materializeResolutionInput } from "../resolution/index.ts";
import type { ResolutionSource } from "../resolution/types.ts";
import {
  type EmbeddingModelConfig,
  type EmbeddingWorkerPool,
  publishChunkEmbeddings,
  type RetrievalChunk,
  retrievalChunkStorageRow,
  syntheticChunkArtifactId,
} from "../retrieval/index.ts";
import type { LanceIntelligenceStore } from "../storage/store.ts";
import type { WorkspaceHandle } from "../workspace/context.ts";
import {
  gitDirtyOverlayId,
  readGitRevisionFile,
  runGitRaw,
} from "../workspace/git.ts";
import type { MutationRefreshResult } from "./types.ts";

const EXTRACTOR_VERSION = "ast-mcp.mutation-refresh.v1";

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

function documentFormatFor(filePath: string): DocumentFormat | null {
  return DOCUMENT_FORMATS[path.extname(filePath).toLowerCase()] ?? null;
}

function languageFor(filePath: string): ParserLanguageId | null {
  const extension = path.extname(filePath).toLowerCase();
  return (
    defaultLanguageRegistry
      .list()
      .find((grammar) => grammar.extensions.includes(extension))?.languageId ??
    null
  );
}

function repositoryRelativePath(
  workspace: WorkspaceHandle,
  filePath: string,
): string {
  const relative = path.relative(workspace.checkoutRoot, filePath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("mutation_path_outside_workspace");
  return relative.split(path.sep).join("/");
}

async function canonicalFilePath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return filePath;
  }
}

function throwIfRefreshAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("intelligence_refresh_aborted");
}

async function repositoryFiles(
  root: string,
  excludedRoot: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  const canonicalExcludedRoot = await canonicalFilePath(excludedRoot);
  const visit = async (directory: string): Promise<void> => {
    throwIfRefreshAborted(signal);
    const entries = await readdir(directory, { withFileTypes: true });
    throwIfRefreshAborted(signal);
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      throwIfRefreshAborted(signal);
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const canonicalCandidate = await canonicalFilePath(candidate);
        if (canonicalCandidate === canonicalExcludedRoot) continue;
        await visit(candidate);
      } else if (entry.isFile()) files.push(candidate);
    }
  };
  await visit(root);
  return files;
}

function uniqueRows(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return [
    ...new Map(rows.map((row) => [String(row.artifact_id), row])).values(),
  ];
}

function documentKind(format: DocumentFormat) {
  if (format === "markdown" || format === "mdx") return "markdown";
  if (format === "txt") return "text";
  if (format === "rtf") return "rtf";
  return "structured";
}

interface RepositorySource {
  absolutePath: string;
  read: () => Promise<string>;
  relativePath: string;
}

interface RevisionSourceSelection {
  skipped: string[];
  sources: RepositorySource[];
}

function retrievalRange(range: {
  end: { column: number; line: number };
  endByte: number;
  start: { column: number; line: number };
  startByte: number;
}) {
  return {
    end: range.end,
    endByte: range.endByte,
    start: range.start,
    startByte: range.startByte,
  };
}

function normalizeSyntaxHierarchy(facts: SyntaxFacts): SyntaxFacts {
  const nodeIds = new Set(facts.nodes.map((node) => node.id));
  const childIds = new Map<string, string[]>();
  for (const node of facts.nodes) childIds.set(node.id, []);
  for (const node of facts.nodes) {
    if (node.parentId === null || !nodeIds.has(node.parentId)) continue;
    childIds.get(node.parentId)?.push(node.id);
  }
  return {
    ...facts,
    nodes: facts.nodes.map((node) => ({
      ...node,
      childIds: [...new Set(childIds.get(node.id) ?? [])].sort(),
    })),
  };
}

function appendSyntaxArtifacts(input: {
  artifactRows: Record<string, unknown>[];
  facts: { sourceDigest: string; syntaxFactsArtifactId: string };
  indexedAt: string;
  languageId: string;
  parserFingerprint: string;
  source: string;
  sourceArtifactId: string;
  syntaxRows: Record<string, unknown>[];
}): void {
  input.artifactRows.push({
    artifact_id: input.sourceArtifactId,
    byte_length: Buffer.byteLength(input.source),
    content_bytes: Buffer.from(input.source),
    content_digest: input.facts.sourceDigest,
    created_at: input.indexedAt,
    kind: "source",
    payload_json: JSON.stringify({ contentDigest: input.facts.sourceDigest }),
  });
  input.syntaxRows.push({
    artifact_id: input.facts.syntaxFactsArtifactId,
    byte_length: Buffer.byteLength(JSON.stringify(input.facts)),
    created_at: input.indexedAt,
    language_id: input.languageId,
    parser_fingerprint: input.parserFingerprint,
    payload_json: JSON.stringify(input.facts),
    source_artifact_id: input.sourceArtifactId,
  });
}

function appendRetrievalChunk(
  chunkInput: Omit<RetrievalChunk, "artifactId">,
  indexedAt: string,
  chunkRows: Record<string, unknown>[],
  retrievalChunks: RetrievalChunk[],
): void {
  const retrievalChunk: RetrievalChunk = {
    ...chunkInput,
    artifactId: syntheticChunkArtifactId(chunkInput),
  };
  chunkRows.push(retrievalChunkStorageRow(retrievalChunk, indexedAt));
  retrievalChunks.push(retrievalChunk);
}

async function runGitListing(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stderr: string; stdout: Uint8Array }> {
  return runGitRaw(root, args, signal, throwIfRefreshAborted);
}

async function revisionPaths(
  workspace: WorkspaceHandle,
  signal?: AbortSignal,
): Promise<{ paths: string[]; skipped: string[] }> {
  throwIfRefreshAborted(signal);
  const index = workspace.selectedRevision.selector.kind === "index";
  const args = index
    ? ["ls-files", "--stage", "-z"]
    : [
        "ls-tree",
        "-r",
        "-z",
        workspace.selectedRevision.resolvedCommitOid as string,
      ];
  const { code, stderr, stdout } = await runGitListing(
    workspace.checkoutRoot,
    args,
    signal,
  );
  if (code !== 0)
    throw Object.assign(
      new Error(stderr.trim() || `Git failed with exit code ${code}`),
      { code: "workspace_git_failure", retryable: false },
    );

  const paths: string[] = [];
  const skipped: string[] = [];
  const zeroOid = /^0+$/;
  const intentToAdd = new Set<string>();
  if (index) {
    throwIfRefreshAborted(signal);
    const {
      code: intentCode,
      stderr: intentError,
      stdout: intentOutput,
    } = await runGitListing(
      workspace.checkoutRoot,
      ["diff", "--name-only", "--diff-filter=A", "-z"],
      signal,
    );
    if (intentCode !== 0)
      throw Object.assign(
        new Error(
          intentError.trim() || `Git failed with exit code ${intentCode}`,
        ),
        { code: "workspace_git_failure", retryable: false },
      );
    for (const candidate of Buffer.from(intentOutput)
      .toString("utf8")
      .split("\0")
      .filter(Boolean))
      intentToAdd.add(candidate);
  }
  for (const record of Buffer.from(stdout)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort()) {
    throwIfRefreshAborted(signal);
    const tab = record.indexOf("\t");
    if (tab < 0) {
      skipped.push(`${record} [git:malformed]`);
      continue;
    }
    const metadata = record.slice(0, tab).split(" ");
    const relativePath = record.slice(tab + 1);
    if (index) {
      const [mode, oid, stage] = metadata;
      if (stage !== "0") {
        skipped.push(
          `${relativePath} [index:unmerged-stage-${stage ?? "unknown"}]`,
        );
        continue;
      }
      if (!oid || zeroOid.test(oid) || intentToAdd.has(relativePath)) {
        skipped.push(`${relativePath} [index:intent-to-add]`);
        continue;
      }
      if (!mode || (!mode.startsWith("100") && mode !== "120000")) {
        skipped.push(`${relativePath} [index:non-blob-${mode ?? "unknown"}]`);
        continue;
      }
      paths.push(relativePath);
      continue;
    }
    const [, type] = metadata;
    if (type !== "blob") {
      skipped.push(`${relativePath} [tree:non-blob-${type ?? "unknown"}]`);
      continue;
    }
    paths.push(relativePath);
  }
  return { paths: [...new Set(paths)].sort(), skipped };
}

async function selectedRevisionSources(
  workspace: WorkspaceHandle,
  signal?: AbortSignal,
  readSource: (filePath: string) => Promise<string> = (filePath) =>
    Bun.file(filePath).text(),
): Promise<RevisionSourceSelection> {
  if (workspace.selectedRevision.selector.kind === "working") {
    const sources: RepositorySource[] = [];
    for (const filePath of await repositoryFiles(
      workspace.checkoutRoot,
      workspace.storageDomain.storagePath,
      signal,
    )) {
      throwIfRefreshAborted(signal);
      const absolutePath = await canonicalFilePath(filePath);
      sources.push({
        absolutePath,
        read: () => readSource(absolutePath),
        relativePath: repositoryRelativePath(workspace, absolutePath),
      });
    }
    return { skipped: [], sources };
  }

  const storageRelative = path.relative(
    workspace.checkoutRoot,
    workspace.storageDomain.storagePath,
  );
  const excludedPrefix =
    storageRelative &&
    storageRelative !== ".." &&
    !storageRelative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(storageRelative)
      ? storageRelative.split(path.sep).join("/")
      : null;
  const sources: RepositorySource[] = [];
  const selection = await revisionPaths(workspace, signal);
  for (const relativePath of selection.paths) {
    throwIfRefreshAborted(signal);
    if (
      relativePath === excludedPrefix ||
      (excludedPrefix && relativePath.startsWith(`${excludedPrefix}/`))
    )
      continue;
    const absolutePath = path.join(workspace.checkoutRoot, relativePath);
    sources.push({
      absolutePath,
      read: async () =>
        Buffer.from(
          await readGitRevisionFile(
            workspace.git,
            workspace.selectedRevision,
            absolutePath,
          ),
        ).toString("utf8"),
      relativePath,
    });
  }
  return { skipped: selection.skipped, sources };
}

export interface IntelligenceRefreshDependencies {
  allowReadOnlySource?: boolean;
  analyze?: (
    request: IntelligenceDispatchRequest,
  ) => Promise<IntelligenceAnalysis | null>;
  embedding?: {
    config: EmbeddingModelConfig;
    pool: EmbeddingWorkerPool;
  };
  parse?: (
    request: ParseSourceRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<SyntaxFacts>;
  readSource?: (filePath: string) => Promise<string>;
  signal?: AbortSignal;
  supports?: (filePath: string) => boolean;
}

export async function refreshMutationIntelligence(
  input: {
    now?: () => Date;
    store: LanceIntelligenceStore;
    workspace: WorkspaceHandle;
  } & IntelligenceRefreshDependencies,
): Promise<MutationRefreshResult> {
  const { store, workspace } = input;
  const indexedAt = (input.now ?? (() => new Date()))().toISOString();
  if (!workspace.writeEligibility.eligible && !input.allowReadOnlySource)
    throw new Error("workspace_read_only");
  const artifactRows: Record<string, unknown>[] = [];
  const syntaxRows: Record<string, unknown>[] = [];
  const chunkRows: Record<string, unknown>[] = [];
  const relationshipRows: Record<string, unknown>[] = [];
  const retrievalChunks: RetrievalChunk[] = [];
  const parsedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const units: Array<
    | {
        facts: ReturnType<typeof parseSource>;
        kind: "code";
        path: string;
        sourceArtifactId: string;
      }
    | {
        facts: DocumentFacts;
        kind: "document";
        path: string;
        sourceArtifactId: string;
      }
    | {
        facts: Extract<IntelligenceAnalysis, { kind: "project" }>["facts"];
        kind: "project";
        path: string;
        sourceArtifactId: string;
      }
  > = [];

  const selection = await selectedRevisionSources(
    workspace,
    input.signal,
    input.readSource,
  );
  skippedFiles.push(...selection.skipped);
  for (const revisionSource of selection.sources) {
    throwIfRefreshAborted(input.signal);
    const canonicalPath = revisionSource.absolutePath;
    const relative = revisionSource.relativePath;
    const knownLanguageId = languageFor(canonicalPath);
    const knownFormat = documentFormatFor(canonicalPath);
    if (
      input.supports
        ? !input.supports(canonicalPath)
        : !input.analyze && !knownLanguageId && !knownFormat
    ) {
      skippedFiles.push(relative);
      continue;
    }
    const source = await revisionSource.read();
    throwIfRefreshAborted(input.signal);
    const analysis = input.analyze
      ? await input.analyze({
          filePath: canonicalPath,
          signal: input.signal,
          source,
        })
      : null;
    throwIfRefreshAborted(input.signal);
    if (input.analyze && !analysis) {
      skippedFiles.push(relative);
      continue;
    }
    const languageId =
      analysis?.kind === "code" ? analysis.languageId : knownLanguageId;
    const format =
      analysis?.kind === "document" ? analysis.format : knownFormat;
    if (!analysis && !languageId && !format) {
      skippedFiles.push(relative);
      continue;
    }
    if (analysis?.kind === "project") {
      const sourceArtifactId = sourceArtifactIdentity({
        contentDigest: analysis.facts.sourceDigest,
      });
      const facts = {
        ...analysis.facts,
        sourceArtifactId,
        syntaxFactsArtifactId: syntaxFactsArtifactIdentity({
          languageId: `project:${analysis.facts.format}`,
          parserFingerprint: analysis.facts.parserFingerprint,
          sourceArtifactId,
        }),
      };
      appendSyntaxArtifacts({
        artifactRows,
        facts,
        indexedAt,
        languageId: `project:${facts.format}`,
        parserFingerprint: facts.parserFingerprint,
        source,
        sourceArtifactId: facts.sourceArtifactId,
        syntaxRows,
      });
      for (const node of facts.nodes) {
        const text =
          source.slice(
            node.range.startCoordinate.utf16Offset,
            node.range.endCoordinate.utf16Offset,
          ) || node.name;
        if (!text.trim()) continue;
        const range = retrievalRange(node.range);
        const symbols = [node.name];
        const chunkInput: Omit<RetrievalChunk, "artifactId"> = {
          documentKind: "structured" as const,
          language: facts.format,
          path: relative,
          range,
          sourceArtifactId: facts.sourceArtifactId,
          symbols,
          text,
        };
        appendRetrievalChunk(chunkInput, indexedAt, chunkRows, retrievalChunks);
      }
      parsedFiles.push(relative);
      units.push({
        facts,
        kind: "project",
        path: relative,
        sourceArtifactId: facts.sourceArtifactId,
      });
      continue;
    }
    if (format) {
      const analyzed =
        analysis?.kind === "document"
          ? analysis.facts
          : await analyzeDocument({ format, source });
      const sourceArtifactId = sourceArtifactIdentity({
        contentDigest: analyzed.sourceDigest,
      });
      const documentParserFingerprint = sha256(`ast-mcp.document:${format}:v1`);
      const facts: DocumentFacts = {
        ...analyzed,
        syntaxFactsArtifactId: syntaxFactsArtifactIdentity({
          languageId: `document:${format}`,
          parserFingerprint: documentParserFingerprint,
          sourceArtifactId,
        }),
      };
      appendSyntaxArtifacts({
        artifactRows,
        facts,
        indexedAt,
        languageId: `document:${format}`,
        parserFingerprint: documentParserFingerprint,
        source,
        sourceArtifactId,
        syntaxRows,
      });
      for (const node of facts.nodes) {
        const text =
          node.value ??
          node.name ??
          source.slice(
            node.range.startCoordinate.utf16Offset,
            node.range.endCoordinate.utf16Offset,
          );
        const symbols = node.name ? [node.name] : [];
        const range = retrievalRange(node.range);
        const chunkInput: Omit<RetrievalChunk, "artifactId"> = {
          documentKind: documentKind(format),
          language: format,
          path: relative,
          range,
          sourceArtifactId: sourceArtifactId,
          symbols,
          text,
        };
        appendRetrievalChunk(chunkInput, indexedAt, chunkRows, retrievalChunks);
      }
      parsedFiles.push(relative);
      units.push({ facts, kind: "document", path: relative, sourceArtifactId });
      continue;
    }
    if (!languageId) {
      skippedFiles.push(relative);
      continue;
    }
    const parseRequest = {
      extractorVersion: EXTRACTOR_VERSION,
      languageId,
      source,
    };
    const facts =
      analysis?.kind === "code"
        ? {
            ...normalizeSyntaxHierarchy(analysis.facts),
            sourceArtifactId: sourceArtifactIdentity({
              contentDigest: analysis.facts.sourceDigest,
            }),
            syntaxFactsArtifactId: syntaxFactsArtifactIdentity({
              languageId: analysis.facts.languageId,
              parserFingerprint: analysis.facts.parserFingerprint,
              sourceArtifactId: sourceArtifactIdentity({
                contentDigest: analysis.facts.sourceDigest,
              }),
            }),
          }
        : input.parse
          ? await input.parse(parseRequest, { signal: input.signal })
          : parseSource(parseRequest);
    appendSyntaxArtifacts({
      artifactRows,
      facts,
      indexedAt,
      languageId: facts.languageId,
      parserFingerprint: facts.parserFingerprint,
      source,
      sourceArtifactId: facts.sourceArtifactId,
      syntaxRows,
    });
    const chunkSymbols =
      facts.symbols.length > 0
        ? facts.symbols
        : [
            {
              id: facts.rootNodeId,
              name: path.basename(relative),
              qualifiedName: path.basename(relative),
              range: facts.nodes.find((node) => node.id === facts.rootNodeId)
                ?.range ?? {
                end: { column: source.length, line: 0 },
                endByte: Buffer.byteLength(source),
                endCoordinate: {
                  byteOffset: Buffer.byteLength(source),
                  characterOffset: source.length,
                  column: source.length,
                  line: 0,
                  utf16Column: source.length,
                  utf16Offset: source.length,
                },
                start: { column: 0, line: 0 },
                startByte: 0,
                startCoordinate: {
                  byteOffset: 0,
                  characterOffset: 0,
                  column: 0,
                  line: 0,
                  utf16Column: 0,
                  utf16Offset: 0,
                },
              },
            },
          ];
    for (const symbol of chunkSymbols) {
      const range = retrievalRange(symbol.range);
      const text = source.slice(
        symbol.range.startCoordinate.utf16Offset,
        symbol.range.endCoordinate.utf16Offset,
      );
      if (!text.trim()) continue;
      const symbols = [...new Set([symbol.name, symbol.qualifiedName])];
      const chunkInput: Omit<RetrievalChunk, "artifactId"> = {
        documentKind: "code" as const,
        language: facts.languageId,
        path: relative,
        range,
        sourceArtifactId: facts.sourceArtifactId,
        symbols,
        text,
      };
      appendRetrievalChunk(chunkInput, indexedAt, chunkRows, retrievalChunks);
    }
    parsedFiles.push(relative);
    units.push({
      facts,
      kind: "code",
      path: relative,
      sourceArtifactId: facts.sourceArtifactId,
    });
  }

  throwIfRefreshAborted(input.signal);
  const dirtyOverlayId =
    workspace.selectedRevision.selector.kind === "working"
      ? await gitDirtyOverlayId(
          workspace.git,
          workspace.repositoryId,
          workspace.selectedRevision.revisionId,
        )
      : null;
  throwIfRefreshAborted(input.signal);
  const dirtyOverlayRows = dirtyOverlayId
    ? [
        {
          artifact_id: dirtyOverlayId,
          base_revision_id: workspace.selectedRevision.revisionId,
          checkout_root: workspace.checkoutRoot,
          created_at: indexedAt,
          entry_count: units.length,
          logical_bytes: units.reduce(
            (total, unit) => total + unit.facts.nodes.length,
            0,
          ),
          payload_json: JSON.stringify({
            indexedPaths: [...parsedFiles, ...skippedFiles].sort(),
            repositoryId: workspace.repositoryId,
          }),
          repository_id: workspace.repositoryId,
        },
      ]
    : [];

  const resolutionSources: ResolutionSource[] = units.map((unit) => {
    if (unit.kind === "code")
      return { facts: unit.facts, kind: "code", path: unit.path };
    if (unit.kind === "project")
      return { facts: unit.facts, kind: "project", path: unit.path };
    return {
      facts: {
        artifactId: unit.sourceArtifactId,
        nodes: unit.facts.nodes.map((node) => ({
          id: node.id,
          name:
            node.name ??
            node.value ??
            `${path.basename(unit.path)}:${node.kind}`,
          ...(node.kind === "section"
            ? { nodeKind: "section" as const }
            : node.parentId === null
              ? { nodeKind: "document" as const }
              : {}),
          parentId: node.parentId,
          range: node.range,
        })),
        relationships: unit.facts.references.map((reference) => ({
          id: reference.id,
          kind:
            reference.kind === "package"
              ? ("dependency" as const)
              : reference.kind === "code"
                ? ("reference" as const)
                : ("document-link" as const),
          range: reference.range,
          sourceNodeId: null,
          target: reference.target,
        })),
        sourceDigest: unit.facts.sourceDigest,
      },
      kind: "document",
      path: unit.path,
    };
  });
  const resolverFingerprint = sha256(
    JSON.stringify({
      extractorVersion: EXTRACTOR_VERSION,
      resolverVersion: "ast-mcp.resolution.v1",
    }),
  );
  const environmentFingerprint = sha256(
    JSON.stringify({
      repositoryId: workspace.repositoryId,
      resolverFingerprint,
      version: "ast-mcp.resolution-environment.v2",
    }),
  );
  throwIfRefreshAborted(input.signal);
  const resolution = materializeResolutionInput({
    environmentFingerprint,
    repositoryId: workspace.repositoryId,
    resolverFingerprint,
    revisionId: workspace.selectedRevision.revisionId,
    sources: resolutionSources,
  });
  const evidenceById = new Map(
    resolution.evidence.map((item) => [item.id, item]),
  );
  const resolvedRelationshipIds = new Map<string, string>();
  for (const unit of units) {
    throwIfRefreshAborted(input.signal);
    const relationshipIds = resolution.relationships
      .filter((relationship) =>
        relationship.evidenceIds.some(
          (evidenceId) => evidenceById.get(evidenceId)?.path === unit.path,
        ),
      )
      .map((relationship) => relationship.id)
      .sort();
    const localEnvironmentFingerprint = sha256(
      JSON.stringify({
        environmentFingerprint,
        path: unit.path,
        relationshipIds,
        syntaxFactsArtifactId: unit.facts.syntaxFactsArtifactId,
      }),
    );
    const artifactId = resolvedRelationshipsArtifactIdentity({
      environmentFingerprint: localEnvironmentFingerprint,
      resolverFingerprint,
      syntaxFactsArtifactId: unit.facts.syntaxFactsArtifactId,
    });
    resolvedRelationshipIds.set(unit.path, artifactId);
    const resolutionId = createIdentity("resolved-relationship-set", {
      environmentFingerprint: localEnvironmentFingerprint,
      relationshipIds,
      resolverFingerprint,
      syntaxFactsArtifactId: unit.facts.syntaxFactsArtifactId,
    });
    const payload = JSON.stringify({
      environmentFingerprint: localEnvironmentFingerprint,
      relationshipIds,
      resolutionId,
      resolverFingerprint,
      syntaxFactsArtifactId: unit.facts.syntaxFactsArtifactId,
    });
    relationshipRows.push({
      artifact_id: artifactId,
      byte_length: Buffer.byteLength(payload),
      created_at: indexedAt,
      environment_fingerprint: localEnvironmentFingerprint,
      payload_json: payload,
      resolver_fingerprint: resolverFingerprint,
      syntax_facts_artifact_id: unit.facts.syntaxFactsArtifactId,
    });
  }
  const manifestInput = {
    dirtyOverlayId,
    entries: units.map((unit) => ({
      path: unit.path,
      resolvedRelationshipsArtifactId:
        resolvedRelationshipIds.get(unit.path) ?? null,
      sourceArtifactId: unit.sourceArtifactId,
      syntaxFactsArtifactId: unit.facts.syntaxFactsArtifactId,
    })),
    repositoryId: workspace.repositoryId,
    revisionId: workspace.selectedRevision.revisionId,
  };
  const manifestArtifactId = revisionManifestArtifactIdentity(manifestInput);
  const manifestPayload = JSON.stringify(manifestInput);
  artifactRows.push({
    artifact_id: manifestArtifactId,
    byte_length: Buffer.byteLength(manifestPayload),
    content_bytes: null,
    content_digest: sha256(manifestPayload),
    created_at: indexedAt,
    kind: "revision-manifest",
    payload_json: manifestPayload,
  });
  const requiredTables = [
    "artifacts",
    "syntax_facts",
    "chunks",
    "relationships",
    ...(dirtyOverlayRows.length > 0 ? (["dirty_overlays"] as const) : []),
    "revision_manifests",
    "graph_nodes",
    "graph_occurrences",
    "graph_edges",
    "graph_evidence",
    "revision_membership",
    ...(input.embedding ? (["embeddings"] as const) : []),
  ] as const;
  const reservationInput = {
    manifestArtifactId,
    requiredTables: [...requiredTables],
    reservationKey: createIdentity("mutation-refresh", {
      dirtyOverlayId,
      manifestArtifactId,
      sourceDigests: units.map((unit) => unit.facts.sourceDigest),
      workspaceId: workspace.workspaceId,
    }),
    revisionId: workspace.selectedRevision.revisionId,
    workspaceId: workspace.workspaceId,
  };
  throwIfRefreshAborted(input.signal);
  const reusable = await store.reusablePublication(reservationInput);
  throwIfRefreshAborted(input.signal);
  if (reusable) {
    return {
      dirtyOverlayId,
      generationId: reusable.generationId,
      indexedAt: reusable.publishedAt,
      parsedFiles,
      skippedFiles,
    };
  }
  const reservation = await store.reservePublication(reservationInput);

  try {
    throwIfRefreshAborted(input.signal);
    await store.putReservedRows(
      reservation,
      "relationships",
      uniqueRows(relationshipRows),
    );
    throwIfRefreshAborted(input.signal);
    await store.putReservedRowsBatch(reservation, [
      {
        rows: uniqueRows(artifactRows),
        tableName: "artifacts",
      },
      {
        rows: uniqueRows(syntaxRows),
        tableName: "syntax_facts",
      },
      {
        rows: uniqueRows(chunkRows),
        tableName: "chunks",
      },
      ...(dirtyOverlayRows.length > 0
        ? ([{ rows: dirtyOverlayRows, tableName: "dirty_overlays" }] as const)
        : []),
      {
        rows: [
          {
            artifact_id: manifestArtifactId,
            created_at: indexedAt,
            dirty_overlay_id: dirtyOverlayId,
            entry_count: units.length,
            logical_bytes: Buffer.byteLength(manifestPayload),
            payload_json: manifestPayload,
            repository_id: workspace.repositoryId,
            revision_id: workspace.selectedRevision.revisionId,
          },
        ],
        tableName: "revision_manifests",
      },
    ]);
    throwIfRefreshAborted(input.signal);
    const snapshot = graphFromResolution(resolution, {
      generationId: reservation.generationId,
      sourceDigests: Object.fromEntries(
        units.map((unit) => [unit.sourceArtifactId, unit.facts.sourceDigest]),
      ),
      workspaceId: workspace.workspaceId,
    });
    await new LanceGraphRepository(store).persist(snapshot, workspace, {
      allowReadOnlySource: input.allowReadOnlySource,
      reservation,
    });
    throwIfRefreshAborted(input.signal);
    if (input.embedding) {
      const embeddings = await publishChunkEmbeddings(
        store,
        snapshot.scope,
        retrievalChunks,
        input.embedding.config,
        input.embedding.pool,
        {
          allowReadOnlySource: input.allowReadOnlySource,
          reservation,
          signal: input.signal,
          throwOnFailure: false,
          workspace,
        },
      );
      void embeddings;
      throwIfRefreshAborted(input.signal);
      await store.recordReservedTableVersion(reservation, "embeddings");
      throwIfRefreshAborted(input.signal);
    }
    throwIfRefreshAborted(input.signal);
    const publication = await store.finalizePublication(reservation);
    return {
      dirtyOverlayId,
      generationId: publication.generationId,
      indexedAt,
      parsedFiles,
      skippedFiles,
    };
  } catch (error) {
    try {
      await store.abandonPublication(
        reservation,
        error instanceof Error ? error.name : "mutation_refresh_failed",
      );
    } catch {}
    throw error;
  }
}

import { readdir, readFile, realpath } from "node:fs/promises";
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
} from "../retrieval/index.ts";
import type { LanceIntelligenceStore } from "../storage/store.ts";
import type { WorkspaceHandle } from "../workspace/context.ts";
import { gitDirtyOverlayId, readGitRevisionFile } from "../workspace/git.ts";
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

function createdAt(identity: string): string {
  const digest = identity.slice(-12);
  return new Date(
    Number(BigInt(`0x${digest}`) % 4_102_444_800_000n),
  ).toISOString();
}

async function canonicalFilePath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return filePath;
  }
}

async function repositoryFiles(
  root: string,
  excludedRoot: string,
): Promise<string[]> {
  const files: string[] = [];
  const canonicalExcludedRoot = await canonicalFilePath(excludedRoot);
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
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
  relativePath: string;
  source: string;
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

function sanitizedGitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith("GIT_"))
      environment[name] = value;
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

async function revisionPaths(
  workspace: WorkspaceHandle,
): Promise<{ paths: string[]; skipped: string[] }> {
  const index = workspace.selectedRevision.selector.kind === "index";
  const args = index
    ? ["ls-files", "--stage", "-z"]
    : [
        "ls-tree",
        "-r",
        "-z",
        workspace.selectedRevision.resolvedCommitOid as string,
      ];
  const child = Bun.spawn(["git", "-C", workspace.checkoutRoot, ...args], {
    env: sanitizedGitEnvironment(),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).bytes(),
  ]);
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
    const intentChild = Bun.spawn(
      [
        "git",
        "-C",
        workspace.checkoutRoot,
        "diff",
        "--name-only",
        "--diff-filter=A",
        "-z",
      ],
      {
        env: sanitizedGitEnvironment(),
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [intentCode, intentError, intentOutput] = await Promise.all([
      intentChild.exited,
      new Response(intentChild.stderr).text(),
      new Response(intentChild.stdout).bytes(),
    ]);
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
): Promise<RevisionSourceSelection> {
  if (workspace.selectedRevision.selector.kind === "working") {
    const sources: RepositorySource[] = [];
    for (const filePath of await repositoryFiles(
      workspace.checkoutRoot,
      workspace.storageDomain.storagePath,
    )) {
      const absolutePath = await canonicalFilePath(filePath);
      sources.push({
        absolutePath,
        relativePath: repositoryRelativePath(workspace, absolutePath),
        source: await readFile(absolutePath, "utf8"),
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
  const selection = await revisionPaths(workspace);
  for (const relativePath of selection.paths) {
    if (
      relativePath === excludedPrefix ||
      (excludedPrefix && relativePath.startsWith(`${excludedPrefix}/`))
    )
      continue;
    const absolutePath = path.join(workspace.checkoutRoot, relativePath);
    sources.push({
      absolutePath,
      relativePath,
      source: Buffer.from(
        await readGitRevisionFile(
          workspace.git,
          workspace.selectedRevision,
          absolutePath,
        ),
      ).toString("utf8"),
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
  signal?: AbortSignal;
}

export async function refreshMutationIntelligence(
  input: {
    now?: () => Date;
    store: LanceIntelligenceStore;
    workspace: WorkspaceHandle;
  } & IntelligenceRefreshDependencies,
): Promise<MutationRefreshResult> {
  const { store, workspace } = input;
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

  const selection = await selectedRevisionSources(workspace);
  skippedFiles.push(...selection.skipped);
  for (const revisionSource of selection.sources) {
    if (input.signal?.aborted) throw new Error("intelligence_refresh_aborted");
    const canonicalPath = revisionSource.absolutePath;
    const relative = revisionSource.relativePath;
    const source = revisionSource.source;
    const analysis = input.analyze
      ? await input.analyze({
          filePath: canonicalPath,
          signal: input.signal,
          source,
        })
      : null;
    if (input.analyze && !analysis) {
      skippedFiles.push(relative);
      continue;
    }
    const languageId =
      analysis?.kind === "code"
        ? analysis.languageId
        : languageFor(canonicalPath);
    const format =
      analysis?.kind === "document"
        ? analysis.format
        : documentFormatFor(canonicalPath);
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
      artifactRows.push({
        artifact_id: facts.sourceArtifactId,
        byte_length: Buffer.byteLength(source),
        content_bytes: Buffer.from(source),
        content_digest: facts.sourceDigest,
        created_at: createdAt(facts.sourceArtifactId),
        kind: "source",
        payload_json: JSON.stringify({ contentDigest: facts.sourceDigest }),
      });
      syntaxRows.push({
        artifact_id: facts.syntaxFactsArtifactId,
        byte_length: Buffer.byteLength(JSON.stringify(facts)),
        created_at: createdAt(facts.syntaxFactsArtifactId),
        language_id: `project:${facts.format}`,
        parser_fingerprint: facts.parserFingerprint,
        payload_json: JSON.stringify(facts),
        source_artifact_id: facts.sourceArtifactId,
      });
      for (const node of facts.nodes) {
        const text =
          source.slice(
            node.range.startCoordinate.utf16Offset,
            node.range.endCoordinate.utf16Offset,
          ) || node.name;
        if (!text.trim()) continue;
        const artifactId = createIdentity("chunks", {
          nodeId: node.id,
          path: relative,
          sourceDigest: facts.sourceDigest,
        });
        const range = retrievalRange(node.range);
        const symbols = [node.name];
        chunkRows.push({
          artifact_id: artifactId,
          byte_length: Buffer.byteLength(text),
          created_at: createdAt(artifactId),
          document_kind: "structured",
          extracted_content_digest: sha256(text),
          payload_json: JSON.stringify({
            language: facts.format,
            range,
            symbols,
            version: "retrieval-chunk-v1",
          }),
          semantic_context_digest: sha256(
            JSON.stringify({ kind: node.kind, path: relative, symbols }),
          ),
          source_artifact_id: facts.sourceArtifactId,
          syntax_facts_artifact_id: facts.syntaxFactsArtifactId,
          text,
        });
        retrievalChunks.push({
          artifactId,
          documentKind: "structured",
          language: facts.format,
          path: relative,
          range,
          sourceArtifactId: facts.sourceArtifactId,
          symbols,
          text,
        });
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
      artifactRows.push({
        artifact_id: sourceArtifactId,
        byte_length: Buffer.byteLength(source),
        content_bytes: Buffer.from(source),
        content_digest: facts.sourceDigest,
        created_at: createdAt(sourceArtifactId),
        kind: "source",
        payload_json: JSON.stringify({ contentDigest: facts.sourceDigest }),
      });
      syntaxRows.push({
        artifact_id: facts.syntaxFactsArtifactId,
        byte_length: Buffer.byteLength(JSON.stringify(facts)),
        created_at: createdAt(facts.syntaxFactsArtifactId),
        language_id: `document:${format}`,
        parser_fingerprint: documentParserFingerprint,
        payload_json: JSON.stringify(facts),
        source_artifact_id: sourceArtifactId,
      });
      for (const node of facts.nodes) {
        const text =
          node.value ??
          node.name ??
          source.slice(
            node.range.startCoordinate.utf16Offset,
            node.range.endCoordinate.utf16Offset,
          );
        const artifactId = createIdentity("chunks", {
          nodeId: node.id,
          path: relative,
          sourceDigest: facts.sourceDigest,
        });
        const symbols = node.name ? [node.name] : [];
        const range = retrievalRange(node.range);
        chunkRows.push({
          artifact_id: artifactId,
          byte_length: Buffer.byteLength(text),
          created_at: createdAt(artifactId),
          document_kind: documentKind(format),
          extracted_content_digest: sha256(text),
          payload_json: JSON.stringify({
            language: format,
            range,
            symbols,
            version: "retrieval-chunk-v1",
          }),
          semantic_context_digest: sha256(
            JSON.stringify({
              kind: node.kind,
              name: node.name,
              path: relative,
            }),
          ),
          source_artifact_id: sourceArtifactId,
          syntax_facts_artifact_id: null,
          text,
        });
        retrievalChunks.push({
          artifactId,
          documentKind: documentKind(format),
          language: format,
          path: relative,
          range,
          sourceArtifactId,
          symbols,
          text,
        });
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
    artifactRows.push({
      artifact_id: facts.sourceArtifactId,
      byte_length: Buffer.byteLength(source),
      content_bytes: Buffer.from(source),
      content_digest: facts.sourceDigest,
      created_at: createdAt(facts.sourceArtifactId),
      kind: "source",
      payload_json: JSON.stringify({ contentDigest: facts.sourceDigest }),
    });
    syntaxRows.push({
      artifact_id: facts.syntaxFactsArtifactId,
      byte_length: Buffer.byteLength(JSON.stringify(facts)),
      created_at: createdAt(facts.syntaxFactsArtifactId),
      language_id: facts.languageId,
      parser_fingerprint: facts.parserFingerprint,
      payload_json: JSON.stringify(facts),
      source_artifact_id: facts.sourceArtifactId,
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
      const artifactId = createIdentity("chunks", {
        path: relative,
        sourceDigest: facts.sourceDigest,
        symbolId: symbol.id,
      });
      const symbols = [...new Set([symbol.name, symbol.qualifiedName])];
      chunkRows.push({
        artifact_id: artifactId,
        byte_length: Buffer.byteLength(text),
        created_at: createdAt(artifactId),
        document_kind: "code",
        extracted_content_digest: sha256(text),
        payload_json: JSON.stringify({
          language: facts.languageId,
          range,
          symbols,
          version: "retrieval-chunk-v1",
        }),
        semantic_context_digest: sha256(
          JSON.stringify({
            language: facts.languageId,
            path: relative,
            symbols,
          }),
        ),
        source_artifact_id: facts.sourceArtifactId,
        syntax_facts_artifact_id: facts.syntaxFactsArtifactId,
        text,
      });
      retrievalChunks.push({
        artifactId,
        documentKind: "code",
        language: facts.languageId,
        path: relative,
        range,
        sourceArtifactId: facts.sourceArtifactId,
        symbols,
        text,
      });
    }
    parsedFiles.push(relative);
    units.push({
      facts,
      kind: "code",
      path: relative,
      sourceArtifactId: facts.sourceArtifactId,
    });
  }

  const dirtyOverlayId =
    workspace.selectedRevision.selector.kind === "working"
      ? await gitDirtyOverlayId(
          workspace.git,
          workspace.repositoryId,
          workspace.selectedRevision.revisionId,
        )
      : null;
  const indexedAt = (input.now ?? (() => new Date()))().toISOString();
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
      created_at: createdAt(artifactId),
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
    created_at: createdAt(manifestArtifactId),
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
  const reservation = await store.reservePublication({
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
  });

  try {
    await store.putRows("relationships", uniqueRows(relationshipRows), {
      immutable: true,
    });
    await store.putReservedRowsBatch(reservation, [
      {
        options: { immutable: false },
        rows: uniqueRows(artifactRows),
        tableName: "artifacts",
      },
      {
        options: { immutable: false },
        rows: uniqueRows(syntaxRows),
        tableName: "syntax_facts",
      },
      {
        options: { immutable: false },
        rows: uniqueRows(chunkRows).map((row) => ({
          ...row,
          publication_generation_id: reservation.generationId,
        })),
        tableName: "chunks",
      },
      ...(dirtyOverlayRows.length > 0
        ? ([{ rows: dirtyOverlayRows, tableName: "dirty_overlays" }] as const)
        : []),
      {
        rows: [
          {
            artifact_id: manifestArtifactId,
            created_at: createdAt(manifestArtifactId),
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
    await store.recordReservedTableVersion(reservation, "relationships");
    const snapshot = graphFromResolution(resolution, {
      generationId: reservation.generationId,
      sourceDigests: Object.fromEntries(
        units.map((unit) => [unit.sourceArtifactId, unit.facts.sourceDigest]),
      ),
      workspaceId: workspace.workspaceId,
    });
    await new LanceGraphRepository(store).persist(snapshot, workspace, {
      allowReadOnlySource: input.allowReadOnlySource,
    });
    for (const table of [
      "graph_nodes",
      "graph_occurrences",
      "graph_edges",
      "graph_evidence",
      "revision_membership",
    ] as const)
      await store.recordReservedTableVersion(reservation, table);
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
      await store.recordReservedTableVersion(reservation, "embeddings");
    }
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

import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { currentConfig } from "../config";
import {
  toolFailure,
  toolOutputSchema,
  toolSuccess,
} from "../helpers/mcp-schema";
import {
  findStructuralMatches,
  LANGUAGE_CAPABILITY_CATALOG,
  type ParserLanguageId,
  parseSource,
  rewriteStructuralMatches,
  type SyntaxFacts,
} from "../intelligence/parser/index.ts";
import { LanceIntelligenceStore } from "../intelligence/storage/index.ts";
import {
  currentWorkspace,
  readGitRevisionFile,
  runGitRaw,
  type WorkspaceHandle,
} from "../intelligence/workspace/index.ts";
import { detectAstLanguage } from "../patch/languages";
import { assertReadableTree } from "../runtime/path-policy";
import { resolveWorkspacePath } from "../runtime/paths";
import { type ConfiguredExecution, localExecution } from "./configured";

const TOOL_NAMES = [
  "map",
  "digest",
  "show",
  "implements",
  "surface",
  "deps",
  "reverse_deps",
  "cycles",
  "graph",
  "search",
  "find_related",
  "callers",
  "callees",
  "trace",
  "impact",
  "context",
  "run",
  "squeeze",
] as const;

const inputSchema = z
  .object({
    budget: z.number().int().positive().max(1_000_000).optional(),
    depth: z.number().int().positive().max(32).optional(),
    detail: z.enum(["names", "signatures", "full"]).optional(),
    direct: z.boolean().optional(),
    file: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
    hide_ambiguous: z.boolean().optional(),
    hide_external: z.boolean().optional(),
    include_fields: z.boolean().optional(),
    include_private: z.boolean().optional(),
    json: z.boolean().optional(),
    lang: z.string().min(1).optional(),
    languages: z.array(z.string().min(1)).max(64).optional(),
    limit: z.number().int().positive().max(10_000).optional(),
    line: z.number().int().positive().optional(),
    max_members: z.number().int().nonnegative().max(10_000).optional(),
    min_size: z.number().int().positive().max(10_000).optional(),
    mode: z.enum(["deps", "dependents", "tests", "all"]).optional(),
    path: z.string().min(1).optional(),
    paths: z.array(z.string().min(1)).min(1).max(50).optional(),
    pattern: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    rewrite: z.string().optional(),
    root: z.string().min(1).optional(),
    scan_limit: z.number().int().positive().max(10_000).optional(),
    symbols: z.array(z.string().min(1)).max(100).optional(),
    target: z.string().min(1).optional(),
    tests: z.boolean().optional(),
    text: z.string().optional(),
    timeout_ms: z.number().int().positive().max(300_000).optional(),
    top_k: z.number().int().positive().max(1_000).optional(),
    workspaceId: z.string().min(1).optional(),
    write: z.boolean().optional(),
  })
  .strict();

type ToolInput = z.infer<typeof inputSchema>;
type NativeFile = {
  facts: SyntaxFacts;
  path: string;
  source: string;
};

function toolDescription(name: (typeof TOOL_NAMES)[number]): string {
  const descriptions: Record<(typeof TOOL_NAMES)[number], string> = {
    callees: "Returns native AST call targets for a symbol.",
    callers: "Returns native AST callers of a symbol.",
    context: "Returns token-budgeted native AST context for a symbol.",
    cycles: "Returns import cycles from the native dependency graph.",
    deps: "Returns native forward import dependencies for a file.",
    digest: "Returns a compact native AST module digest.",
    find_related: "Returns structurally related native index entries.",
    graph: "Returns the native file dependency graph.",
    impact: "Returns callers, callees, dependents, and tests for a symbol.",
    implements: "Returns native inheritance and implementation relationships.",
    map: "Returns native AST symbols, imports, and diagnostics by file.",
    reverse_deps: "Returns native reverse import dependencies for a file.",
    run: "Finds native structural AST matches and previews rewrites; write=true is disabled; commit through file_patch.",
    search: "Searches native AST symbols and source text.",
    show: "Returns native AST source for selected symbols.",
    squeeze: "Compacts repetitive text into a bounded payload.",
    surface: "Returns exported native AST symbols.",
    trace: "Returns a bounded native call trace.",
  };
  return descriptions[name];
}

async function requestRoot(input: ToolInput): Promise<string> {
  const config = await currentConfig();
  const workspace = currentWorkspace();
  const projectRoot = workspace?.checkoutRoot ?? config.projectRoot;
  const requested = input.root ?? projectRoot;
  const resolved = await resolveWorkspacePath(
    path.resolve(projectRoot, requested),
  );
  const metadata = await Bun.file(resolved)
    .stat()
    .catch(() => undefined);
  const root = metadata?.isDirectory() ? resolved : path.dirname(resolved);
  assertReadableTree(config, root);
  return root;
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

async function revisionFilePaths(
  workspace: WorkspaceHandle,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  const revision = workspace.selectedRevision;
  const args =
    revision.selector.kind === "index"
      ? ["ls-files", "-z"]
      : [
          "ls-tree",
          "-r",
          "--name-only",
          "-z",
          revision.resolvedCommitOid as string,
        ];
  const { code, stderr, stdout } = await runGitRaw(
    workspace.checkoutRoot,
    args,
    signal,
    throwIfAborted,
  );
  if (code !== 0)
    throw Object.assign(
      new Error(stderr || `Git failed with exit code ${code}`),
      { code: "workspace_git_failure", retryable: false },
    );
  return Buffer.from(stdout)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

function requestedRelativePaths(input: ToolInput, root: string): string[] {
  return [
    ...(input.paths ?? []),
    ...(input.file ? [input.file] : []),
    ...(input.path ? [input.path] : []),
  ].map((value) => {
    const absolute = path.resolve(root, value);
    const relativePath = relative(root, absolute);
    if (
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      path.isAbsolute(relativePath)
    )
      throw Object.assign(
        new Error("Revision path must stay inside the selected workspace"),
        { code: "workspace_mismatch", retryable: true },
      );
    return relativePath.replace(/\/+$/u, "");
  });
}

function selectedRevisionPaths(
  input: ToolInput,
  root: string,
  workspace: WorkspaceHandle,
  repositoryPaths: string[],
): string[] {
  const requested = requestedRelativePaths(input, root);
  const glob = input.glob ? new Bun.Glob(input.glob) : undefined;
  return repositoryPaths
    .map((repositoryPath) => path.join(workspace.checkoutRoot, repositoryPath))
    .filter((absolute) => {
      const candidate = relative(root, absolute);
      if (
        candidate === ".." ||
        candidate.startsWith("../") ||
        path.isAbsolute(candidate)
      )
        return false;
      if (
        requested.length > 0 &&
        !requested.some(
          (item) => candidate === item || candidate.startsWith(`${item}/`),
        )
      )
        return false;
      return !glob || glob.match(candidate);
    })
    .sort();
}

async function requestedFiles(
  input: ToolInput,
  root: string,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  const workspace = currentWorkspace();
  if (workspace && workspace.selectedRevision.selector.kind !== "working") {
    const repositoryPaths = await revisionFilePaths(workspace, signal);
    throwIfAborted(signal);
    return selectedRevisionPaths(input, root, workspace, repositoryPaths);
  }
  const explicit = [
    ...(input.paths ?? []),
    ...(input.file ? [input.file] : []),
    ...(input.path ? [input.path] : []),
  ];
  if (explicit.length) {
    const files: string[] = [];
    for (const value of explicit) {
      throwIfAborted(signal);
      const resolved = await resolveWorkspacePath(path.resolve(root, value));
      const metadata = await Bun.file(resolved)
        .stat()
        .catch(() => undefined);
      if (metadata?.isFile()) files.push(resolved);
      else if (metadata?.isDirectory()) {
        for await (const entry of new Bun.Glob(input.glob ?? "**/*").scan({
          absolute: true,
          cwd: resolved,
          dot: false,
          followSymlinks: false,
          onlyFiles: true,
        })) {
          throwIfAborted(signal);
          files.push(entry);
        }
      }
    }
    return [...new Set(files)].sort();
  }
  const files: string[] = [];
  for await (const entry of new Bun.Glob(input.glob ?? "**/*").scan({
    absolute: true,
    cwd: root,
    dot: false,
    followSymlinks: false,
    onlyFiles: true,
  })) {
    throwIfAborted(signal);
    if (
      !entry.includes(`${path.sep}node_modules${path.sep}`) &&
      !entry.includes(`${path.sep}.git${path.sep}`) &&
      !entry.includes(`${path.sep}.ast-mcp${path.sep}`)
    )
      files.push(entry);
  }
  return files.sort();
}

type ScanOmissions = {
  scanLimit: number;
  unreadable: number;
  unsupported: number;
};

type ScanCoverage = {
  candidates: number;
  eligible: number;
  exhaustive: boolean;
  omittedPaths: {
    scanLimit: string[];
    unreadable: string[];
    unsupported: string[];
  };
  omittedPathsTruncated: boolean;
  omissions: ScanOmissions;
  parsed: number;
  truncated: boolean;
};

const MAX_OMITTED_PATHS = 20;

async function sourceFor(
  filePath: string,
  workspace: WorkspaceHandle | undefined,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  if (workspace && workspace.selectedRevision.selector.kind !== "working")
    return Buffer.from(
      await readGitRevisionFile(
        workspace.git,
        workspace.selectedRevision,
        filePath,
        signal,
      ),
    ).toString("utf8");
  return Bun.file(filePath).text();
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("Code intelligence request was aborted"), {
    code: "aborted",
    retryable: true,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function catalogLanguage(
  filePath: string,
  requested?: string,
): ParserLanguageId | null {
  if (requested) {
    return (
      LANGUAGE_CAPABILITY_CATALOG.find(
        (entry) => entry.languageId === requested,
      )?.languageId ?? null
    );
  }
  const name = path.basename(filePath).toLowerCase();
  return (
    [...LANGUAGE_CAPABILITY_CATALOG]
      .flatMap((entry) =>
        entry.extensions.map((extension) => ({ entry, extension })),
      )
      .sort((left, right) => right.extension.length - left.extension.length)
      .find(({ extension }) => name.endsWith(extension.toLowerCase()))?.entry
      .languageId ??
    detectAstLanguage(filePath) ??
    null
  );
}

async function loadFiles(
  input: ToolInput,
  signal?: AbortSignal,
): Promise<{ files: NativeFile[]; root: string; scan: ScanCoverage }> {
  throwIfAborted(signal);
  const root = await requestRoot(input);
  const selected = await requestedFiles(input, root, signal);
  throwIfAborted(signal);
  const config = await currentConfig();
  const workspace = currentWorkspace();
  const allowedLanguages = input.languages
    ? new Set(input.languages)
    : undefined;
  const eligible: Array<{ language: ParserLanguageId; path: string }> = [];
  const unsupported: string[] = [];
  for (const filePath of selected) {
    throwIfAborted(signal);
    const language = catalogLanguage(filePath, input.lang);
    const catalog = language
      ? LANGUAGE_CAPABILITY_CATALOG.find(
          (entry) => entry.languageId === language,
        )
      : undefined;
    if (
      config.files.read.modes.includes("ast") &&
      catalog?.structuralOperations.parse &&
      (!allowedLanguages || allowedLanguages.has(language as string))
    )
      eligible.push({ language: language as ParserLanguageId, path: filePath });
    else unsupported.push(relative(root, filePath));
  }
  const scanLimit = input.scan_limit ?? 500;
  const selectedEligible = eligible.slice(0, scanLimit);
  const limited = eligible
    .slice(scanLimit)
    .map((item) => relative(root, item.path));
  const files: NativeFile[] = [];
  const unreadable: string[] = [];
  for (const item of selectedEligible) {
    throwIfAborted(signal);
    try {
      const source = await sourceFor(item.path, workspace, signal);
      throwIfAborted(signal);
      const facts = parseSource({ languageId: item.language, source });
      files.push({ facts, path: item.path, source });
    } catch {
      if (signal?.aborted) throw abortError(signal);
      unreadable.push(relative(root, item.path));
    }
  }
  const omittedPathCount =
    unsupported.length + limited.length + unreadable.length;
  return {
    files,
    root,
    scan: {
      candidates: selected.length,
      eligible: eligible.length,
      exhaustive: limited.length === 0 && unreadable.length === 0,
      omissions: {
        scanLimit: limited.length,
        unreadable: unreadable.length,
        unsupported: unsupported.length,
      },
      omittedPaths: {
        scanLimit: limited.slice(0, MAX_OMITTED_PATHS),
        unreadable: unreadable.slice(0, MAX_OMITTED_PATHS),
        unsupported: unsupported.slice(0, MAX_OMITTED_PATHS),
      },
      omittedPathsTruncated: omittedPathCount > MAX_OMITTED_PATHS,
      parsed: files.length,
      truncated: limited.length > 0,
    },
  };
}

async function generationFor(
  workspace: WorkspaceHandle | undefined,
): Promise<string | null> {
  if (!workspace) return null;
  try {
    const store = await LanceIntelligenceStore.open(workspace.storageDomain, {
      access: "read-only",
    });
    try {
      return (
        (
          await store.latestGeneration(workspace.workspaceId, {
            timeoutMs: 1_000,
          })
        )?.generationId ?? null
      );
    } finally {
      await store.shutdownCoordinator();
    }
  } catch {
    return null;
  }
}

function emptyScanCoverage(): ScanCoverage {
  return {
    candidates: 0,
    eligible: 0,
    exhaustive: true,
    omissions: { scanLimit: 0, unreadable: 0, unsupported: 0 },
    omittedPaths: { scanLimit: [], unreadable: [], unsupported: [] },
    omittedPathsTruncated: false,
    parsed: 0,
    truncated: false,
  };
}

type NativeExecutionState = { scan: ScanCoverage };

function outputOmissions(payload: Record<string, unknown>): number {
  let omitted = 0;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const returned = Array.isArray(record.items)
      ? record.items.length
      : Array.isArray(record.files)
        ? record.files.length
        : undefined;
    if (typeof record.total === "number" && returned !== undefined) {
      omitted += Math.max(0, record.total - returned);
      return;
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(payload);
  if (omitted === 0 && payload.truncated === true) return 1;
  return omitted;
}

function compactIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(value.lastIndexOf(":") + 1, value.lastIndexOf(":") + 11);
}

function compactScan(scan: ScanCoverage) {
  const omitted =
    scan.omissions.scanLimit +
    scan.omissions.unreadable +
    scan.omissions.unsupported;
  return {
    candidates: scan.candidates,
    eligible: scan.eligible,
    omitted: omitted === 0 ? 0 : scan.omissions,
    parsed: scan.parsed,
    ...(omitted === 0
      ? {}
      : {
          paths: scan.omittedPaths,
          pathsTruncated: scan.omittedPathsTruncated,
        }),
    truncated: scan.truncated,
  };
}

async function withScopeMetadata(
  payload: Record<string, unknown>,
  scan: ScanCoverage,
  resultOmissions = 0,
): Promise<Record<string, unknown>> {
  const workspace = currentWorkspace();
  return {
    ...payload,
    generation: await generationFor(workspace),
    repository: workspace?.repositoryId ?? null,
    revision: workspace?.selectedRevision.revisionId ?? null,
    scan: compactScan(scan),
    truncated: payload.truncated === true || resultOmissions > 0,
    workspace: workspace?.workspaceId ?? null,
  };
}

function compactVisiblePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const visible: Record<string, unknown> = {
    ...payload,
    generation: compactIdentity(payload.generation as string | null),
    repository: compactIdentity(payload.repository as string | null),
    revision: compactIdentity(payload.revision as string | null),
    workspace: compactIdentity(payload.workspace as string | null),
  };
  if (
    visible.truncated === false &&
    typeof visible.total === "number" &&
    Array.isArray(visible.items) &&
    visible.total === visible.items.length
  )
    delete visible.total;
  return visible;
}

function symbolView(file: NativeFile, root: string, includeSource = false) {
  return file.facts.symbols.map((symbol) => ({
    exported: symbol.exported,
    kind: symbol.kind,
    name: symbol.name,
    path: relative(root, file.path),
    qualifiedName: symbol.qualifiedName,
    range: {
      endLine: symbol.range.end.line + 1,
      startLine: symbol.range.start.line + 1,
    },
    ...(includeSource
      ? {
          source: file.source.slice(
            symbol.range.startCoordinate.utf16Offset,
            symbol.range.endCoordinate.utf16Offset,
          ),
        }
      : {}),
  }));
}

function symbolMatches(file: NativeFile, target: string) {
  return file.facts.symbols.filter(
    (symbol) =>
      symbol.name === target ||
      symbol.qualifiedName === target ||
      symbol.qualifiedName.endsWith(`.${target}`),
  );
}

type CallView = {
  callee: string;
  caller: string | null;
  line?: number;
  path: string;
  range?: { endLine: number; startLine: number };
};

function callsFor(
  files: NativeFile[],
  root: string,
  target: string,
  direction: "in" | "out",
  fullRange = false,
  signal?: AbortSignal,
): CallView[] {
  throwIfAborted(signal);
  const symbols = new Map(
    flatMapFilesWithAbort(files, signal, (file) =>
      file.facts.symbols.map((symbol) => {
        throwIfAborted(signal);
        return [symbol.id, symbol.qualifiedName] as const;
      }),
    ),
  );
  const symbolIds = new Set(
    flatMapFilesWithAbort(files, signal, (file) =>
      symbolMatches(file, target).map((symbol) => {
        throwIfAborted(signal);
        return symbol.id;
      }),
    ),
  );
  const views: CallView[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    for (const call of file.facts.calls) {
      throwIfAborted(signal);
      const selected =
        direction === "in"
          ? call.callee === target || call.callee.endsWith(`.${target}`)
          : call.enclosingSymbolId !== null &&
            symbolIds.has(call.enclosingSymbolId);
      if (!selected) continue;
      views.push({
        callee: call.callee,
        caller:
          call.enclosingSymbolId === null
            ? null
            : (symbols.get(call.enclosingSymbolId) ?? null),
        path: relative(root, file.path),
        ...(fullRange
          ? {
              range: {
                endLine: call.range.end.line + 1,
                startLine: call.range.start.line + 1,
              },
            }
          : { line: call.range.start.line + 1 }),
      });
    }
  }
  return views.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      (left.line ?? left.range?.startLine ?? 0) -
        (right.line ?? right.range?.startLine ?? 0) ||
      left.callee.localeCompare(right.callee),
  );
}

function tracedCalls(
  files: NativeFile[],
  root: string,
  target: string,
  direction: "in" | "out",
  depth: number,
  fullRange: boolean,
  signal?: AbortSignal,
): CallView[] {
  const results = new Map<string, CallView>();
  let frontier = [target];
  const visited = new Set<string>();
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next = new Set<string>();
    for (const current of frontier.sort()) {
      throwIfAborted(signal);
      if (visited.has(current)) continue;
      visited.add(current);
      for (const call of callsFor(
        files,
        root,
        current,
        direction,
        fullRange,
        signal,
      )) {
        throwIfAborted(signal);
        results.set(JSON.stringify(call), call);
        const adjacent = direction === "out" ? call.callee : call.caller;
        if (adjacent && !visited.has(adjacent)) next.add(adjacent);
      }
    }
    frontier = [...next];
  }
  return [...results.values()];
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character);
    if (bytes + next > maxBytes) break;
    result += character;
    bytes += next;
  }
  return result;
}

function bounded<T>(
  values: T[],
  input: ToolInput,
): { items: T[]; total: number; truncated: boolean } {
  const limit = input.limit ?? input.top_k ?? 200;
  const byteLimit = input.budget ?? Number.POSITIVE_INFINITY;
  const items: T[] = [];
  let bytes = 2;
  for (const value of values.slice(0, limit)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(value));
    const separatorBytes = items.length === 0 ? 0 : 1;
    if (bytes + itemBytes + separatorBytes > byteLimit) break;
    items.push(value);
    bytes += itemBytes + separatorBytes;
  }
  return {
    items,
    total: values.length,
    truncated: items.length < values.length,
  };
}

type ImportEdge = {
  ambiguous: boolean;
  external: boolean;
  from: string;
  to: string;
};

type CompilerAlias = {
  hasWildcard: boolean;
  prefix: string;
  suffix: string;
  targets: string[];
};

async function compilerAliases(
  root: string,
  workspace: WorkspaceHandle | undefined,
  signal?: AbortSignal,
): Promise<CompilerAlias[]> {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    try {
      const source = await sourceFor(path.join(root, name), workspace, signal);
      const config = Bun.JSONC.parse(source) as {
        compilerOptions?: {
          baseUrl?: string;
          paths?: Record<string, string[]>;
        };
      };
      const baseUrl = path.posix.normalize(
        config.compilerOptions?.baseUrl?.replaceAll("\\", "/") ?? ".",
      );
      return Object.entries(config.compilerOptions?.paths ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([pattern, targets]) => {
          const marker = pattern.indexOf("*");
          if (marker !== pattern.lastIndexOf("*")) return [];
          const hasWildcard = marker >= 0;
          const validTargets = targets.filter((target) => {
            const targetMarker = target.indexOf("*");
            return (
              targetMarker === target.lastIndexOf("*") &&
              (hasWildcard || targetMarker < 0)
            );
          });
          return [
            {
              hasWildcard,
              prefix: marker < 0 ? pattern : pattern.slice(0, marker),
              suffix: marker < 0 ? "" : pattern.slice(marker + 1),
              targets: validTargets.map((target) =>
                path.posix.normalize(path.posix.join(baseUrl, target)),
              ),
            },
          ];
        });
    } catch {
      if (signal?.aborted) throw abortError(signal);
      // The workspace does not define compiler aliases in this file.
    }
  }
  return [];
}

function resolveKnownPath(
  candidate: string,
  known: readonly string[],
): string[] {
  const normalized = path.posix.normalize(candidate);
  if (path.posix.extname(normalized)) {
    return known.filter((entry) => entry === normalized);
  }
  return known.filter(
    (entry) =>
      entry === normalized ||
      entry.replace(/\.[^./]+$/u, "") === normalized ||
      entry.startsWith(`${normalized}/index.`),
  );
}

function substituteAliasWildcard(target: string, value: string): string {
  const marker = target.indexOf("*");
  if (marker < 0) return target;
  return `${target.slice(0, marker)}${value}${target.slice(marker + 1)}`;
}

function aliasCandidates(
  specifier: string,
  aliases: readonly CompilerAlias[],
): string[] {
  return aliases.flatMap((alias) => {
    if (!alias.hasWildcard) {
      return specifier === alias.prefix ? alias.targets : [];
    }
    if (
      !specifier.startsWith(alias.prefix) ||
      !specifier.endsWith(alias.suffix)
    )
      return [];
    const captureStart = alias.prefix.length;
    const captureEnd = specifier.length - alias.suffix.length;
    if (captureEnd < captureStart) return [];
    const value = specifier.slice(captureStart, captureEnd);
    return alias.targets.map((target) =>
      substituteAliasWildcard(target, value),
    );
  });
}

async function importGraph(
  files: NativeFile[],
  root: string,
  signal?: AbortSignal,
): Promise<ImportEdge[]> {
  const known = files.map((file) => relative(root, file.path)).sort();
  const workspace = currentWorkspace();
  const aliases = await compilerAliases(root, workspace, signal);
  const raw = files.flatMap((file) => {
    throwIfAborted(signal);
    const from = relative(root, file.path);
    return [
      ...file.facts.imports.map((entry) => ({
        from,
        source: entry.source,
      })),
      ...file.facts.exports
        .filter(
          (entry): entry is typeof entry & { source: string } =>
            entry.source !== null,
        )
        .map((entry) => ({ from, source: entry.source })),
    ];
  });
  const edges = new Map<string, ImportEdge>();
  for (const edge of raw) {
    throwIfAborted(signal);
    const candidates = edge.source.startsWith(".")
      ? [
          path.posix.normalize(
            path.posix.join(path.posix.dirname(edge.from), edge.source),
          ),
        ]
      : aliasCandidates(edge.source, aliases);
    const matches = [
      ...new Set(
        candidates.flatMap((candidate) => resolveKnownPath(candidate, known)),
      ),
    ].sort();
    if (matches.length === 0) {
      const unresolved: ImportEdge = {
        ambiguous: false,
        external: true,
        from: edge.from,
        to: edge.source,
      };
      edges.set(JSON.stringify(unresolved), unresolved);
      continue;
    }
    for (const target of matches) {
      const resolved: ImportEdge = {
        ambiguous: matches.length > 1,
        external: false,
        from: edge.from,
        to: target,
      };
      edges.set(JSON.stringify(resolved), resolved);
    }
  }
  return [...edges.values()].sort(
    (left, right) =>
      left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

function graphCycles(
  edges: readonly ImportEdge[],
  maxCycles: number,
  signal?: AbortSignal,
): { cycles: string[]; truncated: boolean } {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.external) continue;
    const targets = adjacency.get(edge.from) ?? [];
    if (!targets.includes(edge.to)) targets.push(edge.to);
    adjacency.set(edge.from, targets.sort());
  }
  const state = new Map<string, "active" | "done">();
  const stack: string[] = [];
  const positions = new Map<string, number>();
  const cycles = new Set<string>();

  const canonicalCycle = (nodes: string[]): string => {
    const body = nodes.slice(0, -1);
    const rotations = body.map((_, index) => [
      ...body.slice(index),
      ...body.slice(0, index),
    ]);
    const canonical = rotations
      .map((rotation) => rotation.join(" -> "))
      .sort()[0];
    return `${canonical} -> ${canonical?.split(" -> ")[0] ?? ""}`;
  };

  const visit = (node: string): void => {
    throwIfAborted(signal);
    state.set(node, "active");
    positions.set(node, stack.length);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (cycles.size > maxCycles) break;
      const nextState = state.get(next);
      if (nextState === "active") {
        const index = positions.get(next) as number;
        cycles.add(canonicalCycle([...stack.slice(index), next]));
      } else if (nextState !== "done") {
        visit(next);
      }
    }
    stack.pop();
    positions.delete(node);
    state.set(node, "done");
  };

  for (const node of [...adjacency.keys()].sort()) {
    if (cycles.size > maxCycles) break;
    if (!state.has(node)) visit(node);
  }
  return {
    cycles: [...cycles].sort().slice(0, maxCycles),
    truncated: cycles.size > maxCycles,
  };
}

function flatMapFilesWithAbort<T>(
  files: readonly NativeFile[],
  signal: AbortSignal | undefined,
  transform: (file: NativeFile) => readonly T[],
): T[] {
  const result: T[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    result.push(...transform(file));
  }
  return result;
}

async function executeNative(
  name: (typeof TOOL_NAMES)[number],
  input: ToolInput,
  state: NativeExecutionState,
  signal?: AbortSignal,
) {
  if (name === "squeeze") {
    throwIfAborted(signal);
    const text = input.text ?? input.query ?? "";
    const compact = text.replace(/\s+/g, " ").trim();
    const budget = input.budget ?? 8_000;
    const boundedText = utf8Prefix(compact, budget);
    return {
      schema: "ast-mcp.squeeze.v1",
      text: boundedText,
      truncated: boundedText !== compact,
    };
  }
  if (name === "run" && input.write)
    throw Object.assign(
      new Error(
        "run write mode is replaced by hash-guarded file_patch with patchStrategy=ast",
      ),
      {
        code: "use_file_patch",
        retryable: true,
        suggestedNextCall: "file_hash then file_patch",
      },
    );
  const graphOperation = [
    "deps",
    "reverse_deps",
    "cycles",
    "graph",
    "impact",
  ].includes(name);
  const scanInput =
    graphOperation && (input.file || input.path)
      ? { ...input, file: undefined, path: undefined }
      : input;
  const { files, root, scan } = await loadFiles(scanInput, signal);
  throwIfAborted(signal);
  state.scan = scan;
  const schema = `ast-mcp.${name}.v1`;
  if (name === "map" || name === "digest") {
    const mapped = flatMapFilesWithAbort(files, signal, (file) => [
      {
        diagnostics: file.facts.diagnostics,
        language: file.facts.languageId,
        partial: file.facts.partial,
        path: relative(root, file.path),
        symbols: symbolView(file, root).slice(
          0,
          input.max_members ?? (name === "digest" ? 50 : 200),
        ),
      },
    ]);
    const result = bounded(mapped, input);
    return {
      files: result.items,
      scan,
      schema,
      total: result.total,
      truncated: result.truncated,
    };
  }
  if (name === "show") {
    const targets = new Set(
      input.symbols ?? (input.target ? [input.target] : []),
    );
    const symbols = files
      .flatMap((file) => {
        throwIfAborted(signal);
        return symbolView(file, root, true);
      })
      .filter(
        (symbol) =>
          targets.size === 0 ||
          targets.has(symbol.name) ||
          targets.has(symbol.qualifiedName),
      );
    return { scan, schema, ...bounded(symbols, input) };
  }
  if (name === "surface")
    return {
      schema,
      ...bounded(
        files
          .flatMap((file) => {
            throwIfAborted(signal);
            return symbolView(file, root);
          })
          .filter((symbol) => symbol.exported),
        input,
      ),
    };
  if (name === "implements") {
    const target = input.target ?? "";
    const items = flatMapFilesWithAbort(files, signal, (file) =>
      [...file.facts.implementations, ...file.facts.inheritance]
        .filter(
          (relationship) =>
            relationship.targetName === target ||
            relationship.targetName.endsWith(`.${target}`),
        )
        .map((relationship) => ({
          path: relative(root, file.path),
          range: relationship.range,
          target: relationship.targetName,
        })),
    );
    return { schema, ...bounded(items, input) };
  }
  if (name === "search" || name === "find_related") {
    const query = (
      input.query ??
      input.target ??
      input.path ??
      ""
    ).toLowerCase();
    const items = files
      .flatMap((file) => {
        throwIfAborted(signal);
        return symbolView(file, root, true);
      })
      .filter(
        (symbol) =>
          symbol.name.toLowerCase().includes(query) ||
          symbol.qualifiedName.toLowerCase().includes(query) ||
          symbol.source?.toLowerCase().includes(query),
      )
      .map(({ source, ...symbol }) => ({
        ...symbol,
        snippet: source?.slice(0, 1_000),
      }));
    return { schema, ...bounded(items, input) };
  }
  if (name === "run") {
    if (!input.pattern) throw new Error("run requires pattern");
    const items: Array<Record<string, unknown>> = [];
    for (const file of files) {
      throwIfAborted(signal);
      if (!input.rewrite) {
        items.push(
          ...findStructuralMatches(
            file.source,
            file.facts.languageId,
            input.pattern as string,
          ).map((match) => ({ ...match, path: relative(root, file.path) })),
        );
        throwIfAborted(signal);
        continue;
      }
      throwIfAborted(signal);
      const matches = findStructuralMatches(
        file.source,
        file.facts.languageId,
        input.pattern as string,
      );
      throwIfAborted(signal);
      const preview = rewriteStructuralMatches(
        file.source,
        file.facts.languageId,
        [
          {
            expectedMatches: matches.length,
            pattern: input.pattern as string,
            replacement: input.rewrite,
          },
        ],
      );
      throwIfAborted(signal);
      items.push(
        ...preview.edits.map((edit) => ({
          ...edit,
          path: relative(root, file.path),
        })),
      );
    }
    return { schema, ...bounded(items, input) };
  }
  const edges = await importGraph(files, root, signal);
  const visibleEdges = edges.filter((edge) => {
    throwIfAborted(signal);
    return (
      (!input.hide_external || !edge.external) &&
      (!input.hide_ambiguous || !edge.ambiguous)
    );
  });
  if (name === "graph")
    return {
      schema,
      ...bounded(visibleEdges, input),
    };
  if (name === "cycles") {
    const limit = input.limit ?? input.top_k ?? 200;
    const result = graphCycles(visibleEdges, limit, signal);
    return { ...result, schema };
  }
  if (name === "deps" || name === "reverse_deps") {
    const selectedPath = input.file ?? input.path;
    const selected = selectedPath
      ? relative(root, path.resolve(root, selectedPath))
      : "";
    const values = visibleEdges.filter((edge) =>
      name === "deps" ? edge.from === selected : edge.to === selected,
    );
    return { schema, ...bounded(values, input) };
  }
  const target = input.target ?? "";
  const fullRange = input.detail === "full";
  const depth = input.direct ? 1 : (input.depth ?? 1);
  const callers = tracedCalls(
    files,
    root,
    target,
    "in",
    depth,
    fullRange,
    signal,
  );
  const callees = tracedCalls(
    files,
    root,
    target,
    "out",
    depth,
    fullRange,
    signal,
  );
  if (name === "callers") return { schema, ...bounded(callers, input) };
  if (name === "callees") return { schema, ...bounded(callees, input) };
  if (name === "trace")
    return {
      callees: bounded(callees, input),
      callers: bounded(callers, input),
      depth,
      schema,
      target,
    };
  const dependents = edges.filter((edge) => {
    throwIfAborted(signal);
    return edge.to.includes(target);
  });
  const tests = [...callers, ...dependents].filter((item) => {
    throwIfAborted(signal);
    return (
      "path" in item &&
      /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(
        item.path,
      )
    );
  });
  if (name === "impact")
    return {
      callees: bounded(callees, input),
      callers: bounded(callers, input),
      dependents: bounded(dependents, input),
      schema,
      target,
      tests: bounded(tests, input),
    };
  const definitions = files
    .flatMap((file) => {
      throwIfAborted(signal);
      return symbolMatches(file, target).flatMap(() => {
        throwIfAborted(signal);
        return symbolView(file, root, true);
      });
    })
    .filter(
      (item) =>
        item.name === target || item.qualifiedName.endsWith(`.${target}`),
    );
  const budget = input.budget ?? 32_000;
  const payload = {
    callees: [] as typeof callees,
    callers: [] as typeof callers,
    definitions: [] as typeof definitions,
    schema,
    target,
    truncated: false,
  };
  const candidates = [
    ...definitions.map((item) => ["definitions", item] as const),
    ...callers.map((item) => ["callers", item] as const),
    ...callees.map((item) => ["callees", item] as const),
  ];
  for (const [section, item] of candidates) {
    throwIfAborted(signal);
    const candidate = {
      ...payload,
      [section]: [...payload[section], item],
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) > budget) {
      payload.truncated = true;
      break;
    }
    payload[section].push(item as never);
  }
  return payload;
}

export default function registerNativeCodeIntelligenceTools(
  server: McpServer,
  execute: ConfiguredExecution = localExecution,
) {
  for (const name of TOOL_NAMES) {
    server.registerTool(
      name,
      {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: true,
        },
        description: toolDescription(name),
        inputSchema,
        outputSchema: toolOutputSchema,
        title: `Native ${name.replaceAll("_", " ")}`,
      },
      async (input, context) => {
        try {
          const controller = new AbortController();
          const upstream = (context as { signal?: AbortSignal }).signal;
          const abortFromUpstream = () => controller.abort(upstream?.reason);
          if (upstream?.aborted) abortFromUpstream();
          else
            upstream?.addEventListener("abort", abortFromUpstream, {
              once: true,
            });
          const timer =
            input.timeout_ms === undefined
              ? undefined
              : setTimeout(
                  () =>
                    controller.abort(
                      Object.assign(
                        new Error("Code intelligence request timed out"),
                        { code: "timeout", retryable: true },
                      ),
                    ),
                  input.timeout_ms,
                );
          const data = await (async () => {
            try {
              return await execute(
                input,
                async () => {
                  const state = { scan: emptyScanCoverage() };
                  const payload = (await executeNative(
                    name,
                    input,
                    state,
                    controller.signal,
                  )) as Record<string, unknown>;
                  return withScopeMetadata(
                    payload,
                    state.scan,
                    outputOmissions(payload),
                  );
                },
                context,
                name,
              );
            } finally {
              if (timer !== undefined) clearTimeout(timer);
              upstream?.removeEventListener("abort", abortFromUpstream);
            }
          })();
          const result = toolSuccess(data);
          return {
            ...result,
            content: [
              {
                text: JSON.stringify(compactVisiblePayload(data)),
                type: "text" as const,
              },
            ],
          };
        } catch (error) {
          return toolFailure(error);
        }
      },
    );
  }
}

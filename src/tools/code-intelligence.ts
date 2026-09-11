import { readFile } from "node:fs/promises";
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
  defaultLanguageRegistry,
  findStructuralMatches,
  type ParserLanguageId,
  parseSource,
  rewriteStructuralMatches,
  type SyntaxFacts,
} from "../intelligence/parser/index.ts";
import { LanceIntelligenceStore } from "../intelligence/storage/index.ts";
import {
  currentWorkspace,
  readGitRevisionFile,
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

function sanitizedGitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("GIT_"))
      environment[name] = value;
  }
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

async function revisionFilePaths(
  workspace: WorkspaceHandle,
): Promise<string[]> {
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
): Promise<string[]> {
  const workspace = currentWorkspace();
  if (workspace && workspace.selectedRevision.selector.kind !== "working") {
    return selectedRevisionPaths(
      input,
      root,
      workspace,
      await revisionFilePaths(workspace),
    );
  }
  const explicit = [
    ...(input.paths ?? []),
    ...(input.file ? [input.file] : []),
    ...(input.path ? [input.path] : []),
  ];
  if (explicit.length) {
    const files: string[] = [];
    for (const value of explicit) {
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
        }))
          files.push(entry);
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
): Promise<string> {
  if (workspace && workspace.selectedRevision.selector.kind !== "working")
    return Buffer.from(
      await readGitRevisionFile(
        workspace.git,
        workspace.selectedRevision,
        filePath,
      ),
    ).toString("utf8");
  return readFile(filePath, "utf8");
}

async function loadFiles(
  input: ToolInput,
): Promise<{ files: NativeFile[]; root: string; scan: ScanCoverage }> {
  const root = await requestRoot(input);
  const selected = await requestedFiles(input, root);
  const config = await currentConfig();
  const workspace = currentWorkspace();
  const supported = new Set(
    defaultLanguageRegistry.list().map((grammar) => grammar.languageId),
  );
  const eligible: Array<{ language: ParserLanguageId; path: string }> = [];
  const unsupported: string[] = [];
  for (const filePath of selected) {
    const language = input.lang ?? detectAstLanguage(filePath);
    if (
      config.files.read.modes.includes("ast") &&
      language &&
      supported.has(language as ParserLanguageId)
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
    try {
      const source = await sourceFor(item.path, workspace);
      const facts = parseSource({ languageId: item.language, source });
      files.push({ facts, path: item.path, source });
    } catch {
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

function imports(files: NativeFile[], root: string) {
  return files.flatMap((file) =>
    file.facts.imports.map((entry) => ({
      from: relative(root, file.path),
      importedName: entry.importedName,
      source: entry.source,
      typeOnly: entry.typeOnly,
    })),
  );
}

function symbolMatches(file: NativeFile, target: string) {
  return file.facts.symbols.filter(
    (symbol) =>
      symbol.name === target ||
      symbol.qualifiedName === target ||
      symbol.qualifiedName.endsWith(`.${target}`),
  );
}

function callsFor(
  files: NativeFile[],
  root: string,
  target: string,
  direction: "in" | "out",
  fullRange = false,
) {
  const symbolIds = new Set(
    files.flatMap((file) =>
      symbolMatches(file, target).map((symbol) => symbol.id),
    ),
  );
  return files.flatMap((file) =>
    file.facts.calls
      .filter((call) =>
        direction === "in"
          ? call.callee === target || call.callee.endsWith(`.${target}`)
          : call.enclosingSymbolId !== null &&
            symbolIds.has(call.enclosingSymbolId),
      )
      .map((call) => ({
        callee: call.callee,
        path: relative(root, file.path),
        ...(fullRange
          ? {
              range: {
                endLine: call.range.end.line + 1,
                startLine: call.range.start.line + 1,
              },
            }
          : { line: call.range.start.line + 1 }),
      })),
  );
}

function bounded<T>(
  values: T[],
  input: ToolInput,
): { items: T[]; total: number; truncated: boolean } {
  const limit = input.limit ?? input.top_k ?? 200;
  return {
    items: values.slice(0, limit),
    total: values.length,
    truncated: values.length > limit,
  };
}

function importGraph(files: NativeFile[], root: string) {
  const known = new Set(files.map((file) => relative(root, file.path)));
  return imports(files, root).map((edge) => {
    let target = edge.source;
    if (target.startsWith(".")) {
      const base = path.posix.normalize(
        path.posix.join(path.posix.dirname(edge.from), target),
      );
      target =
        [...known].find(
          (candidate) =>
            candidate === base ||
            candidate.replace(/\.[^.]+$/, "") === base ||
            candidate.startsWith(`${base}/index.`),
        ) ?? target;
    }
    return { external: !known.has(target), from: edge.from, to: target };
  });
}

function graphCycles(
  edges: Array<{ from: string; to: string; external: boolean }>,
) {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges)
    if (!edge.external)
      adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  const cycles = new Set<string>();
  const visit = (node: string, stack: string[]) => {
    const index = stack.indexOf(node);
    if (index >= 0) {
      cycles.add([...stack.slice(index), node].join(" -> "));
      return;
    }
    for (const next of adjacency.get(node) ?? []) visit(next, [...stack, node]);
  };
  for (const node of adjacency.keys()) visit(node, []);
  return [...cycles].sort();
}

async function executeNative(
  name: (typeof TOOL_NAMES)[number],
  input: ToolInput,
  state: NativeExecutionState,
) {
  if (name === "squeeze") {
    const text = input.text ?? input.query ?? "";
    const compact = text.replace(/\s+/g, " ").trim();
    const budget = input.budget ?? 8_000;
    return {
      schema: "ast-mcp.squeeze.v1",
      text: compact.slice(0, budget),
      truncated: compact.length > budget,
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
  const { files, root, scan } = await loadFiles(input);
  state.scan = scan;
  const schema = `ast-mcp.${name}.v1`;
  if (name === "map" || name === "digest") {
    const mapped = files.map((file) => ({
      diagnostics: file.facts.diagnostics,
      language: file.facts.languageId,
      partial: file.facts.partial,
      path: relative(root, file.path),
      symbols: symbolView(file, root).slice(
        0,
        input.max_members ?? (name === "digest" ? 50 : 200),
      ),
    }));
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
      .flatMap((file) => symbolView(file, root, true))
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
          .flatMap((file) => symbolView(file, root))
          .filter((symbol) => symbol.exported),
        input,
      ),
    };
  if (name === "implements") {
    const target = input.target ?? "";
    const items = files.flatMap((file) =>
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
      .flatMap((file) => symbolView(file, root, true))
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
      if (!input.rewrite) {
        items.push(
          ...findStructuralMatches(
            file.source,
            file.facts.languageId,
            input.pattern as string,
          ).map((match) => ({ ...match, path: relative(root, file.path) })),
        );
        continue;
      }
      const matches = findStructuralMatches(
        file.source,
        file.facts.languageId,
        input.pattern as string,
      );
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
      items.push(
        ...preview.edits.map((edit) => ({
          ...edit,
          path: relative(root, file.path),
        })),
      );
    }
    return { schema, ...bounded(items, input) };
  }
  const edges = importGraph(files, root);
  if (name === "graph")
    return {
      schema,
      ...bounded(
        input.hide_external ? edges.filter((edge) => !edge.external) : edges,
        input,
      ),
    };
  if (name === "cycles") return { cycles: graphCycles(edges), schema };
  if (name === "deps" || name === "reverse_deps") {
    const selected = input.file
      ? relative(root, path.resolve(root, input.file))
      : "";
    const values = edges.filter((edge) =>
      name === "deps" ? edge.from === selected : edge.to === selected,
    );
    return { schema, ...bounded(values, input) };
  }
  const target = input.target ?? "";
  const fullRange = input.detail === "full";
  const callers = callsFor(files, root, target, "in", fullRange);
  const callees = callsFor(files, root, target, "out", fullRange);
  if (name === "callers") return { schema, ...bounded(callers, input) };
  if (name === "callees") return { schema, ...bounded(callees, input) };
  if (name === "trace")
    return {
      callees: bounded(callees, input),
      callers: bounded(callers, input),
      schema,
      target,
    };
  const dependents = edges.filter((edge) => edge.to.includes(target));
  const tests = [...callers, ...dependents].filter(
    (item) =>
      "path" in item &&
      /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(
        item.path,
      ),
  );
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
    .flatMap((file) =>
      symbolMatches(file, target).flatMap(() => symbolView(file, root, true)),
    )
    .filter(
      (item) =>
        item.name === target || item.qualifiedName.endsWith(`.${target}`),
    );
  const budget = input.budget ?? 32_000;
  const payload = { callees, callers, definitions, schema, target };
  const serialized = JSON.stringify(payload);
  return serialized.length <= budget
    ? payload
    : { schema, target, text: serialized.slice(0, budget), truncated: true };
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
          const data = await execute(
            input,
            async () => {
              const state = { scan: emptyScanCoverage() };
              const payload = (await executeNative(
                name,
                input,
                state,
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

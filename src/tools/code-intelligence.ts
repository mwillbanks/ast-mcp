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
  LANGUAGE_CAPABILITY_CATALOG,
  type ParserLanguageId,
} from "../intelligence/parser/index.ts";
import { LanceIntelligenceStore } from "../intelligence/storage/index.ts";
import {
  currentWorkspace,
  readGitRevisionFile,
  type WorkspaceHandle,
} from "../intelligence/workspace/index.ts";
import { detectAstLanguage } from "../patch/languages";
import { assertReadableTree } from "../runtime/path-policy";
import { resolveIntelligencePath } from "../runtime/paths";
import { terminateProcessTree } from "../runtime/subprocess";
import type { CompilerAlias, NativeFile } from "./code-intelligence-compute.ts";
import type { CpuJob, CpuReply } from "./code-intelligence-worker.ts";
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

export type ToolInput = z.infer<typeof inputSchema>;
export type ToolName = (typeof TOOL_NAMES)[number];

function schemaFor(name: ToolName) {
  const selection = [
    "paths",
    "file",
    "path",
    "root",
    "glob",
    "lang",
    "languages",
    "scan_limit",
  ];
  const output = ["budget", "limit", "top_k", "timeout_ms", "workspaceId"];
  const specific: Record<ToolName, string[]> = {
    map: ["detail", "max_members"],
    digest: ["detail", "max_members"],
    show: ["symbols", "target", "detail"],
    surface: [],
    implements: ["target"],
    deps: ["hide_ambiguous", "hide_external"],
    reverse_deps: ["hide_ambiguous", "hide_external"],
    graph: ["hide_ambiguous", "hide_external"],
    cycles: ["hide_ambiguous", "hide_external"],
    search: ["query", "target"],
    find_related: ["query", "target"],
    callers: ["target", "depth", "direct", "detail"],
    callees: ["target", "depth", "direct", "detail"],
    trace: ["target", "depth", "direct", "detail"],
    impact: [
      "target",
      "depth",
      "direct",
      "detail",
      "hide_ambiguous",
      "hide_external",
    ],
    context: ["target", "depth", "direct", "detail"],
    run: ["pattern", "rewrite", "write", "json"],
    squeeze: ["text", "query"],
  };
  const fields =
    name === "squeeze"
      ? [...output, ...specific[name]]
      : [...selection, ...output, ...specific[name]];
  if (name === "impact") {
    fields.splice(fields.indexOf("file"), 1);
    fields.splice(fields.indexOf("path"), 1);
  }
  const mask = Object.fromEntries(fields.map((field) => [field, true])) as {
    [K in keyof ToolInput]: true;
  };
  return inputSchema.pick(mask).superRefine((input, context) => {
    const requireOne = (keys: (keyof ToolInput)[]) => {
      if (!keys.some((key) => input[key] !== undefined))
        context.addIssue({
          code: "custom",
          message: `${name} requires ${keys.join(" or ")}; narrow scans with paths or glob`,
          path: [keys[0] as string],
        });
    };
    if (
      [
        "callers",
        "callees",
        "trace",
        "impact",
        "context",
        "implements",
      ].includes(name)
    )
      requireOne(["target"]);
    if (["deps", "reverse_deps"].includes(name)) requireOne(["file", "path"]);
    if (["search", "find_related"].includes(name))
      requireOne(["query", "target", "path"]);
    if (name === "run") requireOne(["pattern"]);
    if (name === "squeeze") requireOne(["text", "query"]);
  });
}

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
  const resolved = await resolveIntelligencePath(
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

async function boundedGitInventory(
  directory: string,
  args: string[],
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && !name.startsWith("GIT_"),
    ),
  ) as Record<string, string>;
  env.GIT_OPTIONAL_LOCKS = "0";
  const child = Bun.spawn(["git", "-C", directory, ...args], {
    detached: process.platform !== "win32",
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let termination: Promise<void> | undefined;
  let exceeded: Error | undefined;
  const terminate = () => {
    termination ??= terminateProcessTree(child, { graceMs: 250 });
  };
  signal?.addEventListener("abort", terminate, { once: true });
  if (signal?.aborted) terminate();
  const collect = async (
    stream: ReadableStream<Uint8Array>,
    limit: number,
    inventory: boolean,
  ) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let paths = 0;
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (inventory) for (const byte of chunk) if (byte === 0) paths += 1;
      if (bytes > limit || paths > MAX_CANDIDATE_PATHS) {
        exceeded ??= capacityError(
          inventory
            ? "Git inventory exceeds 100000 paths or 16 MiB"
            : "Git diagnostics exceed 16 KiB",
        );
        terminate();
      }
      if (!exceeded) chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      collect(child.stdout, MAX_REQUEST_BYTES, true),
      collect(child.stderr, 16 * 1024, false),
    ]);
    throwIfAborted(signal);
    if (exceeded) throw exceeded;
    return { code, stdout, stderr: stderr.toString("utf8").trim() };
  } catch (error) {
    terminate();
    throw error;
  } finally {
    signal?.removeEventListener("abort", terminate);
    if (termination) await termination;
  }
}

async function revisionFilePaths(
  workspace: WorkspaceHandle,
  signal?: AbortSignal,
  scopes: string[] = [],
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
  if (scopes.length)
    args.push("--", ...scopes.map((scope) => `:(literal)${scope}`));
  const { code, stderr, stdout } = await boundedGitInventory(
    workspace.checkoutRoot,
    args,
    signal,
  );
  if (code !== 0)
    throw Object.assign(
      new Error(stderr || `Git failed with exit code ${code}`),
      { code: "workspace_git_failure", retryable: false },
    );
  const files = Buffer.from(stdout)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (files.length > MAX_CANDIDATE_PATHS)
    throw capacityError("File inventory exceeds 100000 paths");
  return files.sort();
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
    const scopes = requestedRelativePaths(input, root).map((entry) =>
      relative(workspace.checkoutRoot, path.resolve(root, entry)),
    );
    if (!scopes.length && root !== workspace.checkoutRoot)
      scopes.push(relative(workspace.checkoutRoot, root));
    const repositoryPaths = await revisionFilePaths(workspace, signal, scopes);
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
      const resolved = await resolveIntelligencePath(path.resolve(root, value));
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
          if (files.length >= MAX_CANDIDATE_PATHS)
            throw capacityError("File inventory exceeds 100000 paths");
          files.push(entry);
          if (files.length % 128 === 0) await Bun.sleep(0);
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
    ) {
      if (files.length >= MAX_CANDIDATE_PATHS)
        throw capacityError("File inventory exceeds 100000 paths");
      files.push(entry);
      if (files.length % 128 === 0) await Bun.sleep(0);
    }
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
  const file = Bun.file(filePath);
  if ((await file.stat()).size > MAX_SOURCE_BYTES)
    throw capacityError("Source exceeds the parser byte limit");
  return file.text();
}

function abortError(signal: AbortSignal): Error {
  if (
    signal.reason instanceof Error &&
    "code" in signal.reason &&
    typeof signal.reason.code === "string"
  )
    return signal.reason;
  return Object.assign(new Error("Code intelligence request was aborted"), {
    code: "aborted",
    retryable: true,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

const LANGUAGE_EXTENSIONS = LANGUAGE_CAPABILITY_CATALOG.flatMap((entry) =>
  entry.extensions.map((extension) => ({ entry, extension })),
).sort((left, right) => right.extension.length - left.extension.length);

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
    LANGUAGE_EXTENSIONS.find(({ extension }) =>
      name.endsWith(extension.toLowerCase()),
    )?.entry.languageId ??
    detectAstLanguage(filePath) ??
    null
  );
}

async function loadFiles(
  input: ToolInput,
  signal: AbortSignal,
  cpu: RequestCpu,
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
  for (const [index, filePath] of selected.entries()) {
    if (index % 64 === 0) await Bun.sleep(0);
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
  let sourceBytes = 0;
  for (const item of selectedEligible) {
    throwIfAborted(signal);
    try {
      if (
        (!workspace ||
          workspace.selectedRevision.selector.kind === "working") &&
        (await Bun.file(item.path).stat()).size > MAX_SOURCE_BYTES
      )
        throw capacityError("Source exceeds the parser byte limit");
      const source = await sourceFor(item.path, workspace, signal);
      const bytes = Buffer.byteLength(source);
      if (bytes > MAX_SOURCE_BYTES)
        throw capacityError("Source exceeds the parser byte limit");
      sourceBytes += bytes;
      if (sourceBytes > MAX_REQUEST_BYTES)
        throw capacityError("Selected sources exceed the request byte limit");
      throwIfAborted(signal);
      const facts = await cpu.run<NativeFile["facts"]>({
        kind: "parse",
        languageId: item.language,
        source,
      });
      files.push({ facts, path: item.path, source });
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if ((error as { code?: string })?.code === "intelligence_budget_exceeded")
        throw error;
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

async function compilerAliases(
  root: string,
  workspace: WorkspaceHandle | undefined,
  signal: AbortSignal,
  cpu: RequestCpu,
): Promise<CompilerAlias[]> {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    try {
      const source = await sourceFor(path.join(root, name), workspace, signal);
      if (Buffer.byteLength(source) > MAX_SOURCE_BYTES)
        throw capacityError(
          "Compiler configuration exceeds the parser byte limit",
        );
      const config = await cpu.run<{
        compilerOptions?: {
          baseUrl?: string;
          paths?: Record<string, string[]>;
        };
      }>({ kind: "compiler-config", source });
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
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if ((error as { code?: string })?.code === "intelligence_budget_exceeded")
        throw error;
      // The workspace does not define compiler aliases in this file.
    }
  }
  return [];
}

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 4;
const MAX_CANDIDATE_PATHS = 100_000;
let activeRequests = 0;

function capacityError(message: string) {
  return Object.assign(new Error(message), {
    code: "intelligence_budget_exceeded",
    retryable: true,
    suggestedNextCall: "Retry with narrower paths, glob, or scan_limit",
  });
}

async function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => reject(abortError(signal));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

class RequestCpu {
  readonly worker = new Worker(
    new URL("./code-intelligence-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  readonly signal: AbortSignal;
  transferredBytes = 0;
  readonly abort = () => this.worker.terminate();
  constructor(signal: AbortSignal) {
    this.signal = signal;
    signal.addEventListener("abort", this.abort, { once: true });
  }
  async run<T>(job: CpuJob): Promise<T> {
    throwIfAborted(this.signal);
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        this.worker.removeEventListener("message", message);
        this.worker.removeEventListener("error", failed);
        this.signal.removeEventListener("abort", aborted);
      };
      const message = (event: MessageEvent<CpuReply>) => {
        cleanup();
        if (event.data.ok) {
          this.transferredBytes += event.data.bytes;
          if (this.transferredBytes > MAX_REQUEST_BYTES)
            reject(capacityError("Parsed data exceeds the request byte limit"));
          else resolve(event.data.value as T);
        } else
          reject(
            Object.assign(
              new Error(event.data.error.message),
              event.data.error,
            ),
          );
      };
      const failed = (event: ErrorEvent) => {
        cleanup();
        reject(
          Object.assign(
            new Error(event.message || "Code intelligence worker failed"),
            { code: "worker_error", retryable: true },
          ),
        );
      };
      const aborted = () => {
        cleanup();
        this.worker.terminate();
        reject(abortError(this.signal));
      };
      this.worker.addEventListener("message", message);
      this.worker.addEventListener("error", failed);
      this.signal.addEventListener("abort", aborted, { once: true });
      try {
        this.worker.postMessage(job);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
  close() {
    this.signal.removeEventListener("abort", this.abort);
    this.worker.terminate();
  }
}

async function executeNative(
  name: ToolName,
  input: ToolInput,
  state: NativeExecutionState,
  signal: AbortSignal,
) {
  if (activeRequests >= MAX_ACTIVE_REQUESTS)
    throw capacityError("Code intelligence request capacity is full");
  activeRequests += 1;
  let cpu: RequestCpu | undefined;
  try {
    throwIfAborted(signal);
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
    cpu = new RequestCpu(signal);
    if (name === "squeeze")
      return await cpu.run({
        kind: "compute",
        name,
        input,
        files: [],
        root: "",
        aliases: [],
      });
    return await withAbort(
      (async () => {
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
        const { files, root, scan } = await loadFiles(
          scanInput,
          signal,
          cpu as RequestCpu,
        );
        state.scan = scan;
        const aliases = graphOperation
          ? await compilerAliases(
              root,
              currentWorkspace(),
              signal,
              cpu as RequestCpu,
            )
          : [];
        return await (cpu as RequestCpu).run({
          kind: "compute",
          name,
          input,
          files,
          root,
          aliases,
        });
      })(),
      signal,
    );
  } finally {
    cpu?.close();
    activeRequests -= 1;
  }
}

export default function registerNativeCodeIntelligenceTools(
  server: McpServer,
  execute: ConfiguredExecution = localExecution,
) {
  const controllers = new Set<AbortController>();
  let closed = false;
  if (typeof server.close === "function") {
    const closeServer = server.close.bind(server);
    server.close = () => {
      closed = true;
      for (const controller of controllers)
        controller.abort(
          Object.assign(new Error("Code intelligence server closed"), {
            code: "aborted",
            retryable: true,
          }),
        );
      return closeServer();
    };
  }
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
        inputSchema: schemaFor(name),
        outputSchema: toolOutputSchema,
        title: `Native ${name.replaceAll("_", " ")}`,
      },
      async (input, context) => {
        try {
          if (closed)
            throw Object.assign(new Error("Code intelligence server closed"), {
              code: "aborted",
              retryable: true,
            });
          const controller = new AbortController();
          controllers.add(controller);
          const upstream = (context as { signal?: AbortSignal }).signal;
          const abortFromUpstream = () => controller.abort(upstream?.reason);
          if (upstream?.aborted) abortFromUpstream();
          else
            upstream?.addEventListener("abort", abortFromUpstream, {
              once: true,
            });
          const timer = setTimeout(
            () =>
              controller.abort(
                Object.assign(
                  new Error("Code intelligence request timed out"),
                  {
                    code: "timeout",
                    retryable: true,
                    suggestedNextCall:
                      "Retry with narrower paths, glob, or scan_limit",
                  },
                ),
              ),
            input.timeout_ms ?? 30_000,
          );
          const data = await (async () => {
            try {
              return await withAbort(
                execute(
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
                ),
                controller.signal,
              );
            } finally {
              controllers.delete(controller);
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

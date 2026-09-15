import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio.js";
import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../src/intelligence/contracts/common.ts";
import {
  createStorageDomainId,
  type StorageDomain,
} from "../src/intelligence/contracts/storage.ts";
import {
  createRepositoryId,
  createRevisionId,
  createWorkspaceId,
} from "../src/intelligence/contracts/workspace.ts";
import { ParserWorkerPool } from "../src/intelligence/parser/pool.ts";
import {
  type EmbeddingProvider,
  EmbeddingWorkerPool,
  normalizeEmbedding,
} from "../src/intelligence/retrieval/embedding.ts";
import {
  publishChunkEmbeddings,
  publishRetrievalChunks,
  syntheticChunkArtifactId,
} from "../src/intelligence/retrieval/publication.ts";
import {
  EmbeddingModelConfigSchema,
  type RetrievalChunk,
  type RetrievalScope,
} from "../src/intelligence/retrieval/types.ts";
import { LanceIntelligenceStore } from "../src/intelligence/storage/store.ts";
import type { WorkspaceHandle } from "../src/intelligence/workspace/context.ts";

const CORPUS = {
  "entry.ts":
    'import { publish } from "./publish";\nexport function main() { return publish("ok"); }\nexport function wrapper() { return main(); }\n',
  "publish.ts":
    "export function publish(value: string) { console.log(value); return value; }\n",
};
type Answer = { calls: string[]; symbols: string[] };
type Task = {
  expected: Answer;
  file: string;
  graphifyTokenBudget: number;
  id: string;
  kind: "callees" | "symbols";
  measuredOutputCapBytes: number;
  native: { arguments: Record<string, unknown>; name: string };
  query: string;
  resultLimit: number;
  target?: string;
};
const TASKS: Task[] = [
  {
    expected: { calls: [], symbols: ["main", "wrapper"] },
    file: "entry.ts",
    graphifyTokenBudget: 2_000,
    id: "symbols",
    kind: "symbols",
    measuredOutputCapBytes: 2_000,
    native: { arguments: { paths: ["entry.ts"] }, name: "map" },
    query: "main wrapper",
    resultLimit: 10,
  },
  {
    expected: { calls: ["main->publish"], symbols: [] },
    file: "entry.ts",
    graphifyTokenBudget: 2_000,
    id: "main-callees",
    kind: "callees",
    measuredOutputCapBytes: 2_000,
    native: {
      arguments: { paths: ["entry.ts"], target: "main" },
      name: "callees",
    },
    query: "main",
    resultLimit: 10,
    target: "main",
  },
  {
    expected: { calls: ["wrapper->main"], symbols: [] },
    file: "entry.ts",
    graphifyTokenBudget: 2_000,
    id: "wrapper-callees",
    kind: "callees",
    measuredOutputCapBytes: 2_000,
    native: {
      arguments: { paths: ["entry.ts"], target: "wrapper" },
      name: "callees",
    },
    query: "wrapper",
    resultLimit: 10,
    target: "wrapper",
  },
];
type ToolObservation = {
  answer: Answer;
  durationMs: number;
  id: string;
  operations: Array<{
    appliedResultLimit: number;
    command: string;
    returnedBytes: number;
  }>;
  success: boolean;
};
const normalized = (value: Answer): Answer => ({
  calls: [...new Set(value.calls)].sort(),
  symbols: [...new Set(value.symbols)].sort(),
});
const equalAnswer = (left: Answer, right: Answer) =>
  JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
function nativeAnswer(task: Task, value: unknown): Answer {
  const data = (value as { data?: Record<string, unknown> }).data ?? {};
  if (task.id === "symbols") {
    const files = (data.files ?? []) as Array<{
      symbols?: Array<{ name: string }>;
    }>;
    return normalized({
      calls: [],
      symbols: files.flatMap((file) =>
        (file.symbols ?? []).map((item) => item.name),
      ),
    });
  }
  const items = (data.items ?? []) as Array<{ callee: string }>;
  const source = task.id === "main-callees" ? "main" : "wrapper";
  return normalized({
    calls: items.map((item) => `${source}->${item.callee.split(".").at(-1)}`),
    symbols: [],
  });
}
const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

async function cli(command: string[], cwd: string) {
  const started = Bun.nanoseconds();
  const child = Bun.spawn(command, {
    cwd,
    killSignal: "SIGKILL",
    stderr: "pipe",
    stdout: "pipe",
    timeout: 60_000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr}`);
  return { durationMs: (Bun.nanoseconds() - started) / 1e6, output: stdout };
}
function toolText(result: unknown): string {
  const content = (
    result as { content?: Array<{ text?: string; type: string }> }
  ).content;
  return (content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

async function connect(cwd: string, name: string) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../src/index.ts")],
    command: process.execPath,
    cwd,
    env: { ...process.env, PWD: cwd },
    stderr: "pipe",
  });
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === "workspace_open"))
    throw new Error("Native server did not expose workspace_open");
  return client;
}
function openedWorkspaceId(value: unknown): string {
  const match = JSON.stringify(value).match(/workspace:v1:[a-f0-9]{64}/);
  if (!match) throw new Error("workspace_open omitted workspaceId");
  return match[0];
}
function requiredToolData<T extends Record<string, unknown>>(
  result: Awaited<ReturnType<Client["callTool"]>>,
  label: string,
): T {
  if (result.isError)
    throw new Error(
      `${label} failed: ${JSON.stringify(result.structuredContent)}`,
    );
  const data = (result.structuredContent as { data?: T } | undefined)?.data;
  if (!data) throw new Error(`${label} omitted structured data`);
  return data;
}

async function native(
  root: string,
  storagePath: string,
): Promise<{
  cold: ToolObservation[];
  warm: ToolObservation[];
}> {
  const client = await connect(root, "benchmark-native");
  try {
    const opened = await client.callTool({
      arguments: {
        directory: root,
        storage: { kind: "explicit", path: storagePath },
      },
      name: "workspace_open",
    });
    const workspaceId = openedWorkspaceId(opened.structuredContent);
    const runPass = async (): Promise<ToolObservation[]> => {
      const observations: ToolObservation[] = [];
      for (const task of TASKS) {
        const started = Bun.nanoseconds();
        const result = await client.callTool({
          arguments: {
            ...task.native.arguments,
            budget: task.measuredOutputCapBytes,
            ...(task.kind === "symbols"
              ? { max_members: task.resultLimit }
              : { limit: task.resultLimit }),
            workspaceId,
          },
          name: task.native.name,
        });
        if (result.isError)
          throw new Error(JSON.stringify(result.structuredContent));
        const bytes = Buffer.byteLength(toolText(result));
        if (bytes > task.measuredOutputCapBytes)
          throw new Error(
            `native tool exceeded measured output cap for ${task.id}`,
          );
        const answer = nativeAnswer(task, result.structuredContent);
        observations.push({
          answer,
          durationMs: (Bun.nanoseconds() - started) / 1e6,
          id: task.id,
          operations: [
            {
              appliedResultLimit: task.resultLimit,
              command: task.native.name,
              returnedBytes: bytes,
            },
          ],
          success: equalAnswer(answer, task.expected),
        });
      }
      return observations;
    };
    return { cold: await runPass(), warm: await runPass() };
  } finally {
    await client.close();
  }
}
function graphifyAnswer(task: Task, output: string): Answer {
  if (task.kind === "symbols") {
    const symbols = [
      ...output.matchAll(/^NODE ([A-Za-z_$][\w$]*)\(\) \[src=([^ ]+)/gm),
    ]
      .filter((match) => match[2] === task.file)
      .map((match) => match[1] as string);
    return normalized({ calls: [], symbols });
  }
  const calls = [
    ...output.matchAll(
      /^EDGE ([A-Za-z_$][\w$]*)\(\) --calls [^\n]*--> ([A-Za-z_$][\w$]*)\(\)/gm,
    ),
  ]
    .filter((match) => match[1] === task.target)
    .map((match) => `${match[1]}->${match[2]}`);
  return normalized({ calls, symbols: [] });
}

async function graphify(root: string, outputRoot: string) {
  if (process.env.AST_MCP_RUN_GRAPHIFY !== "1")
    return {
      reason: "Graphify comparison was not requested",
      status: "unavailable" as const,
    };
  const executable = Bun.which("graphify");
  if (!executable)
    return {
      reason: "graphify executable was not found",
      status: "unavailable" as const,
    };
  const version = await cli([executable, "--version"], root);
  if (version.output.trim() !== "graphify 0.9.53")
    return {
      reason: `expected Graphify 0.9.53, received ${version.output.trim()}`,
      status: "unavailable" as const,
    };
  const build = await cli(
    [executable, root, "--code-only", "--no-cluster", "--out", outputRoot],
    root,
  );
  const graph = path.join(outputRoot, "graphify-out", "graph.json");
  const runPass = async () => {
    const observations = [];
    for (const task of TASKS) {
      const result = await cli(
        [
          executable,
          "query",
          task.query,
          "--budget",
          String(task.graphifyTokenBudget),
          "--graph",
          graph,
        ],
        root,
      );
      const answer = graphifyAnswer(task, result.output);
      observations.push({
        answer,
        durationMs: result.durationMs,
        id: task.id,
        operations: [
          {
            appliedTokenBudget: task.graphifyTokenBudget,
            command: "graphify query",
            returnedBytes: Buffer.byteLength(result.output),
          },
        ],
        success: equalAnswer(answer, task.expected),
      });
    }
    return observations;
  };
  const cold = await runPass();
  const warm = await runPass();
  return {
    cold,
    indexingDurationMs: build.durationMs,
    medianColdQueryMs: median(cold.map((item) => item.durationMs)),
    medianColdReturnedBytes: median(
      cold.map((item) => item.operations[0]?.returnedBytes ?? 0),
    ),
    medianWarmQueryMs: median(warm.map((item) => item.durationMs)),
    medianWarmReturnedBytes: median(
      warm.map((item) => item.operations[0]?.returnedBytes ?? 0),
    ),
    setupOperations: [
      {
        command: "graphify index",
        returnedBytes: Buffer.byteLength(build.output),
      },
    ],
    success: [...cold, ...warm].every((item) => item.success),
    version: version.output.trim(),
    warm,
  };
}
type CacheCounters = { hits: number; misses: number };

class DeterministicBenchmarkProvider implements EmbeddingProvider {
  readonly cache = new Map<string, readonly number[]>();
  readonly counters: CacheCounters = { hits: 0, misses: 0 };
  readonly runtime = "static-retrieval" as const;

  constructor(
    readonly config: ReturnType<typeof EmbeddingModelConfigSchema.parse>,
  ) {}

  async close() {}

  async embed(texts: readonly string[]) {
    return texts.map((text) => {
      const cached = this.cache.get(text);
      if (cached) {
        this.counters.hits += 1;
        return cached;
      }
      this.counters.misses += 1;
      const digest = createHash("sha256").update(text).digest();
      const vector = normalizeEmbedding(
        Array.from(
          { length: this.config.dimensions },
          (_, index) => (digest[index % digest.length] ?? 0) + 1,
        ),
        this.config.dimensions,
      );
      this.cache.set(text, vector);
      return vector;
    });
  }

  snapshot(): CacheCounters {
    return { ...this.counters };
  }
}

function deltaCounters(
  current: CacheCounters,
  previous: CacheCounters,
): CacheCounters {
  return {
    hits: current.hits - previous.hits,
    misses: current.misses - previous.misses,
  };
}

type ParserCacheSnapshot = {
  bytes: number;
  entries: number;
  evictions: number;
  hits: number;
  misses: number;
};

function parserCachePass(
  current: ParserCacheSnapshot,
  previous: ParserCacheSnapshot,
): ParserCacheSnapshot {
  return {
    bytes: current.bytes,
    entries: current.entries,
    evictions: current.evictions - previous.evictions,
    hits: current.hits - previous.hits,
    misses: current.misses - previous.misses,
  };
}

async function productionParserCache() {
  const pool = new ParserWorkerPool({
    maxParseCacheBytes: 256 * 1024,
    maxParseCacheEntries: Object.keys(CORPUS).length,
    maxWorkers: 1,
    minWorkers: 0,
  });
  try {
    const requests = Object.values(CORPUS).map((source) => ({
      languageId: "typescript",
      source,
    }));
    const before = pool.stats.cache;
    const coldStarted = Bun.nanoseconds();
    const coldResults = [];
    for (const request of requests) coldResults.push(await pool.parse(request));
    const coldLatencyMs = (Bun.nanoseconds() - coldStarted) / 1e6;
    const afterCold = pool.stats.cache;

    const warmStarted = Bun.nanoseconds();
    const warmResults = [];
    for (const request of requests) warmResults.push(await pool.parse(request));
    const warmLatencyMs = (Bun.nanoseconds() - warmStarted) / 1e6;
    const afterWarm = pool.stats.cache;
    const warmCache = parserCachePass(afterWarm, afterCold);

    return {
      cold: {
        cache: parserCachePass(afterCold, before),
        latencyMs: coldLatencyMs,
      },
      resultsReused:
        JSON.stringify(coldResults) === JSON.stringify(warmResults),
      reusePercent:
        requests.length === 0 ? 0 : (warmCache.hits / requests.length) * 100,
      warm: {
        cache: warmCache,
        latencyMs: warmLatencyMs,
      },
    };
  } finally {
    await pool.close({ drain: true });
  }
}

async function writeCorpus(root: string): Promise<void> {
  await Promise.all(
    Object.entries(CORPUS).map(([name, source]) =>
      writeFile(path.join(root, name), source),
    ),
  );
}

async function publicLifecycle(owned: string) {
  const root = path.join(owned, "public-lifecycle");
  const storagePath = path.join(owned, "public-lifecycle-storage");
  await mkdir(root, { recursive: true });
  await writeCorpus(root);
  await cli(["git", "init", "-q"], root);
  await cli(["git", "config", "user.email", "benchmark@example.invalid"], root);
  await cli(["git", "config", "user.name", "Benchmark"], root);
  await cli(["git", "add", "."], root);
  await cli(["git", "commit", "-qm", "fixture"], root);

  const client = await connect(root, "benchmark-public-lifecycle");
  try {
    const opened = await client.callTool({
      arguments: {
        directory: root,
        storage: { kind: "explicit", path: storagePath },
      },
      name: "workspace_open",
    });
    const workspaceId = openedWorkspaceId(opened.structuredContent);
    const build = requiredToolData<Record<string, unknown>>(
      await client.callTool({
        arguments: { action: "build", workspaceId },
        name: "index",
      }),
      "index build",
    );
    const status = requiredToolData<{
      counts: Record<string, number>;
      coverage: { exhaustive: boolean; truncated: boolean };
      generation: string | null;
    }>(
      await client.callTool({
        arguments: {
          maxRowsPerTable: 10_000,
          timeoutMs: 30_000,
          workspaceId,
        },
        name: "index_status",
      }),
      "index_status",
    );
    const retrieval = requiredToolData<{
      results: unknown[];
    }>(
      await client.callTool({
        arguments: {
          budget: {
            maxBytes: 64_000,
            maxCandidates: 100,
            maxItems: 20,
            timeoutMs: 30_000,
          },
          query: "publish",
          semantic: false,
          workspaceId,
        },
        name: "retrieve",
      }),
      "retrieve",
    );
    return {
      buildGeneration: String(build.generation ?? ""),
      counts: status.counts,
      generation: status.generation,
      retrievedItems: retrieval.results.length,
      statusCoverage: status.coverage,
      workspaceId,
    };
  } finally {
    await client.close();
  }
}

async function productionIndexing(
  root: string,
  storagePath: string,
  nativeCold: ToolObservation[],
  nativeWarm: ToolObservation[],
) {
  const parser = await productionParserCache();
  const domain: StorageDomain = {
    domainId: createStorageDomainId({
      engine: "lancedb",
      placement: { kind: "explicit", path: storagePath },
      pool: "shared",
      storagePath,
    }),
    engine: "lancedb",
    placement: { kind: "explicit", path: storagePath },
    pool: "shared",
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    storagePath,
  };
  const repositoryId = createRepositoryId({
    canonicalGitCommonDirectory: path.join(root, ".git"),
  });
  const selectedRevision = {
    readOnly: false,
    resolvedCommitOid: null,
    revisionId: createRevisionId({
      repositoryId,
      resolvedCommitOid: null,
      selector: { kind: "working" },
    }),
    selector: { kind: "working" as const },
  };
  const workspaceId = createWorkspaceId({
    canonicalCheckoutRoot: root,
    configurationGeneration: 1,
    dirtyOverlayId: null,
    repositoryId,
    revisionId: selectedRevision.revisionId,
    storageDomainId: domain.domainId,
  });
  const workspace: WorkspaceHandle = {
    canonicalRootAnchor: root,
    checkoutRoot: root,
    configurationGeneration: 1,
    dirtyOverlayId: null,
    git: {
      branch: null,
      checkoutRoot: root,
      commonGitDirectory: path.join(root, ".git"),
      gitDirectory: path.join(root, ".git"),
      headOid: null,
      isGit: true,
      isLinkedWorktree: false,
      repositoryRoot: root,
    },
    openedAt: new Date().toISOString(),
    repositoryId,
    repositoryRoot: root,
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    selectedRevision,
    storageDomain: domain,
    workspaceId,
    writeEligibility: { eligible: true },
  };
  const scope: RetrievalScope = {
    generationId: createIdentity("generation", { repositoryId }),
    repositoryId,
    revisionId: selectedRevision.revisionId,
    workspaceId,
  };
  const chunks: RetrievalChunk[] = Object.entries(CORPUS).map(
    ([file, text]) => {
      const sourceArtifactId = createIdentity("source", { file, text });
      const chunk = {
        documentKind: "code" as const,
        language: "typescript",
        path: file,
        range: {
          end: { column: 0, line: text.split("\n").length },
          endByte: Buffer.byteLength(text),
          start: { column: 0, line: 0 },
          startByte: 0,
        },
        sourceArtifactId,
        symbols: file === "entry.ts" ? ["main", "wrapper"] : ["publish"],
        text,
      };
      return {
        ...chunk,
        artifactId: syntheticChunkArtifactId(chunk),
      };
    },
  );
  const config = EmbeddingModelConfigSchema.parse({
    artifacts: {},
    batchSize: 2,
    dimensions: 8,
    maxQueue: 16,
    modelId: "benchmark/deterministic",
    revision: "benchmark-v1",
    workers: 1,
  });
  const provider = new DeterministicBenchmarkProvider(config);
  const pool = new EmbeddingWorkerPool(config, () => provider);
  const store = await LanceIntelligenceStore.open(domain);
  try {
    await publishRetrievalChunks(store, scope, chunks, workspace);
    const before = await bytes(storagePath);
    const initialCounters = provider.snapshot();
    const coldStarted = Bun.nanoseconds();
    const coldPublication = await publishChunkEmbeddings(
      store,
      scope,
      chunks,
      config,
      pool,
      { workspace },
    );
    const coldLatencyMs = (Bun.nanoseconds() - coldStarted) / 1e6;
    const coldCounters = provider.snapshot();
    const afterCold = await bytes(storagePath);
    const coldRows = await store.rows("embeddings");

    const warmScope: RetrievalScope = {
      ...scope,
      generationId: createIdentity("generation", {
        repositoryId,
        run: "warm",
      }),
    };
    const warmChunks = chunks.map((chunk) => {
      const sourceArtifactId = createIdentity("source", {
        prior: chunk.sourceArtifactId,
        run: "warm",
      });
      const next = { ...chunk, sourceArtifactId };
      return { ...next, artifactId: syntheticChunkArtifactId(next) };
    });
    await publishRetrievalChunks(store, warmScope, warmChunks, workspace);
    const warmStarted = Bun.nanoseconds();
    const warmPublication = await publishChunkEmbeddings(
      store,
      warmScope,
      warmChunks,
      config,
      pool,
      { workspace },
    );
    const warmLatencyMs = (Bun.nanoseconds() - warmStarted) / 1e6;
    const warmCounters = provider.snapshot();
    const afterWarm = await bytes(storagePath);
    const warmRows = await store.rows("embeddings");
    const embeddingPublications = [coldPublication, warmPublication];

    const connection = await lancedb.connect(storagePath);
    let nearest: unknown[] = [];
    try {
      const searchRows = coldRows.map((row) => ({
        artifact_id: String(row.artifact_id),
        vector: Array.from(row.vector as Iterable<number>),
      }));
      const table = await connection.createTable(
        "benchmark_vector_search",
        searchRows,
        { mode: "overwrite" },
      );
      try {
        nearest = await table
          .search(searchRows[0]?.vector ?? [])
          .limit(1)
          .toArray();
      } finally {
        table.close();
      }
    } finally {
      connection.close();
    }

    return {
      cold: {
        embeddingCache: deltaCounters(coldCounters, initialCounters),
        latencyMs: coldLatencyMs,
      },
      embeddingInputReuse:
        deltaCounters(warmCounters, coldCounters).hits === warmChunks.length,
      embeddingPublicationsDistinct: coldPublication.artifactIds.every(
        (artifactId) => !warmPublication.artifactIds.includes(artifactId),
      ),
      indexGrowthBytes: afterCold - before,
      native: {
        coldLatencyMs: nativeCold.reduce(
          (sum, observation) => sum + observation.durationMs,
          0,
        ),
        resultsReused:
          JSON.stringify(nativeCold.map(({ answer }) => answer)) ===
          JSON.stringify(nativeWarm.map(({ answer }) => answer)),
        warmLatencyMs: nativeWarm.reduce(
          (sum, observation) => sum + observation.durationMs,
          0,
        ),
      },
      parser,
      publicationCount: embeddingPublications.filter(
        (publication) => publication.artifactIds.length > 0,
      ).length,
      publishedRows: warmRows.length,
      queryExecuted: nearest.length > 0,
      storageGrowth: {
        coldBytes: afterCold - before,
        warmBytes: afterWarm - afterCold,
      },
      vectorNearestArtifactId: String(nearest[0]?.artifact_id),
      warm: {
        embeddingCache: deltaCounters(warmCounters, coldCounters),
        latencyMs: warmLatencyMs,
      },
    };
  } finally {
    await pool.close();
    await store.shutdownCoordinator();
  }
}
async function bytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const item = path.join(root, entry.name);
    total += entry.isDirectory() ? await bytes(item) : (await stat(item)).size;
  }
  return total;
}
async function isolation(root: string) {
  const repo = path.join(root, "repo");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await mkdir(repo);
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], {
      cwd: repo,
      killSignal: "SIGKILL",
      stderr: "pipe",
      timeout: 30_000,
    });
    const [code, error] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (code) throw new Error(error);
  };
  await git(["init", "-q"]);
  await git(["config", "user.email", "benchmark@example.invalid"]);
  await git(["config", "user.name", "Benchmark"]);
  await writeFile(
    path.join(repo, "scope.ts"),
    'export const branch = "root";\n',
  );
  await git(["add", "scope.ts"]);
  await git(["commit", "-qm", "fixture"]);
  await git(["branch", "second"]);
  await git(["worktree", "add", "-q", first, "HEAD"]);
  await git(["worktree", "add", "-q", second, "second"]);
  await writeFile(
    path.join(first, "scope.ts"),
    'export const branch = "first";\n',
  );
  await writeFile(
    path.join(second, "scope.ts"),
    'export const branch = "second";\n',
  );
  const outside = path.join(root, "outside.ts");
  await writeFile(outside, 'export const branch = "outside";\n');
  const [firstClient, secondClient] = await Promise.all([
    connect(first, "benchmark-first"),
    connect(second, "benchmark-second"),
  ]);
  try {
    const [firstOpen, secondOpen] = await Promise.all([
      firstClient.callTool({
        arguments: { directory: first },
        name: "workspace_open",
      }),
      secondClient.callTool({
        arguments: { directory: second },
        name: "workspace_open",
      }),
    ]);
    const firstIdentity = JSON.stringify(firstOpen.structuredContent);
    const secondIdentity = JSON.stringify(secondOpen.structuredContent);
    const firstWorkspaceId = openedWorkspaceId(firstOpen.structuredContent);
    const secondWorkspaceId = openedWorkspaceId(secondOpen.structuredContent);
    const [firstMap, secondMap] = await Promise.all([
      firstClient.callTool({
        arguments: { paths: ["scope.ts"], workspaceId: firstWorkspaceId },
        name: "map",
      }),
      secondClient.callTool({
        arguments: { paths: ["scope.ts"], workspaceId: secondWorkspaceId },
        name: "map",
      }),
    ]);
    const hash = await firstClient.callTool({
      arguments: { filePaths: ["scope.ts"], workspaceId: firstWorkspaceId },
      name: "file_hash",
    });
    const hashData = hash.structuredContent as {
      data?: { files?: Array<{ sha256?: string }> };
    };
    const expectedSha256 = hashData.data?.files?.[0]?.sha256;
    if (!expectedSha256)
      throw new Error(
        `Native file_hash omitted sha256: ${JSON.stringify(hash.structuredContent)}`,
      );
    const write = await firstClient.callTool({
      arguments: {
        files: {
          "scope.ts": {
            aiderBlocks: [
              {
                replace: 'export const branch = "changed";',
                search: 'export const branch = "first";',
              },
            ],
            expectedSha256,
            patchStrategy: "aider_block",
          },
        },
        workspaceId: firstWorkspaceId,
      },
      name: "file_patch",
    });
    const siblingDenied = await firstClient.callTool({
      arguments: {
        files: [{ filePath: path.join(second, "scope.ts"), mode: "text" }],
        workspaceId: firstWorkspaceId,
      },
      name: "file_read",
    });
    const outsideDenied = await firstClient.callTool({
      arguments: {
        files: [{ filePath: outside, mode: "text" }],
        workspaceId: firstWorkspaceId,
      },
      name: "file_read",
    });
    const [firstText, secondText] = await Promise.all([
      readFile(path.join(first, "scope.ts"), "utf8"),
      readFile(path.join(second, "scope.ts"), "utf8"),
    ]);
    const crossScopeViolations = outsideDenied.isError ? 0 : 1;
    const guardedWriteSuccess = !write.isError;
    const wrongWorktreeWrites =
      firstText.includes("changed") && secondText.includes("second") ? 0 : 1;
    return {
      assertionsExecuted: 10,
      crossScopeViolations,
      firstMapSuccess: !firstMap.isError,
      gatePassed:
        guardedWriteSuccess &&
        siblingDenied.isError &&
        crossScopeViolations === 0 &&
        wrongWorktreeWrites === 0,
      guardedWriteError: write.isError
        ? {
            content: write.content,
            structuredContent: write.structuredContent,
          }
        : null,
      guardedWriteSuccess,
      secondMapSuccess: !secondMap.isError,
      selectedRootsDistinct:
        firstIdentity !== secondIdentity &&
        firstIdentity.includes(path.basename(first)) &&
        secondIdentity.includes(path.basename(second)),
      siblingDenied: siblingDenied.isError,
      wrongWorktreeWrites,
    };
  } finally {
    await Promise.all([firstClient.close(), secondClient.close()]);
  }
}
export async function benchmarkIntelligenceBaseline() {
  const owned = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-observed-benchmark-"),
  );
  let peakRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 2);
  try {
    const root = path.join(owned, "corpus");
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeCorpus(root);
    const [nativeResult, graphifyResult] = await Promise.all([
      native(root, path.join(owned, "native-storage")),
      graphify(root, path.join(owned, "graphify")),
    ]);
    const indexing = await productionIndexing(
      root,
      path.join(owned, "lancedb"),
      nativeResult.cold,
      nativeResult.warm,
    );
    const returnedBytes = (observation: ToolObservation) =>
      observation.operations.reduce(
        (sum, operation) => sum + operation.returnedBytes,
        0,
      );
    const coldSuccessRate =
      nativeResult.cold.filter((item) => item.success).length / TASKS.length;
    const warmSuccessRate =
      nativeResult.warm.filter((item) => item.success).length / TASKS.length;
    return {
      agentEfficiency: {
        executedTasks: TASKS.length,
        gatePassed: coldSuccessRate === 1 && warmSuccessRate === 1,
        measuredOutputCapBytes: TASKS[0]?.measuredOutputCapBytes,
        medianColdQueryMs: median(
          nativeResult.cold.map((item) => item.durationMs),
        ),
        medianColdReturnedBytes: median(nativeResult.cold.map(returnedBytes)),
        medianWarmQueryMs: median(
          nativeResult.warm.map((item) => item.durationMs),
        ),
        medianWarmReturnedBytes: median(nativeResult.warm.map(returnedBytes)),
        resultLimit: TASKS[0]?.resultLimit,
        successRateCold: coldSuccessRate,
        successRateWarm: warmSuccessRate,
        tasks: TASKS.map((task, index) => ({
          expected: task.expected,
          id: task.id,
          measuredOutputCapBytes: task.measuredOutputCapBytes,
          nativeCold: nativeResult.cold[index],
          nativeWarm: nativeResult.warm[index],
          query: task.query,
          resultLimit: task.resultLimit,
        })),
      },
      comparison: {
        budgetUnits: {
          graphifyQuery: "tokens",
          nativeOutputCap: "bytes",
          nativeResultLimit: "items",
        },
        corpus: {
          files: Object.keys(CORPUS),
          tasks: TASKS.map((task) => task.id),
        },
        graphify: graphifyResult,
        methodology: {
          graphifyQueries:
            "separate CLI process per query against one indexed graph",
          nativeQueries: "persistent MCP session against one opened workspace",
          queryPasses: "cold first pass, warm second pass for each task",
        },
      },
      indexing,
      isolation: await isolation(owned),
      lifecycle: await publicLifecycle(owned),
      memory: { heapUsedBytes: process.memoryUsage().heapUsed, peakRssBytes },
      runtime: {
        bun: Bun.version,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        hostname: os.hostname(),
        platform: `${process.platform}-${process.arch}`,
        totalMemoryBytes: os.totalmem(),
      },
      schema: "ast-mcp.intelligence-benchmark.v5",
    };
  } finally {
    clearInterval(sampler);
    await rm(owned, { force: true, recursive: true });
  }
}
if (import.meta.main) {
  const result = await benchmarkIntelligenceBaseline();
  console.log(JSON.stringify(result, null, 2));
  if (!result.agentEfficiency.gatePassed || !result.isolation.gatePassed)
    process.exitCode = 1;
}

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdtemp,
  open,
  realpath,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MutationFilePlan } from "../../src/intelligence/mutation/types.ts";
import {
  withWorkspaceContext,
  type WorkspaceHandle,
} from "../../src/intelligence/workspace/context.ts";
import { deleteFilesSafely } from "../../src/runtime/file-delete.ts";
import {
  hashFilesSafely,
  readFilesSafely,
} from "../../src/runtime/file-read.ts";
import { renameFilesSafely } from "../../src/runtime/file-rename.ts";
import { readFileSnapshot } from "../../src/runtime/file-snapshot.ts";
import { sha256File } from "../../src/runtime/hash.ts";
import {
  stageFileSnapshot,
  removeSnapshotBlob,
  snapshotNamespace,
} from "../../src/runtime/snapshot-blob.ts";
import { configuredExecution } from "../../src/tools/configured.ts";
import registerFileTools from "../../src/tools/files.ts";

export const OPERATIONS = [
  "hash",
  "hash-tool",
  "hash-configured",
  "read",
  "snapshot",
  "journal",
  "delete",
  "rename",
  "recovery",
  "durable-delete",
  "durable-rename",
  "durable-batch-delete",
  "soak",
] as const;
export type Operation = (typeof OPERATIONS)[number];
export type Dataset = "dense" | "sparse";
export type Representation = "legacy" | "blob";

export interface Observation {
  bytes: number;
  dataset: Dataset;
  durationMs: number;
  error?: string;
  phase?: "setup" | "operation" | "cleanup";
  cleanupErrors?: string[];
  representation?: Representation;
  operation: Operation;
  peakRssBytes: number;
  rssBeforeBytes: number;
  success: boolean;
  requestCount?: number;
  processedBytes?: number;
  retention?: RetentionPoint[];
  settledRetention?: {
    requestedIdleMs: number;
    elapsedIdleMs: number;
    rssBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
  };
  fileCount?: number;
  durableValidation?: { journalStates: string[]; snapshotDirectories: number };
}
export function summarize(samples: Observation[]) {
  const sorted = samples
    .map((sample) => sample.durationMs)
    .sort((a, b) => a - b);
  const medianMs = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return {
    bytes: samples[0]?.bytes ?? 0,
    dataset: samples[0]?.dataset,
    operation: samples[0]?.operation,
    representation: samples[0]?.representation,
    samples: samples.length,
    successes: samples.filter((sample) => sample.success).length,
    medianMs,
    p95Ms:
      sorted[
        Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
      ] ?? 0,
    mibPerSecond:
      medianMs &&
      samples[0]?.operation !== "journal" &&
      samples.every((sample) => sample.success)
        ? (samples[0]?.processedBytes ?? samples[0]?.bytes ?? 0) /
          1048576 /
          (medianMs / 1000)
        : null,
    peakRssBytes: Math.max(0, ...samples.map((sample) => sample.peakRssBytes)),
    errors: [
      ...new Set(
        samples.flatMap((sample) => (sample.error ? [sample.error] : [])),
      ),
    ],
  };
}

export function parseOptions(args: string[]) {
  const values = new Map(
    args.map((arg) => {
      const separator = arg.indexOf("=");
      if (!arg.startsWith("--") || separator < 3)
        throw new Error("Use --name=value arguments");
      return [arg.slice(2, separator), arg.slice(separator + 1)] as const;
    }),
  );
  for (const name of values.keys())
    if (
      ![
        "bytes",
        "iterations",
        "dataset",
        "operations",
        "worker",
        "allow-large",
        "representation",
        "soak-requests",
        "settle-ms",
      ].includes(name)
    )
      throw new Error(`Unknown argument: ${name}`);
  const bytes = Number(values.get("bytes") ?? 67108864);
  const iterations = Number(values.get("iterations") ?? 3);
  const soakRequests = Number(values.get("soak-requests") ?? 30);
  const settleMs = Number(values.get("settle-ms") ?? 0);
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 60000)
    throw new Error("settle-ms must be between 0 and 60000");
  if (!Number.isInteger(soakRequests) || soakRequests < 3 || soakRequests > 100)
    throw new Error("soak-requests must be between 3 and 100");
  const dataset = values.get("dataset") ?? "dense";
  const representation = values.get("representation") ?? "blob";
  if (representation !== "legacy" && representation !== "blob")
    throw new Error("representation must be legacy or blob");
  const operations = (
    values.get("operations") ??
    OPERATIONS.filter((operation) => operation !== "soak").join(",")
  ).split(",");
  if (!Number.isSafeInteger(bytes) || bytes < 1)
    throw new Error("bytes must be a positive safe integer");
  if (bytes > 268435456 && values.get("allow-large") !== "true")
    throw new Error("Files over 256 MiB require --allow-large=true");
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 50)
    throw new Error("iterations must be between 1 and 50");
  if (dataset !== "dense" && dataset !== "sparse")
    throw new Error("dataset must be dense or sparse");
  if (
    !operations.length ||
    operations.some((operation) => !OPERATIONS.includes(operation as Operation))
  )
    throw new Error("Unknown operation");
  return {
    bytes,
    dataset: dataset as Dataset,
    representation: representation as Representation,
    soakRequests,
    settleMs,
    iterations,
    operations: operations as Operation[],
    worker: values.get("worker"),
  };
}

async function fixture(
  filePath: string,
  bytes: number,
  dataset: Dataset,
  text = false,
) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    if (dataset === "sparse") await handle.truncate(bytes);
    else {
      const block = Buffer.alloc(Math.min(1048576, bytes));
      for (let index = 0; index < block.length; index++)
        block[index] = text
          ? index % 80 === 79
            ? 10
            : 65 + (index % 26)
          : index % 251;
      for (let offset = 0; offset < bytes; offset += block.length) {
        let written = 0;
        const length = Math.min(block.length, bytes - offset);
        while (written < length) {
          const result = await handle.write(
            block,
            written,
            length - written,
            offset + written,
          );
          if (!result.bytesWritten) throw new Error("fixture_short_write");
          written += result.bytesWritten;
        }
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function independentHash(filePath: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath, {
    highWaterMark: 262144,
  }))
    digest.update(chunk);
  return digest.digest("hex");
}

async function invokeHashTool(
  filePath: string,
  expected: string,
  bytes: number,
  configured = false,
) {
  let handler:
    | ((
        input: { filePaths: string[]; workspaceId?: string },
        context: unknown,
      ) => Promise<unknown>)
    | undefined;
  const server = {
    server: {
      getClientCapabilities: () => undefined,
      setNotificationHandler: () => {},
    },
    registerTool(name: string, _schema: unknown, callback: typeof handler) {
      if (name === "file_hash") handler = callback;
    },
  } as unknown as Parameters<typeof registerFileTools>[0];
  const execute = configured
    ? configuredExecution(server)
    : ((async (
        _args: unknown,
        operation: (signal?: AbortSignal) => Promise<unknown>,
      ) => operation(new AbortController().signal)) as Parameters<
        typeof registerFileTools
      >[1]);
  const workspace = configured
    ? await execute!.openWorkspace!({
        directory: path.dirname(filePath),
        storage: {
          kind: "explicit",
          path: path.join(path.dirname(filePath), ".index"),
        },
      })
    : undefined;
  registerFileTools(server, execute);
  if (!handler) throw new Error("hash_tool_not_registered");
  const result = (await handler(
    {
      filePaths: [filePath],
      ...(workspace ? { workspaceId: workspace.workspaceId } : {}),
    },
    {},
  )) as {
    isError?: boolean;
    structuredContent?: {
      ok?: boolean;
      data?: {
        files?: Array<{ sha256: string; size: number; filePath: string }>;
      };
    };
  };
  if (result.isError) throw new Error(JSON.stringify(result));
  const file = result.structuredContent?.data?.files?.[0];
  if (
    !result.structuredContent?.ok ||
    file?.sha256 !== expected ||
    file.size !== bytes ||
    file.filePath !== filePath
  )
    throw new Error("tool_hash_contract_mismatch");
  JSON.parse(JSON.stringify(result));
}

interface RetentionPoint {
  request: number;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  snapshotDirectories: number;
}

async function runSoak(
  source: string,
  destination: string,
  workspace: WorkspaceHandle,
  bytes: number,
  dataset: Dataset,
  expected: string,
  requests: number,
): Promise<RetentionPoint[]> {
  const { LanceMutationLifecycle, withLanceMutationLifecycle } =
    await import("../../src/intelligence/mutation/service.ts");
  const { LanceIntelligenceStore } =
    await import("../../src/intelligence/storage/store.ts");
  const { ensurePrivateLockDirectory, systemAccount } =
    await import("../../src/runtime/private-lock-directory.ts");
  const snapshotDirectory = path.join(
    await ensurePrivateLockDirectory(await systemAccount()),
    "snapshots",
    snapshotNamespace(workspace),
  );
  const points: RetentionPoint[] = [];
  for (let request = 0; request < requests; request++) {
    if (request) await fixture(source, bytes, dataset);
    await withWorkspaceContext(workspace, async () => {
      if (request % 3 === 0) {
        await withLanceMutationLifecycle(() =>
          deleteFilesSafely({ [source]: { expectedSha256: expected } }),
        );
        if (await Bun.file(source).exists())
          throw new Error("soak_delete_failed");
      } else if (request % 3 === 1) {
        await withLanceMutationLifecycle(() =>
          renameFilesSafely({
            [source]: { destination, expectedSha256: expected },
          }),
        );
        if ((await sha256File(destination)) !== expected)
          throw new Error("soak_rename_failed");
        await unlink(destination);
      } else {
        const store = await LanceIntelligenceStore.open(
          workspace.storageDomain,
        );
        const snapshot = await stageFileSnapshot(source);
        let recovered = false;
        try {
          const lifecycle = new LanceMutationLifecycle(store, workspace);
          const operationId = `job:v1:${createHash("sha256").update(`${expected}-${request}`).digest("hex")}`;
          await lifecycle.journal.begin({
            operationId,
            workspace,
            tool: "file_delete",
            files: [
              {
                candidateSha256: null,
                filePath: source,
                sourceSha256: expected,
                sourceBlob: snapshot.sourceBlob,
                sourceContentBase64: null,
                sourceMode: snapshot.mode,
                sourceUid: process.platform === "win32" ? null : snapshot.uid,
                sourceGid: process.platform === "win32" ? null : snapshot.gid,
              },
            ],
          });
          await lifecycle.journal.transition(operationId, "recovery-required");
          await unlink(source);
          await lifecycle.recover();
          if ((await sha256File(source)) !== expected)
            throw new Error("soak_recovery_failed");
          await unlink(source);
          recovered = true;
        } finally {
          await store.shutdownCoordinator();
          if (!recovered)
            await removeSnapshotBlob(snapshot.sourceBlob, snapshot.namespace);
        }
      }
    });
    Bun.gc(true);
    const memory = process.memoryUsage();
    const snapshotDirectories = (
      await readdir(snapshotDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })
    ).length;
    points.push({
      request: request + 1,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      snapshotDirectories,
    });
    if (snapshotDirectories) throw new Error("soak_snapshot_cleanup_failed");
  }
  return points;
}

export async function worker(
  operation: Operation,
  bytes: number,
  dataset: Dataset,
  representation: Representation,
  soakRequests: number,
  settleMs: number,
  setup: {
    disposers?: ReadonlyArray<() => Promise<void>>;
    writeConfiguration?: (
      filePath: string,
      content: string,
    ) => Promise<unknown>;
  } = {},
): Promise<Observation> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-file-benchmark-")),
  );
  const environment = new Map(
    ["AST_MCP_ROOTS", "AST_MCP_ALLOW_EXTERNAL_ROOTS", "AST_MCP_TELEMETRY"].map(
      (name) => [name, process.env[name]],
    ),
  );

  const source = path.join(
    root,
    operation === "read" ? "fixture.txt" : "fixture.bin",
  );
  const destination = path.join(root, "moved.bin");
  const cleanup: Array<() => Promise<void>> = [...(setup.disposers ?? [])];
  let observation: Observation | undefined;
  try {
    process.env.AST_MCP_ROOTS = root;
    process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
    process.env.AST_MCP_TELEMETRY = "0";
    await (setup.writeConfiguration ?? writeFile)(
      path.join(root, "ast-mcp.toml"),
      "version = 1\n",
    );
    await fixture(source, bytes, dataset, operation === "read");
    // Independent verification deliberately warms the cache before each sample.
    const expected = await independentHash(source);
    const expectedReadPrefix =
      operation === "read" ? Buffer.alloc(Math.min(bytes, 800)) : undefined;
    if (expectedReadPrefix)
      for (let index = 0; index < expectedReadPrefix.length; index++)
        expectedReadPrefix[index] = index % 80 === 79 ? 10 : 65 + (index % 26);
    const sources = [source];
    const expectedByPath = new Map([[source, expected]]);
    if (operation === "durable-batch-delete") {
      for (let index = 1; index < 3; index++) {
        const additional = path.join(root, `fixture-${index}.bin`);
        await fixture(additional, bytes, dataset);
        sources.push(additional);
        expectedByPath.set(additional, await independentHash(additional));
      }
    }
    const durable =
      operation.startsWith("durable-") ||
      operation === "recovery" ||
      operation === "soak";
    const workspace = durable
      ? await (async () => {
          const { WorkspaceRegistry } =
            await import("../../src/intelligence/workspace/index.ts");
          return new WorkspaceRegistry().open({
            configurationGeneration: 1,
            directory: root,
            storage: { kind: "explicit", path: path.join(root, ".index") },
          });
        })()
      : undefined;
    const inWorkspace = <T>(run: () => Promise<T>) =>
      workspace ? withWorkspaceContext(workspace, run) : run();
    const capture = async () => {
      if (representation === "legacy") return readFileSnapshot(source);
      const snapshot = await inWorkspace(() => stageFileSnapshot(source));
      cleanup.push(() =>
        removeSnapshotBlob(snapshot.sourceBlob, snapshot.namespace),
      );
      return snapshot;
    };
    const planFor = (
      snapshot: Awaited<ReturnType<typeof capture>>,
    ): MutationFilePlan => ({
      candidateSha256: null,
      filePath: source,
      sourceSha256: snapshot.sha256,
      ...("sourceBlob" in snapshot
        ? { sourceBlob: snapshot.sourceBlob, sourceContentBase64: null }
        : { sourceContentBase64: snapshot.content.toString("base64") }),
      sourceMode: snapshot.mode,
      sourceUid: process.platform === "win32" ? null : snapshot.uid,
      sourceGid: process.platform === "win32" ? null : snapshot.gid,
    });
    let run: () => Promise<void>;
    let retention: RetentionPoint[] | undefined;
    if (operation === "hash")
      run = async () => {
        const result = await hashFilesSafely([source]);
        if (result[0]?.sha256 !== expected) throw new Error("hash_mismatch");
      };
    else if (operation === "hash-tool" || operation === "hash-configured")
      run = () =>
        invokeHashTool(
          source,
          expected,
          bytes,
          operation === "hash-configured",
        );
    else if (operation === "read")
      run = async () => {
        const result = await readFilesSafely([
          { filePath: source, mode: "text", lines: [0, 10], maxBytes: 4096 },
        ]);
        if (
          result[0]?.sha256 !== expected ||
          Buffer.byteLength(result[0].content) > 4096 ||
          result[0].content !== expectedReadPrefix?.toString("utf8")
        )
          throw new Error("read_contract_mismatch");
      };
    else if (operation === "snapshot")
      run = async () => {
        const snapshot = await capture();
        if (snapshot.sha256 !== expected)
          throw new Error("snapshot_hash_mismatch");
      };
    else if (operation === "journal") {
      const snapshot = await capture();
      run = async () => {
        const serialized = JSON.stringify({ files: [planFor(snapshot)] });
        if (!serialized.includes(expected))
          throw new Error("journal_hash_mismatch");
      };
    } else if (
      operation === "delete" ||
      operation === "durable-delete" ||
      operation === "durable-batch-delete"
    )
      run = async () => {
        const remove = () =>
          deleteFilesSafely(
            Object.fromEntries(
              sources.map((filePath) => [
                filePath,
                { expectedSha256: expectedByPath.get(filePath)! },
              ]),
            ),
          );
        if (workspace) {
          const { withLanceMutationLifecycle } =
            await import("../../src/intelligence/mutation/service.ts");
          await inWorkspace(() => withLanceMutationLifecycle(remove));
        } else await remove();
        for (const filePath of sources)
          if (await Bun.file(filePath).exists())
            throw new Error("delete_failed");
      };
    else if (operation === "rename" || operation === "durable-rename")
      run = async () => {
        const move = () =>
          renameFilesSafely({
            [source]: { destination, expectedSha256: expected },
          });
        if (workspace) {
          const { withLanceMutationLifecycle } =
            await import("../../src/intelligence/mutation/service.ts");
          await inWorkspace(() => withLanceMutationLifecycle(move));
        } else await move();
        if (
          (await Bun.file(source).exists()) ||
          (await sha256File(destination)) !== expected
        )
          throw new Error("rename_failed");
      };
    else if (operation === "soak")
      run = async () => {
        if (!workspace) throw new Error("soak_workspace_missing");
        retention = await runSoak(
          source,
          destination,
          workspace,
          bytes,
          dataset,
          expected,
          soakRequests,
        );
      };
    else {
      if (!workspace) throw new Error("recovery_workspace_missing");
      const { LanceMutationLifecycle } =
        await import("../../src/intelligence/mutation/service.ts");
      const { LanceIntelligenceStore } =
        await import("../../src/intelligence/storage/store.ts");
      const store = await LanceIntelligenceStore.open(workspace.storageDomain);
      cleanup.push(() => store.shutdownCoordinator());
      const lifecycle = new LanceMutationLifecycle(store, workspace);
      const snapshot = await capture();
      const operationId = `job:v1:${expected}`;
      await lifecycle.journal.begin({
        operationId,
        workspace,
        tool: "file_delete",
        files: [planFor(snapshot)],
      });
      await lifecycle.journal.transition(operationId, "recovery-required");
      await unlink(source);
      run = async () => {
        await inWorkspace(() => lifecycle.recover());
        if ((await sha256File(source)) !== expected)
          throw new Error("recovery_failed");
      };
    }
    Bun.gc(true);
    const rssBeforeBytes = process.memoryUsage.rss();
    const start = performance.now();
    let error: string | undefined;
    let durationMs = 0;
    let settledRetention: Observation["settledRetention"];
    let durableValidation:
      | { journalStates: string[]; snapshotDirectories: number }
      | undefined;
    try {
      await run();
      durationMs = performance.now() - start;
      if (operation === "soak" && settleMs) {
        const idleStart = performance.now();
        await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
        Bun.gc(true);
        const memory = process.memoryUsage();
        settledRetention = {
          requestedIdleMs: settleMs,
          elapsedIdleMs: performance.now() - idleStart,
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
        };
      }
      if (
        (operation === "rename" || operation === "durable-rename") &&
        (await independentHash(destination)) !== expected
      )
        throw new Error("independent_rename_hash_mismatch");
      if (
        operation === "recovery" &&
        (await independentHash(source)) !== expected
      )
        throw new Error("independent_recovery_hash_mismatch");
      if (workspace && operation !== "soak") {
        const { LanceIntelligenceStore } =
          await import("../../src/intelligence/storage/store.ts");
        const store = await LanceIntelligenceStore.open(
          workspace.storageDomain,
        );
        try {
          const rows = await store.rows("jobs");
          const journalStates = rows.map((row) => {
            if (typeof row.payload_json !== "string")
              throw new Error("invalid_journal_payload");
            return (JSON.parse(row.payload_json) as { state: string }).state;
          });
          if (
            !journalStates.length ||
            journalStates.some(
              (state) =>
                !["succeeded", "rolled-back", "recovered"].includes(state),
            )
          )
            throw new Error("journal_not_terminal");
          const { ensurePrivateLockDirectory, systemAccount } =
            await import("../../src/runtime/private-lock-directory.ts");
          const directory = path.join(
            await ensurePrivateLockDirectory(await systemAccount()),
            "snapshots",
            snapshotNamespace(workspace),
          );
          const snapshotDirectories = (
            await readdir(directory).catch((failure: NodeJS.ErrnoException) => {
              if (failure.code === "ENOENT") return [];
              throw failure;
            })
          ).length;
          if (snapshotDirectories) throw new Error("snapshot_cleanup_failed");
          durableValidation = { journalStates, snapshotDirectories };
        } finally {
          await store.shutdownCoordinator();
        }
      }
    } catch (failure) {
      if (!durationMs) durationMs = performance.now() - start;
      error =
        failure instanceof Error
          ? `${failure.name}: ${failure.message}`
          : String(failure);
    }
    return (observation = {
      bytes,
      dataset,
      operation,
      representation,
      durationMs,
      ...(durableValidation ? { durableValidation } : {}),
      ...(settledRetention ? { settledRetention } : {}),
      ...(sources.length > 1
        ? { fileCount: sources.length, processedBytes: bytes * sources.length }
        : {}),
      rssBeforeBytes,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      success: !error,
      ...(retention
        ? {
            retention,
            requestCount: soakRequests,
            processedBytes: bytes * soakRequests,
          }
        : {}),
      phase: "operation",
      ...(error ? { error } : {}),
    });
  } catch (failure) {
    return (observation = {
      bytes,
      dataset,
      operation,
      representation,
      durationMs: 0,
      rssBeforeBytes: process.memoryUsage.rss(),
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      success: false,
      phase: "setup",
      error:
        failure instanceof Error
          ? `${failure.name}: ${failure.message}`
          : String(failure),
    });
  } finally {
    const cleanupFailures: unknown[] = [];
    for (const dispose of cleanup.reverse()) {
      try {
        await dispose();
      } catch (failure) {
        cleanupFailures.push(failure);
      }
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (failure) {
      cleanupFailures.push(failure);
    } finally {
      for (const [name, value] of environment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    if (cleanupFailures.length) {
      const messages = cleanupFailures.map((failure) =>
        failure instanceof Error
          ? `${failure.name}: ${failure.message}`
          : String(failure),
      );
      if (!observation)
        throw new AggregateError(cleanupFailures, "Benchmark cleanup failed");
      if (observation.success) observation.phase = "cleanup";
      observation.success = false;
      observation.cleanupErrors = messages;
      observation.error = [
        observation.error,
        ...messages.map((message) => `cleanup: ${message}`),
      ]
        .filter(Boolean)
        .join("; ");
    }
  }
}

export async function main(
  args: string[],
  optionsOverride: { workerTimeoutMs?: number } = {},
) {
  const options = parseOptions(args);
  if (options.worker) {
    if (!OPERATIONS.includes(options.worker as Operation))
      throw new Error("Unknown worker operation");
    console.log(
      JSON.stringify(
        await worker(
          options.worker as Operation,
          options.bytes,
          options.dataset,
          options.representation,
          options.soakRequests,
          options.settleMs,
        ),
      ),
    );
    return;
  }
  const samples: Observation[] = [];
  for (const operation of options.operations)
    for (let iteration = 0; iteration < options.iterations; iteration++) {
      const subprocess = Bun.spawn(
        [
          process.execPath,
          import.meta.path,
          `--worker=${operation}`,
          `--bytes=${options.bytes}`,
          `--dataset=${options.dataset}`,
          `--representation=${options.representation}`,
          `--soak-requests=${options.soakRequests}`,
          `--settle-ms=${options.settleMs}`,
          "--allow-large=true",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, AST_MCP_TELEMETRY: "0" },
        },
      );
      const timeout = setTimeout(
        () => subprocess.kill(),
        optionsOverride.workerTimeoutMs ?? 180000,
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]).finally(() => clearTimeout(timeout));
      if (exitCode !== 0)
        throw new Error(
          `Worker ${operation} exited ${exitCode}: ${stderr.slice(-4000)}`,
        );
      const sample = JSON.parse(stdout.trim()) as Observation;
      samples.push(sample);
    }
  console.log(
    JSON.stringify(
      {
        schemaVersion: "ast-mcp.file-benchmark.v1",
        environment: {
          bun: Bun.version,
          platform: process.platform,
          arch: process.arch,
          cpus: os.cpus()[0]?.model,
          release: os.release(),
          totalMemoryBytes: os.totalmem(),
          cache: "warm after independent streaming SHA-256 verification",
          peakRssUnit:
            "bytes; process lifetime peak includes fixture setup and recovery journal setup",
          note: "Fresh subprocess per sample; generation, independent hash and cleanup excluded from duration. Peak RSS includes them.",
        },
        samples,
        summaries: options.operations.map((operation) =>
          summarize(samples.filter((sample) => sample.operation === operation)),
        ),
      },
      null,
      2,
    ),
  );
  if (samples.some((sample) => !sample.success)) process.exitCode = 1;
}
if (import.meta.main) await main(Bun.argv.slice(2));

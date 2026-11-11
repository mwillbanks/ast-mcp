import { expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { configRegistry } from "../../src/config/registry.ts";
import * as deferredRefresh from "../../src/intelligence/mutation/experimental-deferred-refresh.ts";
import * as freshness from "../../src/intelligence/mutation/freshness.ts";
import {
  acquireFileLock,
  lockPathIdentity,
  mutationSharedDatabasePath,
} from "../../src/intelligence/mutation/locks.ts";
import { mutationTransactionLockPath } from "../../src/intelligence/mutation/service.ts";
import { LanceIntelligenceStore } from "../../src/intelligence/storage/store.ts";
import { resolveStorageDomain } from "../../src/intelligence/workspace/storage.ts";
import * as checkoutAdmission from "../../src/runtime/checkout-admission.ts";
import { sha256 } from "../../src/runtime/hash.ts";
import { acquireTransactionLock } from "../../src/runtime/transaction-lock.ts";
import { createServer } from "../../src/server/index.ts";

const fixtureEnv = "AST_MCP_TEST_DEFERRED_REFRESH_FIXTURE";
const fixtureModeEnv = "AST_MCP_TEST_DEFERRED_REFRESH_MODE";
type FixtureMode = "plain" | "git" | "unindexed" | "publication" | "selection";
const previous = "export function beforeMarker() { return 1; }";
const next = "export function afterMarker() { return 2; }";
const latest = "export function latestMarker() { return 3; }";

function success<T>(result: {
  isError?: boolean;
  structuredContent?: unknown;
}): T {
  expect(
    result.isError,
    JSON.stringify(result.structuredContent),
  ).not.toBeTrue();
  return (result.structuredContent as { data: T }).data;
}

async function runFixture(root: string, mode: FixtureMode): Promise<void> {
  const git = mode === "git" || mode === "publication";
  const checkout = path.join(root, "checkout");
  const source = path.join(checkout, "service.ts");
  const transactionPath = await mutationTransactionLockPath(checkout);
  const server = createServer({ allowEmbeddingDownload: false });
  const client = new Client({
    name: "deferred-refresh-contract",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const call = (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => client.callTool({ name, arguments: args }, { signal });
  const openWorkspace = async () =>
    success<{ workspace: { workspaceId: string } }>(
      await call("workspace_open", {
        directory: checkout,
        storage: git
          ? { kind: "local" }
          : { kind: "explicit", path: path.join(root, "index") },
      }),
    ).workspace.workspaceId;
  // Hold deferred dispatch while leaving the public handlers and marker real.
  const schedule = spyOn(
    deferredRefresh,
    "scheduleMutationRefresh",
  ).mockImplementation(() => undefined);

  const refresh = freshness.refreshMutationIntelligence;
  const refreshSpy = spyOn(freshness, "refreshMutationIntelligence");
  const releases: Array<() => void> = [];
  const jobs: Promise<unknown>[] = [];
  const stagingSpies: Array<{ mockRestore(): void }> = [];
  function holdFinalization(pauseParse = false) {
    const parsing = Promise.withResolvers<void>();
    const releaseParse = Promise.withResolvers<void>();
    const staged = Promise.withResolvers<void>();
    const releaseStaged = Promise.withResolvers<void>();
    releases.push(releaseParse.resolve, releaseStaged.resolve);
    refreshSpy.mockImplementationOnce((input) => {
      const { finalize, parse } = input;
      if (!finalize) throw new Error("Index refresh omitted publication fence");
      if (pauseParse && !parse) throw new Error("Index refresh omitted parser");
      return refresh({
        ...input,
        ...(pauseParse && parse
          ? {
              parse: async (...args: Parameters<typeof parse>) => {
                parsing.resolve();
                await releaseParse.promise;
                return parse(...args);
              },
            }
          : {}),
        async finalize(publish) {
          staged.resolve();
          await releaseStaged.promise;
          return finalize(publish);
        },
      });
    });
    return {
      async enter(
        job: Promise<unknown>,
        phase: "parse" | "finalize" = "finalize",
      ) {
        if (!jobs.includes(job)) jobs.push(job);
        await Promise.race([
          phase === "parse" ? parsing.promise : staged.promise,
          job.then(() => {
            throw new Error("Index refresh completed before " + phase);
          }),
        ]);
      },
      release: releaseStaged.resolve,
      releaseParse: releaseParse.resolve,
    };
  }
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const openedWorkspaceId = await openWorkspace();
    if (mode === "unindexed") {
      const patch = (search: string, replace: string) =>
        call("file_patch", {
          workspaceId: openedWorkspaceId,
          files: {
            [source]: {
              expectedSha256: sha256(search + "\n"),
              patchStrategy: "aider_block",
              aiderBlocks: [{ search, replace }],
            },
          },
        });
      const committed = success<{
        intelligenceRefresh: { refreshPending?: boolean };
      }>(await patch(previous, next));
      expect(committed.intelligenceRefresh.refreshPending).toBeUndefined();
      expect(await readFile(source, "utf8")).toBe(next + "\n");
      expect(schedule).not.toHaveBeenCalled();
      expect(
        await deferredRefresh.readRefreshState(transactionPath),
      ).toMatchObject({
        indexRefresh: false,
        inFlight: false,
        journal: "sqlite-v1",
      });
      const built = success<{ generation: string }>(
        await call("index", {
          action: "build",
          workspaceId: openedWorkspaceId,
        }),
      );
      expect(
        await deferredRefresh.readRefreshState(transactionPath),
      ).toMatchObject({
        kind: "clean",
        publishedGenerationId: built.generation,
        journal: "sqlite-v1",
      });
      const domain = resolveStorageDomain(checkout, {
        kind: "explicit",
        path: path.join(root, "index"),
      });
      const identity = sha256(
        JSON.stringify([path.basename(transactionPath), domain.domainId]),
      );
      await rm(
        path.join(
          path.dirname(transactionPath),
          `mutation-journal-${identity}.sqlite`,
        ),
      );
      const missing = await patch(next, latest);
      expect(missing.isError).toBeTrue();
      expect(await readFile(source, "utf8")).toBe(next + "\n");
      return;
    }
    let workspaceId = openedWorkspaceId;
    const initial = mode === "selection" ? holdFinalization() : undefined;
    const initialBuild = call("index", { action: "build", workspaceId });
    if (initial) {
      await initial.enter(initialBuild);
      const pending = await call("retrieve", {
        workspaceId,
        query: "beforeMarker",
        semantic: false,
      });
      expect(pending.isError).toBeTrue();
      expect(pending.structuredContent).toMatchObject({
        error: { code: "intelligence_refresh_pending", retryable: true },
      });
      const strictPending = await call("retrieve", {
        workspaceId,
        query: "beforeMarker",
        semantic: false,
        strictRead: true,
        budget: { timeoutMs: 1 },
      });
      expect(strictPending.isError).toBeTrue();
      expect(strictPending.structuredContent).toMatchObject({
        error: { code: "intelligence_refresh_pending", retryable: true },
      });
      initial.release();
    }
    const { generation: originalGeneration } = success<{ generation: string }>(
      await initialBuild,
    );
    schedule.mockClear();
    expect(originalGeneration).toStartWith("generation:v1:");
    if (mode === "selection") {
      const alternate = success<{ workspace: { workspaceId: string } }>(
        await call("workspace_open", {
          directory: checkout,
          storage: {
            kind: "explicit",
            path: path.join(root, "alternate-index"),
          },
        }),
      ).workspace.workspaceId;
      expect(alternate).not.toBe(workspaceId);
      success(await call("index", { action: "build", workspaceId: alternate }));

      const switching = holdFinalization();
      const rebuild = call("index", { action: "refresh", workspaceId });
      await switching.enter(rebuild);
      expect(
        success(
          await call("retrieve", {
            workspaceId,
            query: "beforeMarker",
            semantic: false,
          }),
        ),
      ).toMatchObject({
        freshness: { stale: true },
        scope: { generationId: originalGeneration, workspaceId },
      });
      switching.release();
      const explicit = success<{ generation: string }>(await rebuild);
      expect(
        await deferredRefresh.readRefreshState(transactionPath),
      ).toMatchObject({
        kind: "clean",
        publishedGenerationId: explicit.generation,
      });
      return;
    }
    const beforePreview =
      await deferredRefresh.readRefreshState(transactionPath);
    const expectedSha256 = sha256(previous + "\n");
    const { files } = success<{
      files: Record<string, { previewReceipt: string }>;
    }>(
      await call("file_patch", {
        workspaceId,
        files: {
          [source]: {
            expectedSha256,
            patchStrategy: "aider_block",
            aiderBlocks: [{ search: previous, replace: next }],
            preview: true,
          },
        },
      }),
    );
    const previewReceipt = files[source]?.previewReceipt;
    expect(previewReceipt).toBeDefined();
    expect(await readFile(source, "utf8")).toBe(previous + "\n");
    expect(await deferredRefresh.readRefreshState(transactionPath)).toEqual(
      beforePreview,
    );

    const committed = success(
      await call("file_patch", {
        workspaceId,
        files: { [source]: { expectedSha256, previewReceipt } },
      }),
    );
    expect(committed).toMatchObject({
      intelligenceRefresh: { generationId: null, refreshPending: true },
    });
    expect(await readFile(source, "utf8")).toBe(next + "\n");
    expect(schedule).toHaveBeenCalled();
    expect(
      await deferredRefresh.readRefreshState(transactionPath),
    ).toMatchObject({
      kind: "pending",
      paths: ["service.ts"],
    });

    if (git) {
      workspaceId = await openWorkspace();
      expect(workspaceId).not.toBe(openedWorkspaceId);
    }
    const live = success<{
      files: Array<{ symbols: Array<{ name: string }> }>;
    }>(await call("map", { workspaceId, paths: ["service.ts"] }));
    expect(live).toMatchObject({ generation: null, indexRefreshPending: true });
    expect(
      live.files.flatMap((file) => file.symbols.map((symbol) => symbol.name)),
    ).toEqual(["afterMarker"]);

    const stale = success<{
      results: Array<{ text: string }>;
    }>(
      await call("retrieve", {
        workspaceId,
        query: "beforeMarker",
        semantic: false,
      }),
    );
    expect(stale).toMatchObject({
      freshness: { stale: true, reason: "index_refresh_pending" },
      scope: {
        generationId: originalGeneration,
        workspaceId: openedWorkspaceId,
      },
    });
    expect(
      stale.results.some(({ text }) => text.includes("beforeMarker")),
    ).toBeTrue();
    const staleGraph = success(
      await call("graph_query", {
        workspaceId,
        operation: "components",
        startNodeIds: ["graph-node:v1:" + "a".repeat(64)],
      }),
    );
    expect(staleGraph).toMatchObject({
      freshness: { stale: true },
      generation: originalGeneration,
    });

    if (git)
      expect(staleGraph).toMatchObject({
        freshness: { generationWorkspaceId: openedWorkspaceId },
      });
    const original = { workspaceId, generationId: originalGeneration };
    const pinned = success<{
      base: { generation: string };
      target: { generation: string };
    }>(await call("graph_diff", { base: original, target: original }));
    expect(pinned.base.generation).toBe(originalGeneration);
    expect(pinned.target.generation).toBe(originalGeneration);
    if (mode === "publication") {
      const scheduled = schedule.mock.calls.at(-1);
      if (!scheduled) throw new Error("Write did not schedule a refresh");
      const [key, state, work] = scheduled;
      expect(key).toBe(transactionPath);

      const first = holdFinalization();
      const job = work(state);
      await first.enter(job);
      await checkoutAdmission.withCheckoutAdmission(
        key,
        { deadline: Date.now() + 10_000 },
        async () => {
          first.release();
          expect(await job).toBe("retry");
          expect(await deferredRefresh.readRefreshState(key)).toEqual(state);
          const claim = await acquireTransactionLock(key + ".refresh-job", {
            tryOnly: true,
          });
          claim.release();
        },
      );

      const external = "export function externalMarker() { return 4; }";
      schedule.mockClear();
      const restaged = holdFinalization();
      const retryJob = work(state);
      await restaged.enter(retryJob);
      await writeFile(source, external + "\n");
      restaged.release();
      await retryJob;
      const retry = await deferredRefresh.readRefreshState(transactionPath);
      if (retry?.kind !== "pending")
        throw new Error("External edit did not leave a pending refresh");
      expect(retry.publishedGenerationId).toBe(originalGeneration);
      expect(retry.epoch).not.toBe(state.epoch);
      const followUp = schedule.mock.calls.at(-1);
      expect(followUp?.[1]).toEqual(retry);
      if (!followUp) throw new Error("External edit did not schedule a retry");
      await followUp[2](retry);
      const repaired = await deferredRefresh.readRefreshState(key);
      if (repaired?.kind !== "clean")
        throw new Error("Refresh did not catch up after the writer released");

      const withExternalEdit = await openWorkspace();
      const retrieved = success<{ results: Array<{ text: string }> }>(
        await call("retrieve", {
          workspaceId: withExternalEdit,
          query: "externalMarker",
          semantic: false,
        }),
      );
      expect(retrieved).toMatchObject({
        freshness: { stale: false },
        scope: { generationId: repaired.publishedGenerationId },
      });
      expect(
        retrieved.results.some(({ text }) => text.includes("externalMarker")),
      ).toBeTrue();

      const staged = holdFinalization();
      const build = call("index", {
        action: "refresh",
        workspaceId: withExternalEdit,
      });
      await staged.enter(build);
      const configPending = await deferredRefresh.readRefreshState(key);
      const configuration = path.join(checkout, "ast-mcp.toml");
      const admit = checkoutAdmission.withCheckoutAdmission;
      const admission = spyOn(
        checkoutAdmission,
        "withCheckoutAdmission",
      ).mockImplementationOnce(async (...args) => {
        const config = await readFile(configuration, "utf8");
        await writeFile(
          configuration,
          config + '\n[workspace]\nworktrees = "ignore"\n',
        );
        return admit(...args);
      });
      try {
        staged.release();
        const result = await build;
        expect(result.isError).toBeTrue();
        expect(result.structuredContent).toMatchObject({
          error: { code: "intelligence_refresh_pending", retryable: true },
        });
      } finally {
        admission.mockRestore();
      }
      expect(configPending).toMatchObject({
        kind: "pending",
        publishedGenerationId: repaired.publishedGenerationId,
      });
      expect(await deferredRefresh.readRefreshState(key)).toEqual(
        configPending,
      );
      return;
    }
    if (mode === "git") {
      async function runScheduledRefresh(
        scheduled = schedule.mock.calls.at(-1),
      ) {
        if (!scheduled)
          throw new Error("Git checkout did not schedule a refresh");
        const [key, state, work] = scheduled;
        expect(key).toBe(transactionPath);
        await work(state);
        const clean = await deferredRefresh.readRefreshState(key);
        if (clean?.kind !== "clean")
          throw new Error("Git checkout refresh did not publish");
        return clean;
      }

      const refreshed = await runScheduledRefresh();
      expect(refreshed.publishedGenerationId).not.toBe(originalGeneration);
      expect(await openWorkspace()).toBe(workspaceId);
      expect(
        success(
          await call("retrieve", {
            workspaceId,
            query: "afterMarker",
            semantic: false,
          }),
        ),
      ).toMatchObject({
        freshness: { stale: false },
        scope: { generationId: refreshed.publishedGenerationId, workspaceId },
      });

      async function publishInterveningScope(scope: string) {
        const writer = await acquireFileLock(transactionPath, {
          sharedDatabasePath: await mutationSharedDatabasePath(checkout),
        });
        try {
          const intervening = await deferredRefresh.markRefreshPending(
            transactionPath,
            [],
            scope,
            refreshed.storageScope,
          );
          await deferredRefresh.markRefreshPublished(
            transactionPath,
            intervening.epoch,
            refreshed.publishedGenerationId,
          );
        } finally {
          await writer.release();
        }
      }

      const configuration = path.join(checkout, "ast-mcp.toml");
      await writeFile(
        configuration,
        (await readFile(configuration, "utf8")) +
          '\n[workspace]\nworktrees = "ignore"\n',
      );
      await configRegistry.reload();
      const reconfigured = await openWorkspace();
      expect(reconfigured).not.toBe(workspaceId);
      schedule.mockClear();
      const pending = await call("retrieve", {
        workspaceId: reconfigured,
        query: "afterMarker",
        semantic: false,
      });
      expect(pending.isError).toBeTrue();
      expect(pending.structuredContent).toMatchObject({
        error: { code: "intelligence_refresh_pending", retryable: true },
      });
      const transition = schedule.mock.calls.at(-1);
      if (!transition)
        throw new Error("Config drift did not schedule a refresh");
      const [key, ticket, work, targetScope] = transition;
      if (!targetScope) throw new Error("Refresh target scope is missing");
      expect(ticket.epoch).toBe(refreshed.epoch);
      expect(targetScope).not.toBe(refreshed.scope);
      const buildCount = refreshSpy.mock.calls.length;
      const active = await acquireTransactionLock(key + ".refresh-job");
      try {
        expect(await work(ticket)).toBe("retry");
        expect(refreshSpy.mock.calls).toHaveLength(buildCount);
        // Model the elected job publishing another compatible scope before release.
        const interveningScope = "a".repeat(64);
        expect(interveningScope).not.toBe(ticket.scope);
        expect(interveningScope).not.toBe(targetScope);
        await publishInterveningScope(interveningScope);
      } finally {
        active.release();
      }
      const rebuilt = await runScheduledRefresh(transition);
      expect(rebuilt.scope).toBe(targetScope);
      expect(refreshSpy.mock.calls).toHaveLength(buildCount + 1);
      await work(ticket);
      expect(refreshSpy.mock.calls).toHaveLength(buildCount + 1);
      expect(rebuilt.publishedGenerationId).not.toBe(
        refreshed.publishedGenerationId,
      );
      expect(await openWorkspace()).toBe(reconfigured);

      schedule.mockClear();
      expect(
        success(
          await call("file_patch", {
            workspaceId: reconfigured,
            files: {
              [source]: {
                expectedSha256: sha256(next + "\n"),
                patchStrategy: "aider_block",
                aiderBlocks: [{ search: next, replace: latest }],
              },
            },
          }),
        ),
      ).toMatchObject({ intelligenceRefresh: { refreshPending: true } });
      const normal = schedule.mock.calls.at(-1);
      if (!normal) throw new Error("Current scope did not schedule a refresh");
      const [, normalTicket, normalWork, normalScope] = normal;
      expect(normalTicket.scope).toBe(targetScope);
      expect(normalScope).toBe(targetScope);
      expect(await deferredRefresh.readRefreshState(transactionPath)).toEqual(
        normalTicket,
      );

      await publishInterveningScope(refreshed.scope);
      const afterIntervening = await runScheduledRefresh(normal);
      expect(afterIntervening.scope).toBe(targetScope);
      expect(afterIntervening.publishedGenerationId).not.toBe(
        rebuilt.publishedGenerationId,
      );
      expect(refreshSpy.mock.calls).toHaveLength(buildCount + 2);
      await normalWork(normalTicket);
      expect(refreshSpy.mock.calls).toHaveLength(buildCount + 2);
      expect(await deferredRefresh.readRefreshState(transactionPath)).toEqual(
        afterIntervening,
      );
      return;
    }

    const scheduled = schedule.mock.calls.at(-1);
    if (!scheduled)
      throw new Error("Deferred dispatch omitted the background job");
    const [key, state, work] = scheduled;
    expect(key).toBe(transactionPath);
    const background = holdFinalization(true);
    const firstJob = work(state);
    await background.enter(firstJob, "parse");
    // Probe the same kernel guard as a foreground checkout writer.
    const writerGuard = await acquireTransactionLock(
      path.join(
        path.dirname(key),
        `file-${sha256(lockPathIdentity(key))}.sqlite`,
      ),
      {
        sharedDatabasePath: await mutationSharedDatabasePath(checkout),
        tryOnly: true,
      },
    );
    writerGuard.release();
    const staging = Promise.withResolvers<void>();
    const releaseStaging = Promise.withResolvers<void>();
    releases.push(releaseStaging.resolve);
    const writeBatch = LanceIntelligenceStore.prototype.putReservedRowsBatch;
    const stagingSpy = spyOn(
      LanceIntelligenceStore.prototype,
      "putReservedRowsBatch",
    ).mockImplementationOnce(async function (
      this: LanceIntelligenceStore,
      ...args
    ) {
      await this.coordinator.exclusive("hold reserved staging", async () => {
        staging.resolve();
        await releaseStaging.promise;
      });
      return writeBatch.apply(this, args);
    });
    stagingSpies.push(stagingSpy);
    background.releaseParse();
    await Promise.race([
      staging.promise,
      firstJob.then(() => {
        throw new Error("Refresh completed before locking the staging store");
      }),
    ]);

    const builds = refreshSpy.mock.calls.length;
    await work(state);
    expect(refreshSpy.mock.calls).toHaveLength(builds);
    expect(await deferredRefresh.readRefreshState(key)).toEqual(state);

    async function startStrictRead(signal?: AbortSignal) {
      const entered = Promise.withResolvers<void>();
      schedule.mockImplementationOnce(() => entered.resolve());
      const result = call(
        "retrieve",
        {
          workspaceId,
          query: "latestMarker",
          semantic: false,
          strictRead: true,
        },
        signal,
      );
      await Promise.race([
        entered.promise,
        result.then(() => {
          throw new Error("Strict read completed before refresh publication");
        }),
      ]);
      return { result };
    }
    const controller = new AbortController();
    const cancelled = await startStrictRead(controller.signal);
    controller.abort(new Error("Strict read cancelled by fixture"));
    await expect(cancelled.result).rejects.toThrow(/cancelled|abort/i);
    const newerCommit = success(
      await call("file_patch", {
        workspaceId,
        files: {
          [source]: {
            expectedSha256: sha256(next + "\n"),
            patchStrategy: "aider_block",
            aiderBlocks: [{ search: next, replace: latest }],
          },
        },
      }),
    );
    expect(newerCommit).toMatchObject({
      intelligenceRefresh: { generationId: null, refreshPending: true },
    });
    expect(await readFile(source, "utf8")).toBe(latest + "\n");
    const newer = await deferredRefresh.readRefreshState(key);
    if (newer?.kind !== "pending")
      throw new Error("Concurrent commit did not retain a pending refresh");
    expect(newer.epoch).not.toBe(state.epoch);
    expect(newer.publishedGenerationId).toBe(originalGeneration);
    expect(newer.journal).toBe("sqlite-v1");
    const retained = success(
      await call("retrieve", {
        workspaceId,
        query: "beforeMarker",
        semantic: false,
      }),
    );
    expect(retained).toMatchObject({
      freshness: { stale: true },
      scope: { generationId: originalGeneration },
    });
    const current = success<{
      files: Array<{ symbols: Array<{ name: string }> }>;
    }>(await call("map", { workspaceId, paths: ["service.ts"] }));
    expect(current).toMatchObject({
      generation: null,
      indexRefreshPending: true,
    });
    expect(
      current.files.flatMap((file) =>
        file.symbols.map((symbol) => symbol.name),
      ),
    ).toEqual(["latestMarker"]);

    expect(
      success(
        await call("read_symbols", {
          workspaceId,
          paths: ["service.ts"],
          symbols: ["latestMarker", "beforeMarker"],
        }),
      ),
    ).toMatchObject({
      generation: null,
      indexRefreshPending: true,
      items: [
        { status: "found", symbol: "latestMarker" },
        { status: "missing", symbol: "beforeMarker" },
      ],
    });

    releaseStaging.resolve();
    await background.enter(firstJob);
    background.release();
    await firstJob;
    expect(await deferredRefresh.readRefreshState(key)).toEqual(newer);
    const queued = schedule.mock.calls.findLast(
      ([, pending]) => pending.epoch === newer.epoch,
    );
    if (!queued)
      throw new Error("Concurrent commit did not schedule the newer epoch");
    const publication = holdFinalization();
    const latestJob = queued[2](queued[1]);
    await publication.enter(latestJob);
    const { result: strict } = await startStrictRead();
    publication.release();
    await latestJob;
    const published = await deferredRefresh.readRefreshState(key);
    if (published?.kind !== "clean")
      throw new Error("Background refresh left the checkout pending");
    const generation = published.publishedGenerationId;
    expect(generation).toStartWith("generation:v1:");
    expect(generation).not.toBe(originalGeneration);
    const refreshed = success<{
      scope: { generationId: string };
      results: Array<{ text: string }>;
    }>(await strict);
    expect(refreshed).toMatchObject({
      freshness: { stale: false },
      scope: { generationId: generation },
    });
    expect(
      refreshed.results.some(({ text }) => text.includes("latestMarker")),
    ).toBeTrue();
    await work(state);
    expect(await deferredRefresh.readRefreshState(key)).toEqual(published);
  } finally {
    for (const release of releases) release();
    await Promise.allSettled(jobs);
    refreshSpy.mockRestore();
    for (const spy of stagingSpies) spy.mockRestore();
    schedule.mockRestore();
    try {
      await client.close();
    } finally {
      await server.close();
    }
  }
}

async function launchFixture(mode: FixtureMode): Promise<void> {
  const childFixture = process.env[fixtureEnv];
  if (childFixture) {
    if (process.env[fixtureModeEnv] === mode)
      await runFixture(childFixture, mode);
    return;
  }

  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-deferred-mcp-")),
  );
  const git = mode === "git" || mode === "publication";
  const checkout = path.join(root, "checkout");
  let marker: string | undefined;
  let journal: string | undefined;
  try {
    await mkdir(checkout);
    const transaction = await mutationTransactionLockPath(checkout);
    marker = transaction + ".refresh.json";
    const domain = resolveStorageDomain(
      checkout,
      git
        ? { kind: "local" }
        : { kind: "explicit", path: path.join(root, "index") },
    );
    const identity = sha256(
      JSON.stringify([path.basename(transaction), domain.domainId]),
    );
    journal = path.join(
      path.dirname(transaction),
      `mutation-journal-${identity}.sqlite`,
    );
    await Promise.all([
      writeFile(path.join(checkout, "service.ts"), previous + "\n"),
      writeFile(
        path.join(checkout, "ast-mcp.toml"),
        [
          "version = 2",
          "[telemetry]",
          "enabled = false",
          "[formatting]",
          "enabled = false",
          "[[paths]]",
          'id = "fixture"',
          'path = "."',
          'policies = { read = "allow", write = "allow" }',
          "",
        ].join("\n"),
      ),
    ]);
    if (git) {
      for (const args of [
        ["init", "-q"],
        ["add", "--", "service.ts", "ast-mcp.toml"],
        [
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "user.name=Fixture",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=.git/no-hooks",
          "commit",
          "-qm",
          "Initial index source",
        ],
      ]) {
        const git = Bun.spawnSync(["git", ...args], {
          cwd: checkout,
          stderr: "pipe",
          stdout: "ignore",
        });
        expect(git.exitCode, git.stderr.toString()).toBe(0);
      }
    }
    const env = { ...process.env };
    delete env.AST_MCP_EXPERIMENT_DEFERRED_REFRESH;
    // The isolated runner uses the package suite's integration safety ceiling.
    // The fixture still exercises the original MCP and transaction deadlines.
    const child = Bun.spawn(
      [process.execPath, "test", "--timeout=30000", import.meta.path],
      {
        cwd: checkout,
        env: {
          ...env,
          [fixtureEnv]: root,
          [fixtureModeEnv]: mode,
          APPDATA: path.join(root, "config"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          AST_MCP_EXPERIMENT_NATIVE_ONLY: "1",
          AST_MCP_TELEMETRY: "0",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    try {
      const [exit, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect(exit, stderr + stdout).toBe(0);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
    }
  } finally {
    if (marker) {
      await rm(marker, { force: true });
      await rm(marker + ".tmp", { force: true });
    }
    if (journal)
      for (const suffix of ["", "-journal", "-wal", "-shm"])
        await rm(journal + suffix, { force: true });
    await rm(root, { recursive: true, force: true });
  }
}

test("indexed reads and writes continue during staging with SQLite", () =>
  launchFixture("plain"));

test("a rebuild exposes only a previously published generation from its selected store", () =>
  launchFixture("selection"));

test("unindexed writes enroll SQLite and an explicit build preserves recovery ownership", () =>
  launchFixture("unindexed"));

test("reopened Git workspaces keep local generations stable and rebuild after configuration changes", () =>
  launchFixture("git"));

test("deferred publication yields to checkout writers and rejects stale candidates", () =>
  launchFixture("publication"));

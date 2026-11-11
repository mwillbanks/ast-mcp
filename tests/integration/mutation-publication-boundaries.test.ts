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

import { withConfig } from "../../src/config/index.ts";
import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../../src/intelligence/contracts/common.ts";
import type { PublicationGeneration } from "../../src/intelligence/contracts/storage.ts";
import * as markers from "../../src/intelligence/mutation/experimental-deferred-refresh.ts";
import * as freshness from "../../src/intelligence/mutation/freshness.ts";
import { activeMutationLifecycle } from "../../src/intelligence/mutation/lifecycle.ts";
import { privateMutationJournalLocation } from "../../src/intelligence/mutation/private-journal.ts";
import {
  assertPublishedMutationGeneration,
  mutationTransactionLockPath,
  observeMutationIndex,
  withDeferredIndexPublication,
  withFreshMutationRead,
  withLanceMutationLifecycle,
} from "../../src/intelligence/mutation/service.ts";
import type { MutationRefreshResult } from "../../src/intelligence/mutation/types.ts";
import * as git from "../../src/intelligence/workspace/git.ts";
import {
  withWorkspaceContext,
  WorkspaceRegistry,
  type WorkspaceHandle,
} from "../../src/intelligence/workspace/index.ts";
import { withCheckoutAdmission } from "../../src/runtime/checkout-admission.ts";
import { sha256 } from "../../src/runtime/hash.ts";
import { acquireTransactionLock } from "../../src/runtime/transaction-lock.ts";
import { MOCK_EPOCH } from "../support/mock-time.ts";

const publishedAt = new Date(MOCK_EPOCH).toISOString();
const pendingError = { code: "intelligence_refresh_pending", retryable: true };

function publication(
  workspace: WorkspaceHandle,
  label: string,
): PublicationGeneration {
  return {
    generationId: createIdentity("generation", { label }),
    immutable: true,
    manifestArtifactId: createIdentity("revision-manifest", { label }),
    publishedAt,
    revisionId: workspace.selectedRevision.revisionId,
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    state: "published",
    storageDomainId: workspace.storageDomain.domainId,
    tableVersions: [],
    workspaceId: workspace.workspaceId,
  };
}

function refreshResult(generationId: string | null): MutationRefreshResult {
  return {
    dirtyOverlayId: null,
    generationId,
    indexedAt: publishedAt,
    parsedFiles: [],
    skippedFiles: [],
  };
}

async function publishFixture(
  finalize: freshness.MutationRefreshFinalizer | undefined,
  generation: PublicationGeneration,
) {
  if (!finalize) throw new Error("Working publication omitted its fence");
  const result = await finalize(async () => generation);
  return refreshResult(result.generationId);
}

async function withPublicationFixture(
  run: (fixture: {
    alternate: WorkspaceHandle;
    checkout: string;
    transaction: string;
    workspace: WorkspaceHandle;
    scheduled: Array<Parameters<typeof markers.scheduleMutationRefresh>>;
  }) => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-publication-boundaries-")),
  );
  const scheduled: Array<Parameters<typeof markers.scheduleMutationRefresh>> =
    [];
  const scheduler = spyOn(
    markers,
    "scheduleMutationRefresh",
  ).mockImplementation((...args) => {
    scheduled.push(args);
  });
  let transaction: string | undefined;
  let journal: string | undefined;
  try {
    const checkout = path.join(root, "checkout");
    await mkdir(checkout);
    await writeFile(path.join(checkout, "ast-mcp.toml"), "version = 2\n");
    const registry = new WorkspaceRegistry();
    const options = { configurationGeneration: 1, directory: checkout };
    const workspace = await registry.open({
      ...options,
      storage: { kind: "explicit", path: path.join(root, "index") },
    });
    const alternate = await registry.open({
      ...options,
      storage: { kind: "explicit", path: path.join(root, "alternate") },
    });
    const lock = await mutationTransactionLockPath(checkout);
    transaction = lock;
    journal = (
      await privateMutationJournalLocation(
        lock,
        workspace.storageDomain.domainId,
      )
    ).storagePath;
    const home = path.join(root, "config");
    await withConfig(
      { cwd: checkout, home, env: { APPDATA: home, XDG_CONFIG_HOME: home } },
      () =>
        withWorkspaceContext(workspace, () =>
          run({
            alternate,
            checkout,
            transaction: lock,
            workspace,
            scheduled,
          }),
        ),
    );
  } finally {
    scheduler.mockRestore();
    if (transaction)
      for (const suffix of [".refresh.json", ".refresh.json.tmp"])
        await rm(transaction + suffix, { force: true });
    if (journal)
      for (const suffix of ["", "-journal", "-wal", "-shm"])
        await rm(journal + suffix, { force: true });
    await rm(root, { recursive: true, force: true });
  }
}

test("explicit publication requires its fence and strict reads reject intervening writes", async () => {
  await withPublicationFixture(
    async ({ transaction, workspace, scheduled }) => {
      expect(await observeMutationIndex(workspace)).toEqual({ pending: false });
      const generation = publication(workspace, "initial");
      const active = await acquireTransactionLock(transaction + ".refresh-job");
      try {
        await expect(
          withDeferredIndexPublication(workspace, async () => {
            throw new Error("A competing publication entered");
          }),
        ).rejects.toMatchObject(pendingError);
      } finally {
        active.release();
      }

      await expect(
        withDeferredIndexPublication(workspace, async () =>
          refreshResult(generation.generationId),
        ),
      ).rejects.toMatchObject(pendingError);
      expect(await markers.readRefreshState(transaction)).toMatchObject({
        kind: "pending",
        inFlight: false,
      });
      await expect(
        withFreshMutationRead(workspace, async () => {
          throw new Error("A pending read entered");
        }),
      ).rejects.toMatchObject(pendingError);

      const result = await withDeferredIndexPublication(workspace, (finalize) =>
        publishFixture(finalize, generation),
      );
      expect(result.generationId).toBe(generation.generationId);
      expect(
        await withFreshMutationRead(
          workspace,
          async (generationId) => generationId,
        ),
      ).toBe(generation.generationId);
      assertPublishedMutationGeneration(
        generation.generationId,
        result.generationId ?? undefined,
      );
      expect(() =>
        assertPublishedMutationGeneration(generation.generationId, undefined),
      ).toThrow("Working intelligence requires a fresh index");

      const clean = await markers.readRefreshState(transaction);
      if (clean?.kind !== "clean")
        throw new Error("Publication did not become visible");
      await expect(
        withFreshMutationRead(workspace, async (generationId) => {
          expect(generationId).toBe(generation.generationId);
          await markers.markRefreshPending(
            transaction,
            ["edited.ts"],
            clean.scope,
            clean.storageScope,
          );
          return "stale result";
        }),
      ).rejects.toMatchObject(pendingError);
      expect(scheduled.at(-1)?.[1]).toMatchObject({
        paths: ["edited.ts"],
        publishedGenerationId: generation.generationId,
      });
    },
  );
});

test("a deferred job recovers an in-flight epoch and retries transient contention", async () => {
  await withPublicationFixture(
    async ({ transaction, workspace, scheduled }) => {
      const original = publication(workspace, "original");
      await withDeferredIndexPublication(workspace, (finalize) =>
        publishFixture(finalize, original),
      );

      const operationId = createIdentity("job", {
        checkout: workspace.checkoutRoot,
        label: "refresh",
      });
      await withLanceMutationLifecycle(async () => {
        const lifecycle = activeMutationLifecycle();
        if (!lifecycle) throw new Error("Write did not enroll its journal");
        await lifecycle.begin({
          files: [],
          operationId,
          tool: "file_patch",
          workspace,
        });
        expect(await lifecycle.complete(operationId, [])).toMatchObject({
          generationId: null,
          refreshPending: true,
        });
      });
      const previous = scheduled.at(-1);
      if (!previous)
        throw new Error("Terminal write omitted the scheduled refresh");
      const [, ready, work] = previous;
      const claim = await acquireTransactionLock(transaction + ".refresh-job");
      try {
        expect(await work(ready)).toBe("retry");
      } finally {
        claim.release();
      }

      const transient = spyOn(freshness, "refreshMutationIntelligence");
      try {
        transient.mockRejectedValueOnce(
          Object.assign(new Error("Store busy"), {
            code: "coordinator_unavailable",
          }),
        );
        expect(await work(ready)).toBe("retry");
        transient.mockRejectedValueOnce(
          Object.assign(new Error("Writer busy"), { code: "lock_busy" }),
        );
        expect(await work(ready)).toBe("retry");
        const unknown = new Error("Unexpected refresh failure");
        transient.mockRejectedValueOnce(unknown);
        await expect(work(ready)).rejects.toBe(unknown);
        expect(await markers.readRefreshState(transaction)).toEqual(ready);

        const pending = await markers.markRefreshPending(
          transaction,
          ["again.ts"],
          ready.scope,
          ready.storageScope,
          { inFlight: true },
        );
        expect(await observeMutationIndex(workspace)).toMatchObject({
          epoch: pending.epoch,
          pending: true,
          generationId: original.generationId,
        });
        const recovery = scheduled.at(-1);
        if (!recovery || recovery[1].epoch !== pending.epoch)
          throw new Error("The recovery epoch did not reach the scheduler");
        const next = publication(workspace, "recovered");
        transient.mockImplementationOnce(({ finalize }) =>
          publishFixture(finalize, next),
        );
        await recovery[2](pending);
        expect(await markers.readRefreshState(transaction)).toMatchObject({
          kind: "clean",
          journal: "sqlite-v1",
          publishedGenerationId: next.generationId,
        });
        const refreshes = transient.mock.calls.length;
        await work(ready);
        expect(transient).toHaveBeenCalledTimes(refreshes);
      } finally {
        transient.mockRestore();
      }
    },
  );
});

test("a changed scope rebuilds and an unrelated storage domain cannot recover the checkout", async () => {
  await withPublicationFixture(
    async ({ alternate, transaction, workspace, scheduled }) => {
      const generation = publication(workspace, "configuration");
      await withDeferredIndexPublication(workspace, (finalize) =>
        publishFixture(finalize, generation),
      );
      const clean = await markers.readRefreshState(transaction);
      if (clean?.kind !== "clean")
        throw new Error("Initial generation did not publish");
      const olderScope = sha256("different configuration");
      const old = await markers.markRefreshPending(
        transaction,
        [],
        olderScope,
        clean.storageScope,
      );
      await markers.markRefreshPublished(
        transaction,
        old.epoch,
        generation.generationId,
      );
      expect(await observeMutationIndex(workspace)).toMatchObject({
        pending: true,
      });
      const transition = scheduled.at(-1);
      if (!transition)
        throw new Error("Scope change did not schedule a transition");
      const [, ticket, work, scope] = transition;
      expect(ticket.scope).toBe(olderScope);
      expect(scope).toBe(clean.scope);
      expect(ticket.paths).toBeNull();

      const refresh = spyOn(
        freshness,
        "refreshMutationIntelligence",
      ).mockImplementationOnce(({ finalize }) =>
        publishFixture(finalize, generation),
      );
      try {
        await work(ticket);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(await markers.readRefreshState(transaction)).toMatchObject({
          kind: "clean",
          scope: clean.scope,
          publishedGenerationId: generation.generationId,
        });
      } finally {
        refresh.mockRestore();
      }

      const unfinished = await markers.markRefreshPending(
        transaction,
        ["half-written.ts"],
        clean.scope,
        clean.storageScope,
        { inFlight: true },
      );
      await expect(
        withDeferredIndexPublication(alternate, async () => {
          throw new Error(
            "Unrelated storage recovered another checkout journal",
          );
        }),
      ).rejects.toMatchObject(pendingError);
      await expect(
        withWorkspaceContext(alternate, () =>
          withLanceMutationLifecycle(async () => {
            throw new Error(
              "Unrelated storage started a write during recovery",
            );
          }),
        ),
      ).rejects.toMatchObject(pendingError);
      expect(await markers.readRefreshState(transaction)).toEqual(unfinished);
    },
  );
});

test("explicit refresh yields its publication fence to the admitted writer", async () => {
  await withPublicationFixture(
    async ({ transaction, workspace, scheduled }) => {
      const generation = publication(workspace, "contended");
      const publish = async () => {
        throw new Error(
          "A queued publication must never commit under another writer",
        );
      };
      await expect(
        withDeferredIndexPublication(workspace, async (finalize) => {
          if (!finalize)
            throw new Error("Working publication omitted its fence");
          await withCheckoutAdmission(
            transaction,
            { deadline: Date.now() + 10_000 },
            () => finalize(publish),
          );
          return refreshResult(generation.generationId);
        }),
      ).rejects.toMatchObject(pendingError);

      const pending = await markers.readRefreshState(transaction);
      if (pending?.kind !== "pending")
        throw new Error("The admitted writer did not leave a pending refresh");
      expect(pending.inFlight).toBeFalse();
      expect(scheduled.at(-1)?.[1]).toEqual(pending);
      expect(
        await withDeferredIndexPublication(workspace, (finalize) =>
          publishFixture(finalize, generation),
        ),
      ).toMatchObject({ generationId: generation.generationId });
    },
  );
});

test("external overlay edits and configuration changes fence off staged publication", async () => {
  await withPublicationFixture(
    async ({ checkout, transaction, workspace, scheduled }) => {
      const generation = publication(workspace, "staged");
      const configPath = path.join(checkout, "ast-mcp.toml");
      const overlay = spyOn(git, "gitDirtyOverlayId")
        .mockResolvedValueOnce(createIdentity("overlay", { version: 1 }))
        .mockResolvedValueOnce(createIdentity("overlay", { version: 2 }));
      try {
        await expect(
          withDeferredIndexPublication(workspace, async (finalize) => {
            if (!finalize)
              throw new Error("Working publication omitted its fence");
            const before = await markers.readRefreshState(transaction);
            if (before?.kind !== "pending")
              throw new Error("Publication did not mark its epoch");
            try {
              await finalize(async () => {
                throw new Error("A stale overlay reached publication");
              });
            } finally {
              const after = await markers.readRefreshState(transaction);
              expect(after?.epoch).not.toBe(before.epoch);
              expect(after).toMatchObject({ kind: "pending", inFlight: false });
            }
            return refreshResult(generation.generationId);
          }),
        ).rejects.toMatchObject(pendingError);
        const pending = await markers.readRefreshState(transaction);
        if (pending?.kind !== "pending")
          throw new Error("The overlay edit did not leave a pending refresh");
        expect(scheduled.at(-1)?.[1]).toEqual(pending);
      } finally {
        overlay.mockRestore();
      }

      const previous = await markers.readRefreshState(transaction);
      await expect(
        withDeferredIndexPublication(workspace, async (finalize) => {
          if (!finalize)
            throw new Error("Working publication omitted its fence");
          await writeFile(
            configPath,
            'version = 2\n[workspace]\nworktrees = "ignore"\n',
          );
          await finalize(async () => {
            throw new Error("Stale configuration reached publication");
          });
          return refreshResult(generation.generationId);
        }),
      ).rejects.toMatchObject(pendingError);
      expect(await markers.readRefreshState(transaction)).toEqual(previous);
    },
  );
});

test("an interrupted unindexed SQLite mutation rolls back before subsequent reads", async () => {
  await withPublicationFixture(
    async ({ checkout, transaction, workspace, scheduled }) => {
      const filePath = path.join(checkout, "partially-written.ts");
      const source = "export const value = 1;\n";
      const candidate = "export const value = 2;\n";
      await writeFile(filePath, source);
      const operationId = createIdentity("job", {
        checkout,
        label: "interrupted",
      });
      const interruption = new Error("Simulated writer interruption");
      await expect(
        withLanceMutationLifecycle(async () => {
          const lifecycle = activeMutationLifecycle();
          if (!lifecycle) throw new Error("Write did not enroll SQLite");
          await lifecycle.begin({
            files: [
              {
                candidateSha256: sha256(candidate),
                filePath,
                sourceContentBase64: Buffer.from(source).toString("base64"),
                sourceSha256: sha256(source),
              },
            ],
            operationId,
            tool: "file_patch",
            workspace,
          });
          await writeFile(filePath, candidate);
          await lifecycle.committed(operationId, {
            filePath,
            sha256: sha256(candidate),
          });
          throw interruption;
        }),
      ).rejects.toBe(interruption);
      expect(await readFile(filePath, "utf8")).toBe(candidate);
      expect(await observeMutationIndex(workspace)).toMatchObject({
        pending: true,
      });
      expect(scheduled).toHaveLength(0);

      await withLanceMutationLifecycle(async () => {
        expect(await readFile(filePath, "utf8")).toBe(source);
        expect(await markers.readRefreshState(transaction)).toMatchObject({
          indexRefresh: false,
          inFlight: false,
          journal: "sqlite-v1",
        });
        expect(await observeMutationIndex(workspace)).toMatchObject({
          pending: false,
        });
      });
      expect(scheduled).toHaveLength(0);
    },
  );
});

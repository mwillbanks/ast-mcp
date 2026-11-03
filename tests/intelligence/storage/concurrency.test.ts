import { beforeEach, spyOn } from "bun:test";

import {
  createMockTime,
  deferred,
  type MockTime,
} from "../../support/mock-time.ts";
let time: MockTime;
beforeEach(() => {
  time = createMockTime();
});
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as lancedb from "@lancedb/lancedb";

import { sourceArtifactIdentity as sourceIdentity } from "../../../src/intelligence/contracts/artifacts.ts";
import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../../../src/intelligence/contracts/common.ts";
import {
  createStorageDomainId,
  type StorageDomain,
} from "../../../src/intelligence/contracts/storage.ts";
import {
  clearCoordinatorRegistryForTests,
  LanceIntelligenceStore,
  StorageCoordinator,
  StorageError,
  withLanceRetry,
} from "../../../src/intelligence/storage/index.ts";

const NOW = "2026-09-10T00:00:00.000Z";

async function domain(): Promise<StorageDomain> {
  const storagePath = await mkdtemp(join(tmpdir(), "ast-mcp-concurrency-"));
  return {
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
}

function sourceRow(index: number) {
  const digest = index.toString(16).padStart(64, "0");
  return {
    artifact_id: sourceIdentity({ contentDigest: digest }),
    byte_length: 4,
    content_bytes: new Uint8Array([index % 256, 1, 2, 3]),
    content_digest: digest,
    created_at: NOW,
    kind: "source",
    payload_json: JSON.stringify({ digest }),
  };
}

describe("LanceDB storage coordination", () => {
  test("shares a coordinator across Windows path aliases", async () => {
    clearCoordinatorRegistryForTests();
    let closes = 0;
    const connection = {
      close() {
        closes += 1;
      },
    } as unknown as Parameters<
      typeof StorageCoordinator.forStorageDirectory
    >[0];
    const first = StorageCoordinator.forStorageDirectory(
      connection,
      "domain",
      String.raw`C:\Data\Index`,
    );
    const second = StorageCoordinator.forStorageDirectory(
      connection,
      "domain",
      String.raw`\\?\C:\DATA\INDEX`,
    );

    expect(second).toBe(first);
    await first.release();
    expect(closes).toBe(0);
    await second.release();
    expect(closes).toBe(1);
  });

  test("serializes bounded concurrent append workers without duplicate artifacts", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage, {
      leaseDurationMs: 60_000,
    });
    const writes = Array.from({ length: 100 }, (_, index) =>
      store.putRows("artifacts", [sourceRow(index)]),
    );
    await Promise.all(writes);
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        store.putRows("artifacts", [sourceRow(index)]),
      ),
    );
    expect(await store.count("artifacts")).toBe(100);
    const totals = (await Promise.all(writes)).reduce(
      (sum, result) => sum + result.insertedRows,
      0,
    );
    expect(totals).toBe(100);
    await store.shutdownCoordinator();
  });

  test("pins old and new complete generations without mixed table versions", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const workspaceId = createIdentity("workspace", { name: "reader" });
    const revisionId = createIdentity("revision", { name: "reader" });
    const manifestArtifactId = createIdentity("revision-manifest", {
      name: "reader",
    });

    await store.putRows("artifacts", [sourceRow(1)]);
    const oldGeneration = await store.publish({
      manifestArtifactId,
      revisionId,
      workspaceId,
    });
    const oldReader = await store.pinGeneration(oldGeneration, "old-reader");
    const oldRows = await oldReader.rows("artifacts");

    await store.putRows("artifacts", [sourceRow(2)]);
    const newGeneration = await store.publish({
      manifestArtifactId,
      revisionId,
      workspaceId,
    });
    const newReader = await store.pinGeneration(newGeneration, "new-reader");
    const newRows = await newReader.rows("artifacts");

    expect(oldGeneration.generationId).not.toBe(newGeneration.generationId);
    expect(oldRows).toHaveLength(1);
    expect(newRows).toHaveLength(2);
    expect(await oldReader.rows("artifacts")).toHaveLength(1);
    await oldReader.close();
    await newReader.close();
    await store.shutdownCoordinator();
  });

  test("serializes publication and index mutations", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const input = {
      manifestArtifactId: createIdentity("revision-manifest", { name: "same" }),
      revisionId: createIdentity("revision", { name: "same" }),
      workspaceId: createIdentity("workspace", { name: "same" }),
    };
    await store.putRows("artifacts", [sourceRow(9)]);
    const [left, right] = await Promise.all([
      store.publish(input),
      store.publish(input),
      store.ensureIndex("artifacts", "artifact_id").then(() => null),
    ]);
    expect(left?.generationId).toBe(right?.generationId);
    const latest = await store.latestGeneration(input.workspaceId);
    expect(latest?.generationId).toBe(left?.generationId);
    await store.shutdownCoordinator();
  });

  test("aborts a long operation when the coordinator loses its epoch", async () => {
    const storage = await domain();
    let reportLeaseLoss!: (error: unknown) => void;
    const leaseLoss = new Promise<unknown>((resolve) => {
      reportLeaseLoss = resolve;
    });
    const store = await LanceIntelligenceStore.open(storage, {
      leaseDurationMs: 1_000,
      onLeaseLost: reportLeaseLoss,
    });
    const entered = deferred<void>();
    const renewed = deferred<void>();
    const originalFence = store.coordinator.fence.bind(store.coordinator);
    const fence = spyOn(store.coordinator, "fence").mockImplementation(
      async (lease) => {
        await originalFence(lease);
        renewed.resolve();
      },
    );
    let finishOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const longOperation = store.serializeMigration(
      "fenced operation",
      async () => {
        entered.resolve();
        await operationGate;
        return "must not publish";
      },
    );
    await entered.promise;
    await time.advanceBy(334);
    await renewed.promise;
    fence.mockRestore();

    const raw = await lancedb.connect(storage.storagePath, {
      readConsistencyInterval: 0,
    });
    const leaseTable = await raw.openTable("coordinator_recovery");
    const stolenOwnerId = `coordinator:v1:${"2".repeat(64)}`;
    await leaseTable.update({
      values: {
        coordinator_id: stolenOwnerId,
        epoch: Number((await store.rows("coordinator_recovery"))[0]?.epoch) + 1,
        heartbeat_at: time.date().toISOString(),
        lease_expires_at: new Date(time.now() + 60_000).toISOString(),
        owner_id: stolenOwnerId,
        state: "active",
      },
      where: "lease_key = 'writer'",
    });
    leaseTable.close();
    raw.close();

    await time.advanceBy(334);
    await expect(leaseLoss).resolves.toMatchObject({
      code: "coordinator_unavailable",
      retryable: true,
    });
    finishOperation();
    await expect(longOperation).rejects.toMatchObject({
      code: "coordinator_unavailable",
      retryable: true,
    });
    await store.shutdownCoordinator();
  });

  test("rejects competing persistent writers and conflicting storage domains", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const raw = await lancedb.connect(storage.storagePath, {
      readConsistencyInterval: 0,
    });
    try {
      expect(() =>
        StorageCoordinator.forStorageDirectory(
          raw,
          "other-domain",
          storage.storagePath,
        ),
      ).toThrow("multiple storage domains");
      const table = await raw.openTable("coordinator_recovery");
      try {
        const rows = await table.query().toArray();
        expect(rows).toHaveLength(1);
        await table.add([{ ...rows[0], owner_id: "competing-writer" }]);
      } finally {
        table.close();
      }
      await expect(
        store.serializeMigration(
          "reject competing leases",
          async () => "must not execute",
        ),
      ).rejects.toMatchObject({
        code: "coordinator_unavailable",
        retryable: true,
      });
      expect(await store.count("coordinator_recovery")).toBe(2);
    } finally {
      raw.close();
      await store.shutdownCoordinator();
    }
  });

  test("uses bounded jittered retry and reports exhaustion", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const value = await withLanceRetry(
      "fixture",
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("commit conflict");
        return 42;
      },
      {
        maxRetryAttempts: 4,
        random: () => 0,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
    );
    expect(value).toBe(42);
    expect(attempts).toBe(3);
    expect(delays).toEqual([5, 10]);

    const malformed = new StorageError(
      "invalid_schema",
      "malformed row",
      false,
    );
    let malformedAttempts = 0;
    await expect(
      withLanceRetry("malformed", async () => {
        malformedAttempts += 1;
        throw malformed;
      }),
    ).rejects.toBe(malformed);
    expect(malformedAttempts).toBe(1);

    let defaultSleepAttempts = 0;
    const recovery = withLanceRetry(
      "default sleep",
      async () => {
        defaultSleepAttempts += 1;
        if (defaultSleepAttempts === 1) throw new Error("commit conflict");
        return "recovered";
      },
      { maxRetryAttempts: 2, random: () => 0 },
    );
    await time.advanceBy(5);
    expect(await recovery).toBe("recovered");
    expect(defaultSleepAttempts).toBe(2);

    await expect(
      withLanceRetry(
        "exhausted",
        async () => {
          throw new Error("transaction conflict");
        },
        {
          maxRetryAttempts: 2,
          random: () => 0,
          sleep: async () => {},
        },
      ),
    ).rejects.toMatchObject({
      code: "retry_exhausted",
      retryable: true,
    } satisfies Partial<StorageError>);
  });
});

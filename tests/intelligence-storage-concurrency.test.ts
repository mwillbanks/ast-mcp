import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { sourceArtifactIdentity as sourceIdentity } from "../src/intelligence/contracts/artifacts.ts";
import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../src/intelligence/contracts/common.ts";
import {
  createStorageDomainId,
  type StorageDomain,
} from "../src/intelligence/contracts/storage.ts";
import {
  clearCoordinatorRegistryForTests,
  LanceIntelligenceStore,
  StorageCoordinator,
  StorageError,
  withLanceRetry,
} from "../src/intelligence/storage/index.ts";

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

async function waitFor(
  predicate: () => Promise<boolean>,
  attempts = 300,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for coordinator state");
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

  test("renews long operations across processes and recovers a stale owner", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage, {
      leaseDurationMs: 1_000,
    });
    const initialLease = (await store.rows("coordinator_recovery"))[0];
    let finishOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const longOperation = store.serializeMigration(
      "long operation",
      async () => {
        await operationGate;
        return "finished";
      },
    );
    await waitFor(async () => {
      const lease = (await store.rows("coordinator_recovery"))[0];
      return (
        Date.parse(String(lease?.lease_expires_at)) >
        Date.parse(String(initialLease?.lease_expires_at))
      );
    });

    const encoded = Buffer.from(JSON.stringify(storage)).toString("base64");
    const modulePath = new URL(
      "../src/intelligence/storage/store.ts",
      import.meta.url,
    ).pathname;
    const script = `
      import { LanceIntelligenceStore } from ${JSON.stringify(modulePath)};
      const domain = JSON.parse(Buffer.from(${JSON.stringify(encoded)}, "base64").toString());
      try {
        const store = await LanceIntelligenceStore.open(domain, { leaseDurationMs: 1_000 });
        await store.putRows("artifacts", []);
        console.log("unexpected-success");
        process.exit(2);
      } catch (error) {
        console.log(error?.code ?? "unknown");
        process.exit(error?.code === "coordinator_unavailable" ? 0 : 3);
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("coordinator_unavailable");
    finishOperation();
    expect(await longOperation).toBe("finished");
    await store.shutdownCoordinator();
    clearCoordinatorRegistryForTests();

    const raw = await lancedb.connect(storage.storagePath, {
      readConsistencyInterval: 0,
    });
    const leaseTable = await raw.openTable("coordinator_recovery");
    const staleOwnerId = `coordinator:v1:${"1".repeat(64)}`;
    await leaseTable.update({
      values: {
        coordinator_id: staleOwnerId,
        epoch: 40,
        heartbeat_at: "2020-01-01T00:00:00.000Z",
        lease_expires_at: "2020-01-01T00:00:00.000Z",
        owner_id: staleOwnerId,
        state: "active",
      },
      where: "lease_key = 'writer'",
    });
    leaseTable.close();
    raw.close();

    const recovered = await LanceIntelligenceStore.open(storage, {
      leaseDurationMs: 60_000,
    });
    await recovered.putRows("artifacts", [sourceRow(77)]);
    const recoveredLease = (await recovered.rows("coordinator_recovery"))[0];
    expect(recoveredLease?.epoch).toBe(41);
    expect(recoveredLease?.owner_id).not.toBe(staleOwnerId);
    expect(await recovered.count("artifacts")).toBe(1);
    await recovered.shutdownCoordinator();
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
    const initialLease = (await store.rows("coordinator_recovery"))[0];
    let finishOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const longOperation = store.serializeMigration(
      "fenced operation",
      async () => {
        await operationGate;
        return "must not publish";
      },
    );
    await waitFor(async () => {
      const lease = (await store.rows("coordinator_recovery"))[0];
      return (
        Date.parse(String(lease?.lease_expires_at)) >
        Date.parse(String(initialLease?.lease_expires_at))
      );
    });

    const raw = await lancedb.connect(storage.storagePath, {
      readConsistencyInterval: 0,
    });
    const leaseTable = await raw.openTable("coordinator_recovery");
    const stolenOwnerId = `coordinator:v1:${"2".repeat(64)}`;
    await leaseTable.update({
      values: {
        coordinator_id: stolenOwnerId,
        epoch: Number((await store.rows("coordinator_recovery"))[0]?.epoch) + 1,
        heartbeat_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        owner_id: stolenOwnerId,
        state: "active",
      },
      where: "lease_key = 'writer'",
    });
    leaseTable.close();
    raw.close();

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
    expect(
      await withLanceRetry(
        "default sleep",
        async () => {
          defaultSleepAttempts += 1;
          if (defaultSleepAttempts === 1) throw new Error("commit conflict");
          return "recovered";
        },
        { maxRetryAttempts: 2, random: () => 0 },
      ),
    ).toBe("recovered");

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

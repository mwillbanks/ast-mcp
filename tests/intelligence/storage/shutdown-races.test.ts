import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  createMockTime,
  deferred,
  type MockTime,
} from "../../support/mock-time.ts";
let time: MockTime;
beforeEach(() => {
  time = createMockTime();
});
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as lancedb from "@lancedb/lancedb";

import {
  createStorageDomainId,
  type StorageDomain,
} from "../../../src/intelligence/contracts/storage.ts";
import {
  LanceIntelligenceStore,
  StorageCoordinator,
} from "../../../src/intelligence/storage/index.ts";
import { snapshotStorageDirectory } from "../../../src/intelligence/storage/relocation.ts";
import { acquireTransactionLock } from "../../../src/runtime/transaction-lock.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
async function fixture() {
  const storagePath = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-shutdown-"),
  );
  const placement = { kind: "explicit" as const, path: storagePath };
  const domain: StorageDomain = {
    domainId: createStorageDomainId({
      engine: "lancedb",
      placement,
      pool: "shared",
      storagePath,
    }),
    engine: "lancedb",
    placement,
    pool: "shared",
    schemaVersion: "ast-mcp.intelligence.v1",
    storagePath,
  };
  const store = await LanceIntelligenceStore.open(domain, {
    leaseDurationMs: 3_000,
  });
  return {
    domain,
    store,
    cleanup: () => rm(storagePath, { recursive: true, force: true }),
  };
}

test("reopening waits for a draining coordinator before acquiring its replacement", async () => {
  const { store, domain, cleanup } = await fixture();
  const entered = gate();
  const finish = gate();
  const operation = store.serializeMigration("held operation", async () => {
    entered.resolve();
    await finish.promise;
  });
  let closing: Promise<void> | undefined;
  let reopening: Promise<LanceIntelligenceStore> | undefined;
  let waitForClosing: ReturnType<typeof spyOn> | undefined;
  try {
    await Promise.race([
      entered.promise,
      operation.then(
        () => {
          throw new Error("Migration callback never entered");
        },
        (error: unknown) => {
          throw error;
        },
      ),
    ]);
    closing = store.shutdownCoordinator();
    // The synchronous factory must never hand out a coordinator marked closing.
    expect(() =>
      StorageCoordinator.forStorageDirectory(
        {} as never,
        domain.domainId,
        domain.storagePath,
      ),
    ).toThrow("closing");
    const waitingForClose = deferred<void>();
    const coordinatorClosing = (
      store.coordinator as unknown as {
        closing: Promise<void>;
      }
    ).closing;
    const originalCatch = coordinatorClosing.catch.bind(coordinatorClosing);
    waitForClosing = spyOn(coordinatorClosing, "catch").mockImplementation(((
      ...args: Parameters<Promise<void>["catch"]>
    ) => {
      const waited = originalCatch(...args);
      waitingForClose.resolve();
      return waited;
    }) as Promise<void>["catch"]);
    let opened = false;
    reopening = LanceIntelligenceStore.open(domain).then((next) => {
      opened = true;
      return next;
    });
    // Observe early failures while retaining the rejection for the assertion path.
    void reopening.catch(() => undefined);
    await Promise.race([
      waitingForClose.promise,
      reopening.then(() => {
        throw new Error("Replacement bypassed the coordinator drain boundary");
      }),
    ]);
    expect(opened).toBe(false);
    finish.resolve();
    await operation;
    await closing;
    const next = await reopening;
    expect(next.coordinator).not.toBe(store.coordinator);
    await next.putRows("artifacts", []);
  } finally {
    finish.resolve();
    await Promise.allSettled([operation, closing]);
    const next = await reopening?.catch(() => undefined);
    waitForClosing?.mockRestore();
    try {
      await Promise.all([
        store.shutdownCoordinator(),
        next?.shutdownCoordinator(),
      ]);
    } finally {
      await cleanup();
    }
  }
});

test("repeated store shutdown cannot release another store's coordinator reference", async () => {
  const { store, domain, cleanup } = await fixture();
  const peer = await LanceIntelligenceStore.open(domain);
  try {
    await Promise.all([
      store.shutdownCoordinator(),
      store.shutdownCoordinator(),
    ]);
    await store.shutdownCoordinator();
    await peer.putRows("artifacts", []);
    expect(await peer.count("artifacts")).toBe(0);
  } finally {
    await peer.shutdownCoordinator();
    await cleanup();
  }
});

test("closing a peer drains its queued write before disposing its connection", async () => {
  const { store, domain, cleanup } = await fixture();
  const peer = await LanceIntelligenceStore.open(domain);
  const entered = gate();
  const finish = gate();
  const held = store.serializeMigration("block peer", async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  const queued = peer.serializeMigration("queued peer write", async () =>
    peer.count("artifacts"),
  );
  let settled = false;
  const closing = peer.shutdownCoordinator().then(() => {
    settled = true;
  });
  expect(settled).toBe(false);
  await expect(peer.putRows("artifacts", [])).rejects.toThrow("closing");
  finish.resolve();
  try {
    await held;
    await queued;
    await closing;
    await store.putRows("artifacts", []);
  } finally {
    finish.resolve();
    await peer.shutdownCoordinator();
    await store.shutdownCoordinator();
    await cleanup();
  }
});

test("failed operations drain their pending heartbeat before settling", async () => {
  const { store, cleanup } = await fixture();
  const heartbeatEntered = gate();
  const heartbeatFinish = gate();
  const failOperation = gate();
  const operationEntered = deferred<void>();
  let heartbeatFinished = false;
  const originalFence = store.coordinator.fence.bind(store.coordinator);
  const fence = spyOn(store.coordinator, "fence").mockImplementation(
    async (lease) => {
      heartbeatEntered.resolve();
      await heartbeatFinish.promise;
      await originalFence(lease);
      heartbeatFinished = true;
    },
  );
  const failure = new Error("operation failed");
  let settled = false;
  const operation = store.serializeMigration("failing operation", async () => {
    operationEntered.resolve();
    await failOperation.promise;
    throw failure;
  });
  const observed = operation.catch((error: unknown) => {
    expect(heartbeatFinished).toBeTrue();
    settled = true;
    return error;
  });
  try {
    await operationEntered.promise;
    await time.advanceBy(1_000);
    await heartbeatEntered.promise;
    failOperation.resolve();
    expect(settled).toBe(false);
    heartbeatFinish.resolve();
    expect(await observed).toBe(failure);
  } finally {
    heartbeatFinish.resolve();
    failOperation.resolve();
    await observed;
    fence.mockRestore();
    await store.shutdownCoordinator();
    await cleanup();
  }
});

describe("Storage coordinator failures", () => {
  async function fixture() {
    const storagePath = await mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-coordinator-failure-"),
    );
    const placement = { kind: "explicit" as const, path: storagePath };
    const domain: StorageDomain = {
      domainId: createStorageDomainId({
        engine: "lancedb",
        placement,
        pool: "shared",
        storagePath,
      }),
      engine: "lancedb",
      placement,
      pool: "shared",
      schemaVersion: "ast-mcp.intelligence.v1",
      storagePath,
    };
    return {
      domain,
      cleanup: () => rm(storagePath, { recursive: true, force: true }),
    };
  }

  test("fresh store bootstrap performs no Lance write before obtaining exclusion", async () => {
    const { domain, cleanup } = await fixture();
    const owner = await acquireTransactionLock(
      path.join(domain.storagePath, ".different-account-private-writer"),
      {
        sharedDatabasePath: path.join(
          domain.storagePath,
          ".ast-mcp-storage-writer.sqlite",
        ),
      },
    );
    const connection = await lancedb.connect(domain.storagePath);
    try {
      await expect(LanceIntelligenceStore.open(domain)).rejects.toMatchObject({
        code: "coordinator_unavailable",
      });
      expect(await connection.tableNames()).toEqual([]);
      expect(await snapshotStorageDirectory(domain.storagePath)).toEqual([]);
      owner.release();
      const store = await LanceIntelligenceStore.open(domain);
      await store.shutdownCoordinator();
    } finally {
      owner.release();
      connection.close();
      await cleanup();
    }
  });

  test("competing persistent lease rows fail closed and remain recoverable after repair", async () => {
    const { domain, cleanup } = await fixture();
    const store = await LanceIntelligenceStore.open(domain);
    const connection = await lancedb.connect(domain.storagePath, {
      readConsistencyInterval: 0,
    });
    const table = await connection.openTable("coordinator_recovery");
    try {
      const original = (await table.query().toArray())[0]!;
      await table.add([
        {
          ...original,
          epoch: Number(original.epoch),
          owner_id: "duplicate-owner",
        },
      ]);
      await expect(store.putRows("artifacts", [])).rejects.toThrow(
        "competing writer rows",
      );
      await table.delete("owner_id = 'duplicate-owner'");
      await store.putRows("artifacts", []);
    } finally {
      table.close();
      connection.close();
      await store.shutdownCoordinator();
      await cleanup();
    }
  });

  test("coordinator table failures close their native handle before reporting the error", async () => {
    const { domain, cleanup } = await fixture();
    const store = await LanceIntelligenceStore.open(domain);
    const connection = (
      store.coordinator as unknown as { connection: lancedb.Connection }
    ).connection;
    const table = await connection.openTable("coordinator_recovery");
    const failure = new Error("lease schema unavailable");
    const schema = spyOn(table, "schema").mockRejectedValueOnce(failure);
    const close = spyOn(table, "close");
    const open = spyOn(connection, "openTable").mockResolvedValueOnce(table);
    try {
      await expect(store.putRows("artifacts", [])).rejects.toBe(failure);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      schema.mockRestore();
      close.mockRestore();
      await store.shutdownCoordinator();
      await cleanup();
    }
  });

  test("openers replace a coordinator even when its closing promise rejects", async () => {
    const { domain, cleanup } = await fixture();
    const store = await LanceIntelligenceStore.open(domain);
    const connection = (
      store.coordinator as unknown as { connection: lancedb.Connection }
    ).connection;
    const replacement = await lancedb.connect(domain.storagePath);
    const failure = new Error("old coordinator close failed");
    const open = spyOn(connection, "openTable").mockRejectedValueOnce(failure);
    let next: StorageCoordinator | undefined;
    try {
      const closing = store.shutdownCoordinator();
      const opening = StorageCoordinator.acquireForStorageDirectory(
        replacement,
        domain.domainId,
        domain.storagePath,
      );
      await expect(closing).rejects.toBe(failure);
      next = await opening;
      expect(next).not.toBe(store.coordinator);
    } finally {
      open.mockRestore();
      await next?.release();
      if (!next) replacement.close();
      await store.shutdownCoordinator().catch(() => undefined);
      await cleanup();
    }
  });
});

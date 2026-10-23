import { expect, spyOn, test } from "bun:test";
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

test("coordinator close waits for a peer process writer before releasing its lease", async () => {
  const { store, domain, cleanup } = await fixture();
  const modulePath = Bun.fileURLToPath(
    new URL("../../../src/runtime/transaction-lock.ts", import.meta.url),
  );
  const identity = path.join(domain.storagePath, ".ast-mcp-storage-writer");
  const connection = await lancedb.connect(domain.storagePath, {
    readConsistencyInterval: 0,
  });
  const table = await connection.openTable("coordinator_recovery");
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { acquireTransactionLock } from ${JSON.stringify(modulePath)};
    const owner = await acquireTransactionLock(${JSON.stringify(identity)});
    console.log("ready");
    await new Promise(resolve => process.stdin.once("data", resolve));
    owner.release();
  `,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  let closing: Promise<void> | undefined;
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value).trim()).toBe("ready");
    await table.checkoutLatest();
    const before = (await table.query().toArray())[0];
    let settled = false;
    closing = store.shutdownCoordinator().then(() => {
      settled = true;
    });
    await Bun.sleep(30);
    expect(settled).toBe(false);
    await expect(
      store.coordinator.exclusive("late write", async () => undefined),
    ).rejects.toThrow("closing");
    await table.checkoutLatest();
    const during = (await table.query().toArray())[0];
    expect(during?.lease_expires_at).toBe(before?.lease_expires_at);
    child.stdin.write("release\n");
    child.stdin.end();
    expect(await child.exited).toBe(0);
    await closing;
    await table.checkoutLatest();
    const after = (await table.query().toArray())[0];
    expect(after?.state).toBe("clean");
    expect(Date.parse(String(after?.lease_expires_at))).toBeLessThan(
      Date.parse(String(before?.lease_expires_at)),
    );
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
    await closing;
    table.close();
    connection.close();
    await store.shutdownCoordinator();
    await cleanup();
  }
});

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
    let opened = false;
    reopening = LanceIntelligenceStore.open(domain).then((next) => {
      opened = true;
      return next;
    });
    // Observe early failures while retaining the rejection for the assertion path.
    void reopening.catch(() => undefined);
    await Bun.sleep(20);
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
  await Bun.sleep(10);
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
  const originalFence = store.coordinator.fence.bind(store.coordinator);
  const fence = spyOn(store.coordinator, "fence").mockImplementation(
    async (lease) => {
      heartbeatEntered.resolve();
      await heartbeatFinish.promise;
      await originalFence(lease);
    },
  );
  const failure = new Error("operation failed");
  let settled = false;
  const operation = store.serializeMigration("failing operation", async () => {
    await failOperation.promise;
    throw failure;
  });
  const observed = operation.catch((error: unknown) => {
    settled = true;
    return error;
  });
  try {
    await heartbeatEntered.promise;
    failOperation.resolve();
    await Bun.sleep(20);
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

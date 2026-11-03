import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path, { join } from "node:path";

import * as lancedb from "@lancedb/lancedb";

import { sourceArtifactIdentity as sourceIdentity } from "../../src/intelligence/contracts/artifacts.ts";
import { INTELLIGENCE_SCHEMA_VERSION } from "../../src/intelligence/contracts/common.ts";
import {
  createStorageDomainId,
  type StorageDomain,
} from "../../src/intelligence/contracts/storage.ts";
import {
  LanceIntelligenceStore,
  clearCoordinatorRegistryForTests,
} from "../../src/intelligence/storage/index.ts";
import { deferred } from "../support/mock-time.ts";
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
    new URL("../../src/runtime/transaction-lock.ts", import.meta.url),
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
    const owner = await acquireTransactionLock(${JSON.stringify(identity + "-different-private-account")}, {sharedDatabasePath: ${JSON.stringify(path.join(domain.storagePath, ".ast-mcp-storage-writer.sqlite"))}});
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
  const renewed = deferred<void>();
  const originalFence = store.coordinator.fence.bind(store.coordinator);
  const fence = spyOn(store.coordinator, "fence").mockImplementation(
    async (lease) => {
      await originalFence(lease);
      renewed.resolve();
    },
  );
  const longOperation = store.serializeMigration("long operation", async () => {
    await operationGate;
    return "finished";
  });
  await renewed.promise;
  fence.mockRestore();
  expect(
    Date.parse(
      String((await store.rows("coordinator_recovery"))[0]?.lease_expires_at),
    ),
  ).toBeGreaterThan(Date.parse(String(initialLease?.lease_expires_at)));

  const encoded = Buffer.from(JSON.stringify(storage)).toString("base64");
  const modulePath = Bun.fileURLToPath(
    new URL("../../src/intelligence/storage/store.ts", import.meta.url),
  );
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

test("expired writer metadata cannot admit a second process during an active operation", async () => {
  const storagePath = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-expired-storage-"),
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
    leaseDurationMs: 60_000,
  });
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const operation = store.serializeMigration(
    "paused native operation",
    async () => {
      enter();
      await gate;
    },
  );
  const observed = operation.catch((error: unknown) => error);
  await entered;
  try {
    const connection = await lancedb.connect(storagePath, {
      readConsistencyInterval: 0,
    });
    const table = await connection.openTable("coordinator_recovery");
    try {
      // Simulate a paused owner whose lease deadline passed without allowing its
      // already-started native operation to finish.
      await table.update({
        values: { lease_expires_at: "2020-01-01T00:00:00.000Z" },
        where: "lease_key = 'writer'",
      });
    } finally {
      table.close();
      connection.close();
    }
    const modulePath = Bun.fileURLToPath(
      new URL("../../src/intelligence/storage/store.ts", import.meta.url),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import { LanceIntelligenceStore } from ${JSON.stringify(modulePath)};
      try {
        const store = await LanceIntelligenceStore.open(${JSON.stringify(domain)});
        await store.shutdownCoordinator();
        process.exit(2);
      } catch (error) {
        console.log(error.code);
        process.exit(error.code === "coordinator_unavailable" ? 0 : 3);
      }
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("coordinator_unavailable");
    expect(code).toBe(0);
  } finally {
    finish();
    await expect(observed).resolves.toMatchObject({
      code: "coordinator_unavailable",
    });
    await store.shutdownCoordinator();
    await rm(storagePath, { recursive: true, force: true });
  }
});

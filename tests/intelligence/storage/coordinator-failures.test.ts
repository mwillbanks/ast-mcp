import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as lancedb from "@lancedb/lancedb";

import {
  createStorageDomainId,
  type StorageDomain,
} from "../../../src/intelligence/contracts/storage.ts";
import { LanceIntelligenceStore } from "../../../src/intelligence/storage/store.ts";
import { acquireTransactionLock } from "../../../src/runtime/transaction-lock.ts";

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
    path.join(domain.storagePath, ".ast-mcp-storage-writer"),
  );
  const connection = await lancedb.connect(domain.storagePath);
  try {
    await expect(LanceIntelligenceStore.open(domain)).rejects.toMatchObject({
      code: "coordinator_unavailable",
    });
    expect(await connection.tableNames()).toEqual([]);
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

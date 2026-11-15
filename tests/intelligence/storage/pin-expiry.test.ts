import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createMockTime, deferred } from "../../support/mock-time.ts";
beforeEach(() => {
  createMockTime();
});
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Connection } from "@lancedb/lancedb";

import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../../../src/intelligence/contracts/common.ts";
import {
  createStorageDomainId,
  type StorageDomain,
} from "../../../src/intelligence/contracts/storage.ts";
import {
  LanceIntelligenceStore,
  ReaderPinExpiredError,
} from "../../../src/intelligence/storage/index.ts";

async function domain(): Promise<StorageDomain> {
  const storagePath = await mkdtemp(join(tmpdir(), "ast-mcp-pin-expiry-"));
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

async function published(store: LanceIntelligenceStore) {
  return store.publish({
    manifestArtifactId: createIdentity("revision-manifest", {
      name: "pin-expiry",
    }),
    revisionId: createIdentity("revision", { name: "pin-expiry" }),
    workspaceId: createIdentity("workspace", { name: "pin-expiry" }),
  });
}

describe("reader pin expiration", () => {
  test.each(["open-error", "expiry"] as const)(
    "releases pinned tables after the outstanding open settles (%s)",
    async (mode) => {
      const storage = await domain();
      let now = Date.parse("2026-09-10T00:00:00.000Z");
      const store = await LanceIntelligenceStore.open(storage, {
        now: () => new Date(now),
      });
      const publication = await published(store);
      const [first, second] = publication.tableVersions;
      const connection = (store as unknown as { connection: Connection })
        .connection;
      const openTable = connection.openTable.bind(connection);
      const table = await openTable(second!.table);
      const close = spyOn(table, "close");
      const entered = deferred();
      const continueOpen = deferred();
      const failure = new Error("pinned table open failed");
      const open = spyOn(connection, "openTable").mockImplementation(
        async (...args) => {
          if (args[0] === first!.table && mode === "open-error") throw failure;
          if (args[0] !== second!.table) return openTable(...args);
          entered.resolve();
          await continueOpen.promise;
          return table;
        },
      );
      const pending = store.pinGeneration(publication, "open-race", 1000);
      void pending.catch(() => {});
      try {
        await entered.promise;
        expect(await store.count("reader_pins")).toBe(1);
        expect(close).not.toHaveBeenCalled();
        if (mode === "expiry") now += 1000;
        continueOpen.resolve();
        if (mode === "open-error") await expect(pending).rejects.toBe(failure);
        else
          await expect(pending).rejects.toBeInstanceOf(ReaderPinExpiredError);
        expect(close).toHaveBeenCalledTimes(1);
        expect(await store.count("reader_pins")).toBe(0);
      } finally {
        continueOpen.resolve();
        await pending.then(
          (reader) => reader.close(),
          () => {},
        );
        open.mockRestore();
        close.mockRestore();
        await store.shutdownCoordinator();
        await rm(storage.storagePath, { force: true, recursive: true });
      }
    },
  );

  test("expires at the exact boundary and rejects every later read", async () => {
    const storage = await domain();
    let now = Date.parse("2026-09-10T00:00:00.000Z");
    const store = await LanceIntelligenceStore.open(storage, {
      now: () => new Date(now),
    });
    const reader = await store.pinGeneration(
      await published(store),
      "boundary",
      1_000,
    );
    expect(await reader.rows("artifacts")).toEqual([]);

    now = Date.parse(reader.pin.expiresAt);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(reader.rows("artifacts")).rejects.toBeInstanceOf(
        ReaderPinExpiredError,
      );
    }
    expect(await store.count("reader_pins")).toBe(0);
    await reader.close();
    await reader.close();
    await store.shutdownCoordinator();
  });

  test("releases an expired pin during retention and remains released after restart", async () => {
    const storage = await domain();
    let now = Date.parse("2026-09-10T00:00:00.000Z");
    const store = await LanceIntelligenceStore.open(storage, {
      now: () => new Date(now),
    });
    const reader = await store.pinGeneration(
      await published(store),
      "retention",
      1_000,
    );
    now += 1_001;

    const [readResult, retentionResult] = await Promise.allSettled([
      reader.rows("artifacts"),
      store.collect({ now: new Date(now) }),
    ]);
    expect(readResult.status).toBe("rejected");
    if (readResult.status === "rejected") {
      expect(readResult.reason).toBeInstanceOf(ReaderPinExpiredError);
    }
    expect(retentionResult.status).toBe("fulfilled");
    expect(await store.count("reader_pins")).toBe(0);
    await reader.close();
    await store.shutdownCoordinator();

    const reopened = await LanceIntelligenceStore.open(storage, {
      now: () => new Date(now),
    });
    expect(await reopened.count("reader_pins")).toBe(0);
    await reopened.shutdownCoordinator();
  });

  test("releases a pin when close races with expiration", async () => {
    const storage = await domain();
    let now = Date.parse("2026-09-10T00:00:00.000Z");
    const store = await LanceIntelligenceStore.open(storage, {
      now: () => new Date(now),
    });
    const reader = await store.pinGeneration(
      await published(store),
      "close",
      1_000,
    );
    now += 1_000;
    await Promise.all([reader.close(), reader.close()]);
    expect(await store.count("reader_pins")).toBe(0);
    await store.shutdownCoordinator();
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../src/intelligence/contracts/common.ts";
import {
  createStorageDomainId,
  type StorageDomain,
} from "../src/intelligence/contracts/storage.ts";
import {
  LanceIntelligenceStore,
  ReaderPinExpiredError,
} from "../src/intelligence/storage/index.ts";

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

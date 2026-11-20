import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStorageDomainId,
  type StorageDomain,
} from "../../../src/intelligence/contracts/storage.ts";
import { deferred } from "../../support/mock-time.ts";
import { StorageClock } from "./clock.ts";
import { StorageFixture } from "./fixture.ts";

test("a native storage heartbeat and shutdown use the fixture scheduler without ambient timers", async () => {
  await using fixtures = new StorageFixture();
  const ambient = fixtures.spyOn(globalThis, "setInterval");
  const clock = new StorageClock();
  const storagePath = await fixtures.directory(
    join(tmpdir(), "ast-mcp-heartbeat-owner-"),
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
  const options = {
    leaseDurationMs: 3000,
    now: clock.date,
    scheduleHeartbeat: clock.scheduleHeartbeat,
  };
  const store = await fixtures.open(domain, options);
  expect((await store.rows("retention"))[0]?.updated_at).toBe(
    clock.date().toISOString(),
  );
  await store.recover();
  expect((await store.rows("coordinator_recovery"))[0]?.state).toBe(
    "recovered",
  );
  const entered = deferred();
  const finishAction = deferred();
  const fenceEntered = deferred();
  const finishFence = deferred();
  const originalFence = store.coordinator.fence.bind(store.coordinator);
  fixtures
    .spyOn(store.coordinator, "fence")
    .mockImplementation(async (lease) => {
      fenceEntered.resolve();
      await finishFence.promise;
      await originalFence(lease);
    });
  const operation = store.serializeMigration("owned heartbeat", async () => {
    entered.resolve();
    await finishAction.promise;
    return "finished";
  });
  let closing: Promise<void> | undefined;
  let closed = false;
  try {
    await entered.promise;
    expect(clock.pending()).toBe(1);
    expect(ambient).not.toHaveBeenCalled();
    clock.advanceBy(1000);
    await fenceEntered.promise;
    closing = store.shutdownCoordinator().then(() => {
      closed = true;
    });
    expect(closed).toBeFalse();
    finishAction.resolve();
    expect(closed).toBeFalse();
    finishFence.resolve();
    expect(await operation).toBe("finished");
    await closing;
    expect(closed).toBeTrue();
    clock.assertDrained();
    expect(ambient).not.toHaveBeenCalled();
  } finally {
    finishAction.resolve();
    finishFence.resolve();
    await Promise.allSettled([operation, closing]);
  }
});

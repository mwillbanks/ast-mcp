import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deferred } from "../../support/mock-time.ts";
import { StorageFixture } from "./fixture.ts";

test("storage fixture failure drains owners before deleting their directory", async () => {
  const fixtures = new StorageFixture();
  const directory = await fixtures.directory(
    join(tmpdir(), "ast-mcp-owned-storage-"),
  );
  const shutdownEntered = deferred();
  const finishShutdown = deferred();
  const order: string[] = [];
  fixtures.store({
    async shutdownCoordinator() {
      order.push("shutdown entered");
      shutdownEntered.resolve();
      await finishShutdown.promise;
      order.push("shutdown finished");
    },
  });
  fixtures.close({
    close() {
      order.push("reader closed");
    },
  });
  const object = { value: () => "original" };
  fixtures.spyOn(object, "value").mockReturnValue("mocked");
  const failure = new Error("fixture assertion failed");
  const failed = (async () => {
    await using owned = fixtures;
    throw failure;
  })();
  void failed.catch(() => {});
  try {
    await Promise.race([
      shutdownEntered.promise,
      failed.then(
        () => {
          throw new Error("Fixture failure did not propagate");
        },
        () => {
          throw new Error("Fixture failure bypassed owner shutdown");
        },
      ),
    ]);
    expect(object.value()).toBe("original");
    expect(order).toEqual(["reader closed", "shutdown entered"]);
    expect((await stat(directory)).isDirectory()).toBeTrue();
    finishShutdown.resolve();
    await expect(failed).rejects.toBe(failure);
    expect(order).toEqual([
      "reader closed",
      "shutdown entered",
      "shutdown finished",
    ]);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await fixtures[Symbol.asyncDispose]();
    expect(order).toHaveLength(3);
  } finally {
    finishShutdown.resolve();
    await failed.catch(() => {});
    await fixtures[Symbol.asyncDispose]();
  }
});

test("storage fixture cleanup attempts every owner when one close fails", async () => {
  const fixtures = new StorageFixture();
  const closed: string[] = [];
  const failure = new Error("reader close failed");
  fixtures.store({
    async shutdownCoordinator() {
      closed.push("store");
    },
  });
  fixtures.close({
    close() {
      closed.push("reader");
      throw failure;
    },
  });
  const disposed = fixtures[Symbol.asyncDispose]();
  await expect(disposed).rejects.toMatchObject({ errors: [failure] });
  expect(closed).toEqual(["reader", "store"]);
});

test("storage fixture restores spies before release and skips closed native handles", async () => {
  const fixtures = new StorageFixture();
  const released: string[] = [];
  const live = {
    close() {
      released.push("live");
    },
  };
  fixtures.spyOn(live, "close").mockImplementation(() => {
    released.push("mocked");
  });
  fixtures.close(live);
  fixtures.close({
    isOpen: () => false,
    close() {
      throw new Error("Closed native handle was released twice");
    },
  });
  await fixtures[Symbol.asyncDispose]();
  expect(released).toEqual(["live"]);
});

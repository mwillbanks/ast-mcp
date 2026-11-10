import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  markRefreshPending,
  markRefreshPublished,
  type PendingRefreshState,
  readRefreshState,
  scheduleMutationRefresh,
} from "../../src/intelligence/mutation/experimental-deferred-refresh.ts";
import {
  ensurePrivateLockDirectory,
  systemAccount,
} from "../../src/runtime/private-lock-directory.ts";
import {
  createMockTime,
  deferred,
  flushMicrotasks,
  MOCK_EPOCH,
} from "../support/mock-time.ts";

const scope = "a".repeat(64);
const otherScope = "b".repeat(64);
const storageScope = "d".repeat(64);
const otherStorageScope = "e".repeat(64);
const generation = "generation:v1:" + "c".repeat(64);

async function markerFixture() {
  const directory = await ensurePrivateLockDirectory(await systemAccount());
  const transactionPath = path.join(
    directory,
    "transaction-" + randomBytes(32).toString("hex"),
  );
  const file = transactionPath + ".refresh.json";
  return {
    transactionPath,
    file,
    async close() {
      await rm(file, { force: true });
      await rm(file + ".tmp", { force: true });
    },
  };
}

test("deferred refresh marker persists a path union and fences superseded epochs", async () => {
  const fixture = await markerFixture();
  const clock = createMockTime();
  const { transactionPath } = fixture;
  try {
    expect(await readRefreshState(transactionPath)).toBeNull();
    const first = await markRefreshPending(
      transactionPath,
      ["src/b.ts"],
      scope,
      storageScope,
    );
    expect(await readRefreshState(transactionPath)).toEqual(first);

    await clock.advanceBy(50);
    const next = await markRefreshPending(
      transactionPath,
      ["src/b.ts", "src/a.ts"],
      scope,
      storageScope,
    );
    expect(next).toMatchObject({
      firstDirtyAt: MOCK_EPOCH,
      lastDirtyAt: MOCK_EPOCH + 50,
      paths: ["src/a.ts", "src/b.ts"],
    });
    expect(next.epoch).not.toBe(first.epoch);
    await expect(
      markRefreshPublished(transactionPath, first.epoch, generation),
    ).rejects.toMatchObject({ code: "mutation_refresh_marker_stale" });
    expect(await readRefreshState(transactionPath)).toEqual(next);

    await markRefreshPublished(transactionPath, next.epoch, generation);
    const clean = await readRefreshState(transactionPath);
    expect(clean).toMatchObject({
      kind: "clean",
      publishedGenerationId: generation,
      scope,
      storageScope,
    });
    expect(clean?.epoch).not.toBe(next.epoch);
    if (process.platform !== "win32")
      expect((await lstat(fixture.file)).mode & 0o777).toBe(0o600);
    await expect(lstat(fixture.file + ".tmp")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await fixture.close();
    clock.dispose();
  }
});

test("deferred refresh retains the first dirty time and widens on path overflow or a scope change", async () => {
  const fixture = await markerFixture();
  const clock = createMockTime();
  const { transactionPath } = fixture;
  try {
    const first = await markRefreshPending(
      transactionPath,
      Array.from({ length: 256 }, (_, index) => "src/file-" + index + ".ts"),
      scope,
      storageScope,
    );
    expect(first.paths).toHaveLength(256);
    await clock.advanceBy(25);
    const overflow = await markRefreshPending(
      transactionPath,
      ["extra.ts"],
      scope,
      storageScope,
    );
    expect(overflow.paths).toBeNull();
    expect(overflow.firstDirtyAt).toBe(MOCK_EPOCH);
    await markRefreshPublished(transactionPath, overflow.epoch, generation);

    const fresh = await markRefreshPending(
      transactionPath,
      ["src/new.ts"],
      scope,
      storageScope,
    );
    expect(fresh.paths).toEqual(["src/new.ts"]);
    expect(fresh.firstDirtyAt).toBe(MOCK_EPOCH + 25);
    expect(fresh.publishedGenerationId).toBe(generation);
    const changed = await markRefreshPending(
      transactionPath,
      ["src/other.ts"],
      otherScope,
      storageScope,
    );
    expect(changed).toMatchObject({
      firstDirtyAt: fresh.firstDirtyAt,
      paths: null,
      scope: otherScope,
      storageScope,
    });
    expect(changed.publishedGenerationId).toBeUndefined();
    expect(await readRefreshState(transactionPath)).toEqual(changed);
    await markRefreshPublished(transactionPath, changed.epoch, generation);

    await markRefreshPending(
      transactionPath,
      ["src/a.ts"],
      otherScope,
      storageScope,
    );
    const moved = await markRefreshPending(
      transactionPath,
      ["src/b.ts"],
      otherScope,
      otherStorageScope,
    );
    expect(moved).toMatchObject({
      scope: otherScope,
      paths: null,
      storageScope: otherStorageScope,
    });
  } finally {
    await fixture.close();
    clock.dispose();
  }
});

test("deferred refresh refuses to treat a malformed or oversized marker as clean", async () => {
  const fixture = await markerFixture();
  try {
    await writeFile(fixture.file, "not a marker", { flag: "wx", mode: 0o600 });
    await expect(
      readRefreshState(fixture.transactionPath),
    ).rejects.toMatchObject({
      code: "mutation_refresh_marker_malformed",
    });
    await expect(
      markRefreshPending(
        fixture.transactionPath,
        ["src/a.ts"],
        scope,
        storageScope,
      ),
    ).rejects.toMatchObject({ code: "mutation_refresh_marker_malformed" });
    await writeFile(fixture.file, "a".repeat(65537));
    await expect(
      readRefreshState(fixture.transactionPath),
    ).rejects.toMatchObject({
      code: "mutation_refresh_marker_unsafe",
    });
  } finally {
    await fixture.close();
  }
});

function pending(offset: number): PendingRefreshState {
  return {
    kind: "pending",
    epoch: randomUUID(),
    firstDirtyAt: MOCK_EPOCH,
    lastDirtyAt: MOCK_EPOCH + offset,
    paths: ["src/a.ts"],
    scope,
    storageScope,
  };
}

test("deferred refresh debounces per checkout and dispatches at the burst ceiling", async () => {
  const clock = createMockTime();
  const key = randomUUID();
  const calls: PendingRefreshState[] = [];
  const run = async (state: PendingRefreshState) => {
    calls.push(state);
  };
  try {
    scheduleMutationRefresh(key, pending(0), run);
    for (const offset of [70, 140, 210]) {
      await clock.advanceBy(70);
      expect(calls).toHaveLength(0);
      const next = pending(offset);
      scheduleMutationRefresh(key, next, run);
      scheduleMutationRefresh(key, next, run);
      expect(clock.pending()).toBe(1);
    }
    await clock.advanceBy(39);
    expect(calls).toHaveLength(0);
    await clock.advanceBy(1);
    expect(calls.map((state) => state.lastDirtyAt)).toEqual([MOCK_EPOCH + 210]);
    expect(clock.pending()).toBe(0);
  } finally {
    clock.dispose();
  }
});

test("deferred refresh retains the newest work that arrives during publication", async () => {
  const clock = createMockTime();
  const key = randomUUID();
  const gate = deferred();
  const calls: string[] = [];
  try {
    scheduleMutationRefresh(key, pending(0), async () => {
      calls.push("entered");
      await gate.promise;
      calls.push("finished");
    });
    await clock.advanceBy(74);
    expect(calls).toEqual([]);
    await clock.advanceBy(1);
    expect(calls).toEqual(["entered"]);
    scheduleMutationRefresh(key, pending(75), async () => {
      calls.push("superseded");
    });
    await clock.advanceBy(20);
    scheduleMutationRefresh(key, pending(95), async () => {
      calls.push("latest");
    });
    await clock.advanceBy(100);
    expect(calls).toEqual(["entered"]);
    expect(clock.pending()).toBe(0);

    gate.resolve();
    await flushMicrotasks();
    await clock.runNext();
    expect(calls).toEqual(["entered", "finished", "latest"]);
    expect(clock.pending()).toBe(0);
  } finally {
    gate.resolve();
    await flushMicrotasks();
    clock.dispose();
  }
});

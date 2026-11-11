import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  markRefreshPending,
  markRefreshPublished,
  markRefreshReady,
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

test("deferred refresh refuses wrong marker identities and protects in-flight writes", async () => {
  const fixture = await markerFixture();
  const clock = createMockTime();
  const { transactionPath } = fixture;
  try {
    await expect(
      readRefreshState(transactionPath + ".other"),
    ).rejects.toMatchObject({
      code: "mutation_refresh_marker_scope_invalid",
    });
    await expect(
      markRefreshPending(
        transactionPath,
        ["src/a.ts"],
        "invalid",
        storageScope,
      ),
    ).rejects.toMatchObject({ code: "mutation_refresh_marker_scope_invalid" });
    await expect(
      markRefreshPending(transactionPath, [], scope, storageScope, {
        publishedGenerationId: "invalid",
      }),
    ).rejects.toMatchObject({ code: "mutation_refresh_generation_invalid" });
    const pending = await markRefreshPending(
      transactionPath,
      ["../elsewhere.ts"],
      scope,
      storageScope,
      {
        indexRefresh: false,
        inFlight: true,
        journal: "sqlite-v1",
      },
    );
    expect(pending.paths).toBeNull();
    await expect(
      markRefreshReady(transactionPath, randomUUID()),
    ).rejects.toMatchObject({ code: "mutation_refresh_marker_stale" });
    await expect(
      markRefreshPublished(transactionPath, pending.epoch, generation),
    ).rejects.toMatchObject({ code: "mutation_refresh_marker_stale" });
    await clock.advanceBy(1);
    const ready = await markRefreshReady(transactionPath, pending.epoch);
    expect(ready).toMatchObject({
      inFlight: false,
      lastDirtyAt: MOCK_EPOCH + 1,
    });
    await expect(
      markRefreshPublished(transactionPath, ready.epoch, "invalid"),
    ).rejects.toMatchObject({ code: "mutation_refresh_generation_invalid" });
    await markRefreshPublished(transactionPath, ready.epoch, generation);
    expect(await readRefreshState(transactionPath)).toMatchObject({
      kind: "clean",
      journal: "sqlite-v1",
      publishedGenerationId: generation,
    });
  } finally {
    await fixture.close();
    clock.dispose();
  }
});

test("deferred refresh widens oversized encoded path sets and leaves the old marker after a write error", async () => {
  const fixture = await markerFixture();
  try {
    const state = await markRefreshPending(
      fixture.transactionPath,
      Array.from(
        { length: 256 },
        (_, index) => `src/${index}-${"a".repeat(256)}.ts`,
      ),
      scope,
      storageScope,
    );
    expect(state.paths).toBeNull();
    await mkdir(fixture.file + ".tmp");
    try {
      await expect(
        markRefreshReady(fixture.transactionPath, state.epoch),
      ).rejects.toThrow();
      expect(await readRefreshState(fixture.transactionPath)).toEqual(state);
    } finally {
      await rm(fixture.file + ".tmp", { recursive: true });
    }
    if (process.platform !== "win32") {
      await rm(fixture.file);
      await symlink(fixture.file + ".tmp", fixture.file);
      await expect(
        readRefreshState(fixture.transactionPath),
      ).rejects.toMatchObject({
        code: "mutation_refresh_marker_unreadable",
      });
    }
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

test("deferred refresh retries a busy claim with backoff and frees failed queue slots", async () => {
  const clock = createMockTime();
  const key = randomUUID();
  const calls: string[] = [];
  try {
    const state = pending(0);
    scheduleMutationRefresh(key, state, async () => {
      calls.push("first");
      return calls.length === 1 ? "retry" : undefined;
    });
    await clock.advanceBy(75);
    await clock.advanceBy(249);
    expect(calls).toEqual(["first"]);
    await clock.advanceBy(1);
    expect(calls).toEqual(["first", "first"]);

    const keys = Array.from({ length: 32 }, () => randomUUID());
    for (const [index, queued] of keys.entries()) {
      scheduleMutationRefresh(queued, state, async () => {
        calls.push("queued");
        if (index === 0) throw new Error("failed refresh");
      });
    }
    scheduleMutationRefresh(key, state, async () => {
      calls.push("dropped");
    });
    expect(clock.pending()).toBe(32);
    await clock.advanceBy(0);
    expect(calls.filter((call) => call === "queued")).toHaveLength(32);
    expect(calls).not.toContain("dropped");
    scheduleMutationRefresh(key, state, async () => {
      calls.push("recovered");
    });
    await clock.advanceBy(0);
    expect(calls.at(-1)).toBe("recovered");
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

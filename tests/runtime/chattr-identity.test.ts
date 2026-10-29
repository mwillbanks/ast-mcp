import { expect, spyOn, test } from "bun:test";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { chmod, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyFileChattr,
  readFileChattrSnapshot,
  FileChattrSnapshots,
} from "../../src/runtime/attributes";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ast-chattr-identity-"));
  const path = join(root, "source.txt");
  await writeFile(path, "source");
  await chmod(path, 0o644);
  return { root, path };
}

test("guarded attributes reject identical-content inode replacements before application", async () => {
  const { root, path } = await fixture();
  try {
    await using snapshots = new FileChattrSnapshots();
    const snapshot = await readFileChattrSnapshot(path);
    snapshots.set(path, snapshot);
    await rename(path, join(root, "original.txt"));
    await writeFile(path, "source");
    await chmod(path, 0o644);
    await expect(
      applyFileChattr(path, { chmod: 0o600 }, undefined, snapshot),
    ).rejects.toMatchObject({
      code: "stale_or_missing_hash",
    });
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o644);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replacement during fencing never receives metadata changes", async () => {
  const { root, path } = await fixture();
  try {
    await using snapshots = new FileChattrSnapshots();
    const snapshot = await readFileChattrSnapshot(path);
    snapshots.set(path, snapshot);
    await expect(
      applyFileChattr(
        path,
        { chmod: 0o600 },
        async () => {
          await rename(path, join(root, "original.txt"));
          await writeFile(path, "replacement");
          await chmod(path, 0o644);
        },
        snapshot,
      ),
    ).rejects.toMatchObject({ code: "stale_or_missing_hash" });
    expect(await Bun.file(path).text()).toBe("replacement");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o644);
      expect((await stat(join(root, "original.txt"))).mode & 0o777).toBe(0o644);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default abort during fencing prevents guarded chmod", async () => {
  const { root, path } = await fixture();
  const controller = new AbortController();
  try {
    await using snapshots = new FileChattrSnapshots();
    const snapshot = await readFileChattrSnapshot(path);
    snapshots.set(path, snapshot);
    await expect(
      applyFileChattr(
        path,
        { chmod: 0o600 },
        async () => {
          controller.abort();
        },
        { ...snapshot, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o644);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guarded attribute rollback preserves concurrent content and metadata", async () => {
  if (
    process.platform === "win32" ||
    process.getuid?.() === undefined ||
    process.getgid?.() === undefined
  )
    return;
  const { root, path } = await fixture();
  try {
    await using snapshots = new FileChattrSnapshots();
    const snapshot = await readFileChattrSnapshot(path);
    snapshots.set(path, snapshot);
    let calls = 0;
    await expect(
      applyFileChattr(
        path,
        {
          chown: { uid: process.getuid!(), gid: process.getgid!() },
          chmod: 0o600,
        },
        async () => {
          if (++calls === 2) {
            await writeFile(path, "concurrent");
            await chmod(path, 0o640);
          }
        },
        snapshot,
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(await Bun.file(path).text()).toBe("concurrent");
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
for (const initiallyReadonly of [true, false]) {
  test(`attribute durability retains descriptors through both rollback directions, initially readonly=${initiallyReadonly}`, async () => {
    const { root, path } = await fixture();
    const snapshots = new FileChattrSnapshots();
    try {
      await chmod(path, initiallyReadonly ? 0o444 : 0o644);
      const snapshot = await readFileChattrSnapshot(path);
      snapshots.set(path, snapshot);
      const before = (await stat(path)).mode & 0o777;
      if (initiallyReadonly) {
        // Emulate Windows read-only descriptor flushing restrictions on every host.
        snapshot.durability.handle = undefined;
        spyOn(snapshot.handle, "sync").mockRejectedValue(
          new Error("read-only descriptor cannot flush"),
        );
      }
      await applyFileChattr(
        path,
        { chmod: initiallyReadonly ? 0o644 : 0o444 },
        undefined,
        { ...snapshot },
      );
      const flushing = snapshot.durability.handle!;
      expect(flushing).toBeDefined();
      if (initiallyReadonly) expect(flushing).not.toBe(snapshot.handle);
      expect(snapshot.durability.dirty).toBeFalse();
      expect(((await stat(path)).mode & 0o200) !== 0).toBe(initiallyReadonly);
      await applyFileChattr(path, { chmod: before }, undefined, {
        ...snapshot,
      });
      expect((await stat(path)).mode & 0o777).toBe(before);
      expect(snapshot.durability.handle).toBe(flushing);
      expect(snapshot.durability.dirty).toBeFalse();
      await snapshots[Symbol.asyncDispose]();
      await expect(snapshot.handle.stat()).rejects.toMatchObject({
        code: "EBADF",
      });
      await expect(flushing.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await snapshots[Symbol.asyncDispose]();
      await chmod(path, 0o644);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Windows writable attributes retain metadata calls, fences, and flushing for equivalent readonly bits", async () => {
  const { root, path } = await fixture();
  const snapshots = new FileChattrSnapshots();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    const snapshot = await readFileChattrSnapshot(path);
    snapshots.set(path, snapshot);
    const metadata = spyOn(snapshot.handle, "chmod");
    const sync = spyOn(snapshot.handle, "sync");
    let fences = 0;
    Object.defineProperty(process, "platform", { value: "win32" });
    await applyFileChattr(
      path,
      { chmod: 0o600 },
      async () => {
        fences++;
      },
      snapshot,
    );
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(fences).toBeGreaterThan(0);
    expect(snapshot.durability.dirty).toBeFalse();
  } finally {
    Object.defineProperty(process, "platform", platform);
    await snapshots[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  }
});

test("clean readonly attribute no-op requires no descriptor upgrade; dirty state requires flushing", async () => {
  const { root, path } = await fixture();
  const snapshots = new FileChattrSnapshots();
  const actualOpen = fs.open;
  try {
    await chmod(path, 0o444);
    const snapshot = await readFileChattrSnapshot(path);
    snapshots.set(path, snapshot);
    snapshot.durability.handle = undefined;
    const mutation = spyOn(snapshot.handle, "chmod");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      if (String(args[0]) === path) throw new Error("readonly upgrade denied");
      return actualOpen(...args);
    }) as typeof fs.open);
    try {
      await applyFileChattr(path, { chmod: 0o444 }, undefined, snapshot);
      expect(mutation).not.toHaveBeenCalled();
      expect(snapshot.durability.dirty).toBeFalse();
      snapshot.durability.dirty = true;
      await expect(
        applyFileChattr(path, undefined, undefined, snapshot),
      ).rejects.toBeInstanceOf(AggregateError);
      expect(snapshot.durability.dirty).toBeTrue();
    } finally {
      Object.defineProperty(process, "platform", platform);
      open.mockRestore();
      mutation.mockRestore();
    }
  } finally {
    await snapshots[Symbol.asyncDispose]();
    await chmod(path, 0o644);
    await rm(root, { recursive: true, force: true });
  }
});
for (const fault of ["open", "sync", "race", "close"] as const) {
  test(`readonly descriptor upgrade preserves rollback and ownership after ${fault} failure`, async () => {
    const { root, path } = await fixture();
    const snapshots = new FileChattrSnapshots();
    let candidate: Awaited<ReturnType<typeof fs.open>> | undefined;
    const actualOpen = fs.open;
    let opened = 0;
    let closed = 0;
    let open: ReturnType<typeof spyOn> | undefined;
    try {
      await chmod(path, 0o444);
      const snapshot = await readFileChattrSnapshot(path);
      snapshots.set(path, snapshot);
      snapshot.durability.handle = undefined;
      spyOn(snapshot.handle, "sync").mockRejectedValue(
        new Error("read-only descriptor cannot flush"),
      );
      open = spyOn(fs, "open").mockImplementation((async (
        ...args: Parameters<typeof fs.open>
      ) => {
        if (
          String(args[0]) !== path ||
          typeof args[1] !== "number" ||
          !(args[1] & constants.O_RDWR)
        )
          return actualOpen(...args);
        opened++;
        if (fault === "open") throw new Error("upgrade open failed");
        candidate = await actualOpen(...args);
        const close = candidate.close.bind(candidate);
        spyOn(candidate, "close").mockImplementation(async () => {
          closed++;
          if (fault === "close" && closed === 1)
            throw new Error("candidate close failed");
          await close();
        });
        spyOn(candidate, "sync").mockRejectedValue(
          new Error("upgrade flush failed"),
        );
        if (fault === "race" || fault === "close") {
          await rename(path, join(root, "original.txt"));
          await writeFile(path, "source");
          await chmod(path, 0o640);
        }
        return candidate;
      }) as typeof fs.open);
      const error = await applyFileChattr(path, { chmod: 0o644 }, undefined, {
        ...snapshot,
      }).catch((error) => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect(snapshot.durability.dirty).toBeTrue();
      expect(await Bun.file(path).text()).toBe("source");
      if (fault === "race" || fault === "close") {
        expect(snapshot.durability.handle).toBeUndefined();
        if (fault === "close")
          expect(
            snapshot.durability.cleanupHandles?.has(candidate!),
          ).toBeTrue();
        if (process.platform !== "win32")
          expect((await stat(path)).mode & 0o777).toBe(0o640);
      } else {
        expect((await stat(path)).mode & 0o200).toBe(0);
        if (fault === "sync") {
          expect(opened).toBe(1);
          expect(snapshot.durability.handle === candidate).toBeTrue();
        }
      }
      open.mockRestore();
      open = undefined;
      await snapshots[Symbol.asyncDispose]();
      await expect(snapshot.handle.stat()).rejects.toMatchObject({
        code: "EBADF",
      });
      if (candidate) {
        await expect(candidate.stat()).rejects.toMatchObject({ code: "EBADF" });
        expect(closed).toBe(fault === "close" ? 2 : 1);
      }
    } finally {
      open?.mockRestore();
      await snapshots[Symbol.asyncDispose]();
      await candidate?.close().catch(() => undefined);
      await chmod(path, 0o644);
      await rm(root, { recursive: true, force: true });
    }
  });
}
test("self-owned attribute descriptor cleanup preserves the primary verification failure", async () => {
  const { root, path } = await fixture();
  const snapshots = new FileChattrSnapshots();
  const actualOpen = fs.open;
  let owned: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const snapshot = await readFileChattrSnapshot(path);
    snapshots.set(path, snapshot);
    const primary = new Error("attribute read failed");
    const cleanup = new Error("attribute close failed");
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await actualOpen(...args);
      if (String(args[0]) === path) {
        owned = handle;
        spyOn(handle, "read").mockRejectedValue(primary);
        const close = handle.close.bind(handle);
        spyOn(handle, "close").mockImplementation(async () => {
          await close();
          throw cleanup;
        });
      }
      return handle;
    }) as typeof fs.open);
    try {
      const error = await applyFileChattr(path, { chmod: 0o600 }, undefined, {
        ...snapshot,
        handle: undefined,
        durability: undefined,
      }).catch((error) => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toContain(primary);
      expect(error.errors[1]).toBeInstanceOf(AggregateError);
      expect(error.errors[1].errors).toContain(cleanup);
      expect(error.details.affectedPaths).toEqual([path]);
      await expect(owned!.stat()).rejects.toMatchObject({ code: "EBADF" });
      expect(await Bun.file(path).text()).toBe("source");
    } finally {
      open.mockRestore();
    }
  } finally {
    await snapshots[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  }
});

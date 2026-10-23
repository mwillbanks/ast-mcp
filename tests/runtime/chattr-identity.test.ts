import { expect, test } from "bun:test";
import { chmod, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyFileChattr,
  readFileChattrSnapshot,
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
    const snapshot = await readFileChattrSnapshot(path);
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
    const snapshot = await readFileChattrSnapshot(path);
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
    const snapshot = await readFileChattrSnapshot(path);
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
    const snapshot = await readFileChattrSnapshot(path);
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

import { beforeEach, expect, spyOn, test } from "bun:test";

import { createMockTime, type MockTime } from "../../support/mock-time.ts";
let time: MockTime;
beforeEach(() => {
  time = createMockTime();
});
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireFileLock,
  mutationLockPath,
} from "../../../src/intelligence/mutation/locks.ts";
import {
  ensurePrivateLockDirectory,
  systemAccount,
} from "../../../src/runtime/private-lock-directory.ts";

test.each(["opened", "synced"] as const)(
  "renewal fences an owner changed at the %s boundary",
  async (boundary) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-lock-boundary-"),
    );
    const file = path.join(root, "value.ts");
    const lease = await acquireFileLock(file);
    const originalOpen = fs.open;
    async function replaceOwner() {
      const source = await fs.readFile(lease.lockPath, "utf8");
      const record = JSON.parse(source.split("\n")[0]!);
      await fs.writeFile(
        lease.lockPath,
        JSON.stringify({ ...record, token: "concurrent-owner" }),
      );
    }
    const open = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === lease.lockPath && args[1] === "r+") {
        if (boundary === "opened") {
          await replaceOwner();
        } else {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await sync();
            await replaceOwner();
          };
        }
      }
      return handle;
    });
    try {
      await expect(lease.renew()).rejects.toMatchObject({
        code: "lock_fenced",
      });
      expect(JSON.parse(await fs.readFile(lease.lockPath, "utf8")).token).toBe(
        "concurrent-owner",
      );
      await expect(lease.fence()).rejects.toMatchObject({
        code: "lock_fenced",
      });
    } finally {
      open.mockRestore();
      await lease.release();
      await fs.rm(root, { force: true, recursive: true });
    }
  },
);
test("orphan lock cleanup propagates unreadable artifact failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-mcp-lock-orphan-"));
  const file = path.join(root, "value.ts");
  const lock = await mutationLockPath(file);
  const orphan = `${lock}.pending-orphan`;
  await fs.writeFile(orphan, "incomplete");
  const originalStat = fs.lstat;
  const stat = spyOn(fs, "lstat").mockImplementation((async (
    ...args: Parameters<typeof fs.lstat>
  ) => {
    if (String(args[0]) === orphan)
      throw Object.assign(new Error("orphan denied"), { code: "EACCES" });
    return originalStat(...args);
  }) as typeof fs.lstat);
  try {
    await expect(acquireFileLock(file)).rejects.toThrow("orphan denied");
    expect(await Bun.file(lock).exists()).toBe(false);
    expect(await Bun.file(orphan).text()).toBe("incomplete");
  } finally {
    stat.mockRestore();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("checkout lock orphan sweeps are bounded and failed sweeps retry", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-checkout-sweep-"),
  );
  const directory = await ensurePrivateLockDirectory(await systemAccount());
  const target = path.join(directory, path.basename(root));
  const lock = await mutationLockPath(target);
  const orphan = `${lock}.pending-test`;
  const originalReaddir = fs.readdir;
  let scans = 0;
  let fail = false;
  const readdir = spyOn(fs, "readdir").mockImplementation((async (
    ...args: Parameters<typeof fs.readdir>
  ) => {
    if (String(args[0]) === directory) {
      scans++;
      if (fail) throw new Error("orphan sweep failed");
    }
    return originalReaddir(...args);
  }) as typeof fs.readdir);
  async function takeLease() {
    const lease = await acquireFileLock(target);
    await lease.release();
  }
  try {
    await takeLease();
    expect(scans).toBe(1);

    await fs.writeFile(orphan, "incomplete");
    await fs.utimes(orphan, 0, 0);
    await time.advanceBy(59_999);
    await takeLease();
    expect(scans).toBe(1);
    expect(await Bun.file(orphan).exists()).toBe(true);

    await time.advanceBy(1);
    fail = true;
    await expect(takeLease()).rejects.toThrow("orphan sweep failed");
    fail = false;
    await takeLease();
    expect(scans).toBe(3);
    expect(await Bun.file(orphan).exists()).toBe(false);
  } finally {
    readdir.mockRestore();
    await fs.rm(orphan, { force: true });
    await fs.rm(root, { force: true, recursive: true });
  }
});

import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireFileLock,
  mutationLockPath,
} from "../../../src/intelligence/mutation/locks.ts";

test.each(["moved", "published"] as const)(
  "renewal fences an owner changed at the %s boundary",
  async (boundary) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-lock-boundary-"),
    );
    const file = path.join(root, "value.ts");
    const lease = await acquireFileLock(file);
    const originalRename = fs.rename;
    const originalLink = fs.link;
    async function replaceOwner(recordPath: string) {
      const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
      await fs.writeFile(
        recordPath,
        JSON.stringify({ ...record, token: "concurrent-owner" }),
      );
    }
    const rename =
      boundary === "moved"
        ? spyOn(fs, "rename").mockImplementation(async (from, to) => {
            await originalRename(from, to);
            if (
              String(from) === lease.lockPath &&
              String(to).includes(".stale-")
            )
              await replaceOwner(String(to));
          })
        : undefined;
    const link =
      boundary === "published"
        ? spyOn(fs, "link").mockImplementation(async (from, to) => {
            await originalLink(from, to);
            if (
              String(from).includes(".pending-") &&
              String(to) === lease.lockPath
            )
              await replaceOwner(lease.lockPath);
          })
        : undefined;
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
      rename?.mockRestore();
      link?.mockRestore();
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

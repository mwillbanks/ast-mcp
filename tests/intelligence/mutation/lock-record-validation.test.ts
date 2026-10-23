import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireFileLock,
  mutationLockPath,
} from "../../../src/intelligence/mutation/locks.ts";

test("pending metadata sync failures clean unpublished artifacts and release OS ownership", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-pending-failure-"),
  );
  const lockRoot = await fs.realpath(root);
  const original = fs.open;
  const failure = new Error("metadata sync failed");
  const open = spyOn(fs, "open").mockImplementation((async (
    ...args: Parameters<typeof fs.open>
  ) => {
    const handle = await original(...args);
    if (
      String(args[0]).startsWith(lockRoot) &&
      String(args[0]).includes(".pending-")
    )
      handle.sync = async () => {
        throw failure;
      };
    return handle;
  }) as typeof fs.open);
  try {
    await expect(acquireFileLock(path.join(root, "target"))).rejects.toBe(
      failure,
    );
    expect(await fs.readdir(root)).toEqual([]);
    open.mockRestore();
    const next = await acquireFileLock(path.join(root, "target"));
    await next.fence();
    await next.release();
  } finally {
    open.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("release preserves malformed metadata and allows recovery after repair", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-release-failure-"),
  );
  const target = path.join(root, "target");
  const owner = await acquireFileLock(target);
  const original = await readFile(owner.lockPath, "utf8");
  try {
    await writeFile(owner.lockPath, "malformed");
    await expect(owner.release()).rejects.toMatchObject({
      code: "lock_record_malformed",
    });
    expect(await readFile(owner.lockPath, "utf8")).toBe("malformed");
    await writeFile(owner.lockPath, original);
    const next = await acquireFileLock(target);
    await next.release();
  } finally {
    await owner.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed renewal frames are ignored while invalid initial record types fail closed", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-record-validation-"),
  );
  const target = path.join(root, "target");
  const owner = await acquireFileLock(target, { leaseMs: 60_000 });
  const lockPath = owner.lockPath;
  const initial = await readFile(lockPath, "utf8");
  await owner.release();
  try {
    await writeFile(lockPath, initial + "\n{invalid}\n");
    const recovered = await acquireFileLock(target);
    await recovered.fence();
    await recovered.release();
    const invalid = { ...JSON.parse(initial), pid: "invalid" };
    await writeFile(lockPath, JSON.stringify(invalid));
    await expect(acquireFileLock(target)).rejects.toMatchObject({
      code: "lock_record_malformed",
    });
    expect(await readFile(lockPath, "utf8")).toBe(JSON.stringify(invalid));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an expired file owner cannot renew and inner acquisition deadlines remain enforced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-lock-clock-"));
  let now = Date.now();
  const owner = await acquireFileLock(path.join(root, "target"), {
    now: () => now,
    leaseMs: 100,
  });
  try {
    now += 101;
    await expect(owner.renew()).rejects.toMatchObject({ code: "lock_fenced" });
    await expect(
      acquireFileLock(path.join(root, "other"), {
        now: () => now + 60_000,
        deadline: Date.now() + 30_000,
      }),
    ).rejects.toMatchObject({ code: "lock_deadline" });
    await writeFile(path.join(root, "file"), "value");
    await expect(
      mutationLockPath(path.join(root, "file", "nested")),
    ).rejects.toThrow();
  } finally {
    await owner.release();
    await rm(root, { recursive: true, force: true });
  }
});

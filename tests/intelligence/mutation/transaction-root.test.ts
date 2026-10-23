import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { acquireFileLock } from "../../../src/intelligence/mutation/locks.ts";
import {
  ensureMutationLockDirectory,
  mutationTransactionLockPath,
} from "../../../src/intelligence/mutation/service.ts";
import { readSystemAccount } from "../../../src/runtime/private-lock-directory.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-lock-root-"));
  roots.push(root);
  return root;
}

test("checkout locks remain shared across temporary and home environment overrides", async () => {
  const checkout = await temporary();
  const lockPath = await mutationTransactionLockPath(checkout);
  const owner = await acquireFileLock(lockPath, { leaseMs: 30_000 });
  const childTemporary = await temporary();
  const modulePath = Bun.fileURLToPath(
    new URL("../../../src/intelligence/mutation/service.ts", import.meta.url),
  );
  const locksPath = Bun.fileURLToPath(
    new URL("../../../src/intelligence/mutation/locks.ts", import.meta.url),
  );
  const script = `
    import { mutationTransactionLockPath } from ${JSON.stringify(modulePath)};
    import { acquireFileLock } from ${JSON.stringify(locksPath)};
    const target = await mutationTransactionLockPath(${JSON.stringify(checkout)});
    if (target !== ${JSON.stringify(lockPath)}) throw new Error("split checkout lock namespace");
    try {
      const lease = await acquireFileLock(target, { deadline: Date.now() + 100 });
      await lease.release();
      process.exit(2);
    } catch (error) {
      console.log(error.code);
      process.exit(error.code === "lock_deadline" ? 0 : 3);
    }
  `;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        HOME: childTemporary,
        TMPDIR: childTemporary,
        TMP: childTemporary,
        TEMP: childTemporary,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("lock_deadline");
    expect(exit).toBe(0);
    await owner.fence();
  } finally {
    await owner.release();
  }
});

test("creates an account-private lock directory", async () => {
  const home = await temporary();
  const directory = await ensureMutationLockDirectory({
    homedir: home,
    uid: os.userInfo().uid,
  });
  const metadata = await lstat(directory);
  expect(metadata.isDirectory()).toBe(true);
  if (process.platform !== "win32") expect(metadata.mode & 0o777).toBe(0o700);
});

test.each(["symlink", "public"] as const)(
  "rejects an unsafe %s lock directory",
  async (kind) => {
    if (kind === "public" && process.platform === "win32") return;
    const home = await temporary();
    const directory = path.join(home, ".ast-mcp-mutation-locks");
    if (kind === "symlink") await symlink(await temporary(), directory, "dir");
    else {
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o755);
    }
    await expect(
      ensureMutationLockDirectory({ homedir: home, uid: os.userInfo().uid }),
    ).rejects.toMatchObject({ code: "mutation_lock_directory_unsafe" });
  },
);

test("fails closed when account lookup fails", async () => {
  const lookup = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("account lookup failed");
  });
  try {
    await expect(readSystemAccount()).rejects.toMatchObject({
      code: "mutation_lock_account_unavailable",
    });
  } finally {
    lookup.mockRestore();
  }
});

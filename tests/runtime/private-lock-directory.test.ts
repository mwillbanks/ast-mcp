import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  privateLockDatabasePath,
  privateLockDatabasePathSync,
  ensurePrivateLockDirectory,
  readSystemAccount,
  systemAccount,
} from "../../src/runtime/private-lock-directory.ts";

test("account lookup deadlines terminate a nonresponsive child", async () => {
  const original = Bun.spawn;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    child = original(
      [process.execPath, "--eval", "setInterval(() => {}, 1000)"],
      { stdout: "pipe", stderr: "ignore" },
    );
    return child;
  });
  try {
    await expect(readSystemAccount()).rejects.toMatchObject({
      code: "mutation_lock_account_unavailable",
    });
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  } finally {
    spawn.mockRestore();
    child?.kill("SIGKILL");
    if (child) await child.exited;
  }
}, 10_000);

test("cached account resolution retries after a transient lookup failure", async () => {
  const isolated = await import(
    Bun.fileURLToPath(
      new URL("../../src/runtime/private-lock-directory.ts", import.meta.url),
    ) + "?cache-failure"
  );
  let calls = 0;
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    calls++;
    throw new Error("account lookup denied");
  });
  try {
    await expect(isolated.systemAccount()).rejects.toMatchObject({
      code: "mutation_lock_account_unavailable",
    });
    await expect(isolated.systemAccount()).rejects.toMatchObject({
      code: "mutation_lock_account_unavailable",
    });
    expect(calls).toBe(2);
    await systemAccount().catch(() => undefined);
  } finally {
    spawn.mockRestore();
  }
  expect(path.isAbsolute((await isolated.systemAccount()).homedir)).toBe(true);
});

test.each([
  ["malformed JSON", 'console.log("invalid")'],
  [
    "invalid account identity",
    'console.log(JSON.stringify({ homedir: "relative", uid: -1 }))',
  ],
  ["excessive output", 'console.log("x".repeat(5000))'],
  ["failed child", "process.exit(3)"],
] as const)("account lookup fails closed for %s", async (_name, code) => {
  const original = Bun.spawn;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    child = original([process.execPath, "--eval", code], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return child;
  });
  try {
    await expect(readSystemAccount()).rejects.toMatchObject({
      code: "mutation_lock_account_unavailable",
    });
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  } finally {
    spawn.mockRestore();
    child?.kill();
    if (child) await child.exited;
  }
});

test("synchronous first-use lookup resolves the account and rejects lookup failures", async () => {
  const modulePath = Bun.fileURLToPath(
    new URL("../../src/runtime/private-lock-directory.ts", import.meta.url),
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-first-account-"));
  let database: string | undefined;
  try {
    const fresh = await import(modulePath + "?sync-first-success");
    database = fresh.privateLockDatabasePathSync(path.join(root, "target"));
    expect(await fresh.privateLockDatabasePath(path.join(root, "target"))).toBe(
      database,
    );
    const failing = await import(modulePath + "?sync-first-failure");
    const spawn = spyOn(childProcess, "spawnSync").mockImplementation(() => {
      throw new Error("account lookup denied");
    });
    try {
      expect(() =>
        failing.privateLockDatabasePathSync(path.join(root, "failed")),
      ).toThrow("Cannot resolve the operating-system account");
    } finally {
      spawn.mockRestore();
    }
  } finally {
    if (database) await rm(database, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("relative account homes are rejected before filesystem access", async () => {
  await expect(
    ensurePrivateLockDirectory({ homedir: "relative", uid: os.userInfo().uid }),
  ).rejects.toMatchObject({ code: "mutation_lock_directory_unsafe" });
});

test("sync and async lock identities share a database and refuse symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-private-db-"));
  const identity = path.join(root, "target");
  const database = await privateLockDatabasePath(identity);
  try {
    expect(privateLockDatabasePathSync(identity)).toBe(database);
    await rm(database);
    await symlink(path.join(root, "victim"), database);
    await expect(privateLockDatabasePath(identity)).rejects.toMatchObject({
      code: "mutation_lock_directory_unsafe",
    });
    expect(() => privateLockDatabasePathSync(identity)).toThrow(
      "account-owned regular file",
    );
  } finally {
    await rm(database, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("synchronous account lookup ignores a changed home and temporary directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-sync-account-"));
  const identity = path.join(root, "target");
  const expected = await privateLockDatabasePath(identity);
  const modulePath = Bun.fileURLToPath(
    new URL("../../src/runtime/private-lock-directory.ts", import.meta.url),
  );
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { privateLockDatabasePathSync } from ${JSON.stringify(modulePath)}; console.log(privateLockDatabasePathSync(${JSON.stringify(identity)}));`,
      ],
      {
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          TMPDIR: root,
          TMP: root,
          TEMP: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(errors).toBe("");
    expect(output.trim()).toBe(expected);
  } finally {
    await rm(expected, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

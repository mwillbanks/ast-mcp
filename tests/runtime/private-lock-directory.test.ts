import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  accountLookupCommand,
  privateLockDatabasePath,
  privateLockDatabasePathSync,
  ensurePrivateLockDirectory,
  readSystemAccount,
  systemAccount,
} from "../../src/runtime/private-lock-directory.ts";

test("Windows account lookup uses the system known folder and rejects an unknown system root", () => {
  const command = accountLookupCommand("win32", {
    SystemRoot: "C:\\Windows",
    HOME: "Z:\\untrusted",
    USERPROFILE: "Z:\\untrusted",
  });
  expect(command[0]).toBe(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  expect(command).toContain("-NoProfile");
  expect(command.at(-1)).toContain("[Environment+SpecialFolder]::UserProfile");
  expect(command.join(" ")).not.toContain("untrusted");
  expect(accountLookupCommand("win32", { systemroot: "C:\\Windows" })).toEqual(
    command,
  );
  expect(() => accountLookupCommand("win32", {})).toThrow(
    "system directory is unavailable",
  );
  expect(() =>
    accountLookupCommand("win32", { SystemRoot: "relative" }),
  ).toThrow("system directory is unavailable");
});

test("account lookup removes environment home and runtime options with mixed casing", async () => {
  const names = [
    "hOmE",
    "UserProfile",
    "HomeDrive",
    "HomePath",
    "Node_Options",
    "Bun_Options",
  ];
  const before = names.map((name) => process.env[name]);
  const original = Bun.spawn;
  let environment: NodeJS.ProcessEnv | undefined;
  const spawn = spyOn(Bun, "spawn").mockImplementation(((_command, options) => {
    environment = options?.env;
    return original(
      [
        process.execPath,
        "--eval",
        'console.log(JSON.stringify({homedir: process.cwd(),uid: process.platform === "win32" ? -1 : process.geteuid()}))',
      ],
      { env: options?.env, stdout: "pipe", stderr: "ignore" },
    );
  }) as typeof Bun.spawn);
  try {
    for (const name of names) process.env[name] = "untrusted";
    await readSystemAccount();
    for (const name of names) {
      expect(
        Object.keys(environment!).some(
          (key) => key.toUpperCase() === name.toUpperCase(),
        ),
      ).toBe(false);
      expect(process.env[name]).toBe("untrusted");
    }
  } finally {
    spawn.mockRestore();
    for (const [index, name] of names.entries()) {
      if (before[index] === undefined) delete process.env[name];
      else process.env[name] = before[index];
    }
  }
});

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

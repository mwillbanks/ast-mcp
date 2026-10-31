import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  install,
  uninstall,
  update,
  type InstallOptions,
} from "../../src/installer";
import {
  createServicePlan,
  installService,
  removeService,
} from "../../src/installer/service";
import {
  readInstallerText,
  removeInstallerFile,
  withInstallerFileTransaction,
  writeInstallerFile,
} from "../../src/installer/transaction";
import { httpEndpoint } from "../../src/installer/transport";
import { acquireTransactionLockSync } from "../../src/runtime/transaction-lock";

const directories: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await Promise.all(
    directories
      .splice(0)
      .map((file) => rm(file, { force: true, recursive: true })),
  );
});

async function fixture(global = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-transaction-"));
  directories.push(root);
  const home = path.join(root, "home");
  await mkdir(home);
  process.env.CODEX_HOME = path.join(home, ".codex");
  const options: InstallOptions = {
    root,
    home,
    scope: global ? "global" : "local",
    targets: ["codex", "claude", "copilot"],
    verifyLaunch: async () => {},
  };
  if (global) {
    const bin = path.join(home, "bin");
    await mkdir(bin);
    const alias = path.join(
      bin,
      process.platform === "win32" ? "ast-mcp.cmd" : "ast-mcp",
    );
    await writeFile(
      alias,
      process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    options.globalBinDirectories = [bin];
    await mkdir(process.env.CODEX_HOME!, { recursive: true });
    await writeFile(
      path.join(process.env.CODEX_HOME!, "config.toml"),
      'profile = "safe"\n',
    );
    await writeFile(
      path.join(process.env.CODEX_HOME!, "safe.config.toml"),
      'approval_policy = "never"\n',
    );
  } else {
    await writeFile(
      path.join(root, "ast-mcp.toml"),
      "version = 1\n[safety]\nallow_temp_directory = false\n",
    );
    await writeFile(
      path.join(root, ".mcp.json"),
      '{"mcpServers":{"ast-mcp":{"command":"original","env":{"TOKEN":"private"}}}}\n',
    );
    if (process.platform !== "win32")
      await chmod(path.join(root, ".mcp.json"), 0o640);
  }
  return options;
}

async function contents(root: string) {
  const files: Record<string, { bytes: string; mode: number }> = {};
  async function visit(file: string): Promise<void> {
    if (
      [".ast-mcp-locks", ".ast-mcp-mutation-locks"].includes(
        path.basename(file),
      )
    )
      return;
    if (path.basename(file).endsWith(".config-commit.sqlite")) return;
    const info = await lstat(file);
    if (info.isDirectory()) {
      for (const name of (await readdir(file)).sort())
        await visit(path.join(file, name));
    } else if (info.isFile()) {
      files[path.relative(root, file)] = {
        bytes: (await readFile(file)).toString("base64"),
        mode: info.mode & 0o777,
      };
    }
  }
  await visit(root);
  return files;
}

for (const operation of ["install", "update", "uninstall"] as const) {
  test(
    operation +
      " rolls back every intermediate host, receipt, configuration and instruction mutation",
    async () => {
      const handlers = { install, update, uninstall };
      async function prepare() {
        const options = await fixture();
        if (operation !== "install") await install(options);
        return options;
      }
      let total = 0;
      const sample = await prepare();
      const invoke = (options: InstallOptions) =>
        handlers[operation]({
          ...options,
          ...(operation === "uninstall"
            ? {}
            : { transport: "http" as const, port: 4567 }),
        });
      await withInstallerFileTransaction(() => invoke(sample), {
        rename: (...args) => {
          total += 1;
          renameSync(...args);
        },
        remove: (...args) => {
          total += 1;
          rmSync(...args);
        },
      });
      expect(total).toBeGreaterThan(5);
      for (let failure = 1; failure <= total; failure += 1) {
        const options = await prepare();
        const before = await contents(options.root);
        let calls = 0;
        let injected = false;
        const fail = () => {
          calls += 1;
          if (!injected && calls === failure) {
            injected = true;
            throw new Error("injected commit failure");
          }
        };
        await expect(
          withInstallerFileTransaction(() => invoke(options), {
            rename: (...args) => {
              fail();
              renameSync(...args);
            },
            remove: (...args) => {
              fail();
              rmSync(...args);
            },
          }),
        ).rejects.toThrow("injected commit failure");
        expect(injected).toBe(true);
        expect(await contents(options.root)).toEqual(before);
      }
    },
    30_000,
  );
}

test("global Codex profile changes roll back when the ownership marker cannot commit", async () => {
  const options = await fixture(true);
  const config = path.join(process.env.CODEX_HOME!, "config.toml");
  const before = await contents(options.root);
  let failed = false;
  await expect(
    withInstallerFileTransaction(() => install(options), {
      rename: (from, to) => {
        if (!failed && String(to) === config) {
          failed = true;
          expect(
            readFileSync(
              path.join(process.env.CODEX_HOME!, "safe.config.toml"),
              "utf8",
            ),
          ).toContain("mcp_elicitations");
          throw new Error("main config failed");
        }
        renameSync(from, to);
      },
    }),
  ).rejects.toThrow("main config failed");
  expect(failed).toBe(true);
  expect(await contents(options.root)).toEqual(before);
});

test("failed JSON refresh preserves original launch ancestry and later uninstall restores it", async () => {
  for (const target of ["claude", "copilot"] as const) {
    const options = await fixture();
    options.targets = [target];
    await install(options);
    const file = path.join(
      options.root,
      target === "claude" ? ".mcp.json" : ".vscode/mcp.json",
    );
    const receipt = file + ".ast-mcp.json";
    const original = await readFile(receipt, "utf8");
    let failed = false;
    await expect(
      withInstallerFileTransaction(
        () => update({ ...options, transport: "http" }),
        {
          rename: (from, to) => {
            if (!failed && String(to) === file) {
              failed = true;
              throw new Error("host failed");
            }
            renameSync(from, to);
          },
        },
      ),
    ).rejects.toThrow("host failed");
    expect(await readFile(receipt, "utf8")).toBe(original);
    await uninstall(options);
    if (target === "claude")
      expect(
        JSON.parse(await readFile(file, "utf8")).mcpServers["ast-mcp"],
      ).toEqual({ command: "original", env: { TOKEN: "private" } });
    else
      expect(JSON.parse(await readFile(file, "utf8")).servers).toBeUndefined();
  }
});

test("rollback preserves concurrent edits and reports incomplete recovery", async () => {
  const options = await fixture();
  const file = path.join(options.root, "user.txt");
  await writeFile(file, "original");
  await expect(
    withInstallerFileTransaction(async () => {
      expect(await readInstallerText(file)).toBe("original");
      await writeInstallerFile(file, "installed", { expected: "original" });
      await writeFile(file, "concurrent-user-edit");
      throw new Error("later failure");
    }),
  ).rejects.toThrow("rollback was incomplete");
  expect(await readFile(file, "utf8")).toBe("concurrent-user-edit");
});

test("observed user edits cannot be overwritten and unchanged files need no rollback", async () => {
  const options = await fixture();
  const file = path.join(options.root, "user.txt");
  await writeFile(file, "original");
  await expect(
    withInstallerFileTransaction(async () => {
      await readInstallerText(file);
      await writeFile(file, "user-edit");
      await writeInstallerFile(file, "installed");
    }),
  ).rejects.toThrow("changed");
  expect(await readFile(file, "utf8")).toBe("user-edit");
  await expect(
    writeInstallerFile(file, "bad", { expected: "stale" }),
  ).rejects.toThrow("changed");
  await expect(
    writeInstallerFile(file, "bad", { exclusive: true }),
  ).rejects.toThrow("already exists");
  await writeInstallerFile(file, "user-edit");
  await removeInstallerFile(path.join(options.root, "absent"));
});

test("symlink destinations remain untouched during failed install and rollback", async () => {
  if (process.platform === "win32") return;
  const options = await fixture();
  const file = path.join(options.root, "actual");
  const link = path.join(options.root, "link");
  await writeFile(file, "user");
  await symlink(file, link);
  await expect(writeInstallerFile(link, "bad")).rejects.toThrow("regular file");
  expect(await readFile(file, "utf8")).toBe("user");
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
});

test("service install and removal compensate manager actions after restoring original files", async () => {
  for (const existed of [false, true]) {
    const options = await fixture();
    const commands: string[][] = [];
    let fail = true;
    const service = {
      root: options.root,
      home: options.home!,
      scope: "local" as const,
      platform: "linux" as const,
      cliEntry: process.execPath,
      endpoint: httpEndpoint("127.0.0.1", 4567),
      stateQuery: async (command: string[]) => ({
        exitCode:
          command[0] === "launchctl" && command[1] === "print" && !existed
            ? 113
            : 0,
        stdout:
          command[0] === "systemctl"
            ? existed
              ? "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n"
              : "LoadState=not-found\nActiveState=inactive\nUnitFileState=\n"
            : command[1] === "print-disabled"
              ? "disabled services = {}"
              : "state = running",
        stderr: "Could not find service",
      }),
      runner: async (command: string[]) => {
        commands.push(command);
        if (fail && command.includes("enable")) {
          fail = false;
          throw new Error("manager failed");
        }
      },
    };
    const plan = createServicePlan(service);
    if (existed) {
      await mkdir(path.dirname(plan.file), { recursive: true });
      await writeFile(plan.file, "original service", { mode: 0o600 });
    }
    const before = await contents(options.root);
    await expect(installService(service)).rejects.toThrow("manager failed");
    expect(await contents(options.root)).toEqual(before);
    expect(commands.some((command) => command.includes("stop"))).toBe(true);
    if (existed)
      expect(
        commands.filter((command) => command.includes("enable")),
      ).toHaveLength(2);
    if (!existed) continue;
    let failedRemoval = false;
    service.runner = async (command: string[]) => {
      commands.push(command);
      if (!failedRemoval && command.includes("daemon-reload")) {
        failedRemoval = true;
        throw new Error("reload failed");
      }
    };
    await expect(removeService(service)).rejects.toThrow("reload failed");
    expect(await contents(options.root)).toEqual(before);
  }
});

test("absence and an empty existing file remain different journal states", async () => {
  const options = await fixture();
  const file = path.join(options.root, "empty");
  await expect(
    withInstallerFileTransaction(async () => {
      await expect(readInstallerText(file)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await writeFile(file, "");
      await writeInstallerFile(file, "installed", { expected: "" });
    }),
  ).rejects.toMatchObject({ code: "configuration_conflict", retryable: true });
  expect(await readFile(file, "utf8")).toBe("");
});

test("shared configuration fences protect forward commits and guarded rollback", async () => {
  const options = await fixture();
  const file = path.join(options.root, "ast-mcp.toml");
  const original = await readFile(file, "utf8");
  const lock = () =>
    acquireTransactionLockSync(file + ".config-commit", {
      sharedDatabasePath: file + ".config-commit.sqlite",
    });
  let guard = lock();
  try {
    await expect(
      writeInstallerFile(file, "version = 2\n", {
        expected: original,
        configuration: file,
      }),
    ).rejects.toMatchObject({ code: "configuration_busy" });
    expect(await readFile(file, "utf8")).toBe(original);
  } finally {
    guard.release();
  }
  await expect(
    withInstallerFileTransaction(async () => {
      await writeInstallerFile(file, "version = 2\n", {
        expected: original,
        configuration: file,
      });
      guard = lock();
      throw new Error("later failure");
    }),
  ).rejects.toThrow("rollback was incomplete");
  guard.release();
  expect(await readFile(file, "utf8")).toBe("version = 2\n");
});

test("service removal validates original destinations before issuing any commands", async () => {
  const options = await fixture();
  const commands: string[][] = [];
  const service = {
    root: options.root,
    home: options.home!,
    scope: "local" as const,
    platform: "linux" as const,
    cliEntry: process.execPath,
    endpoint: httpEndpoint("127.0.0.1", 4567),
    stateQuery: async () => ({
      exitCode: 0,
      stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n",
      stderr: "",
    }),
    runner: async (command: string[]) => {
      commands.push(command);
    },
  };
  const plan = createServicePlan(service);
  await mkdir(plan.file, { recursive: true });
  await expect(removeService(service)).rejects.toThrow("regular file");
  expect(commands).toEqual([]);
  if (process.platform === "win32") return;
  await rm(plan.file, { recursive: true });
  const actual = path.join(options.root, "unowned.service");
  await writeFile(actual, "unowned");
  await symlink(actual, plan.file);
  await expect(removeService(service)).rejects.toThrow("regular file");
  expect(commands).toEqual([]);
  expect((await lstat(plan.file)).isSymbolicLink()).toBe(true);
  expect(await readFile(actual, "utf8")).toBe("unowned");
});

test("rollback preserves a replacement parent directory and restores only owned parents", async () => {
  const options = await fixture();
  const directory = path.join(options.root, "created");
  await expect(
    withInstallerFileTransaction(async () => {
      await writeInstallerFile(
        path.join(directory, "nested", "new"),
        "temporary",
      );
      throw new Error("stop");
    }),
  ).rejects.toThrow("stop");
  await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(directory);
  const file = path.join(directory, "file");
  await writeFile(file, "original");
  await expect(
    withInstallerFileTransaction(async () => {
      await writeInstallerFile(file, "installed");
      renameSync(directory, directory + "-moved");
      await mkdir(directory);
      await writeFile(file, "user replacement");
      throw new Error("stop");
    }),
  ).rejects.toThrow("rollback was incomplete");
  expect(await readFile(file, "utf8")).toBe("user replacement");
  expect(await readFile(path.join(directory + "-moved", "file"), "utf8")).toBe(
    "installed",
  );
});

test.skipIf(process.platform === "win32")(
  "runtime configuration aliases retain links and original modes through migration, failure and endpoint updates",
  async () => {
    const options = await fixture();
    options.targets = ["codex"];
    const config = path.join(options.root, "ast-mcp.toml");
    const target = path.join(options.root, "shared.toml");
    const original = await readFile(config, "utf8");
    await rm(config);
    await writeFile(target, original, { mode: 0o640 });
    await symlink(target, config);
    await writeFile(config + ".v1.bak", "prior backup", { mode: 0o600 });
    const host = path.join(options.root, ".codex/config.toml");
    const failHost = async (operation: () => Promise<unknown>) => {
      const before = await contents(options.root);
      let failed = false;
      await expect(
        withInstallerFileTransaction(operation, {
          rename: (from, to) => {
            if (!failed && String(to) === host) {
              failed = true;
              expect(readFileSync(target, "utf8")).toContain("version = 2");
              throw new Error("host failed");
            }
            renameSync(from, to);
          },
        }),
      ).rejects.toThrow("host failed");
      expect(failed).toBe(true);
      expect(await contents(options.root)).toEqual(before);
      expect((await lstat(config)).isSymbolicLink()).toBe(true);
      expect((await lstat(target)).mode & 0o777).toBe(0o640);
    };
    await failHost(() => install(options));
    expect(await readFile(target, "utf8")).toBe(original);
    await install(options);
    expect((await lstat(config + ".v1.bak")).mode & 0o777).toBe(0o600);
    expect(await readFile(config + ".v1.bak", "utf8")).toBe(original);
    await failHost(() => update({ ...options, transport: "http", port: 4567 }));
    await update({ ...options, transport: "http", port: 4567 });
    expect((await lstat(config)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toContain("port = 4567");
    await uninstall(options);
    expect((await lstat(config)).isSymbolicLink()).toBe(true);
    expect((await lstat(target)).mode & 0o777).toBe(0o640);
  },
);

test("service compensation never launches a concurrently replaced plan", async () => {
  const options = await fixture();
  const commands: string[][] = [];
  const service = {
    root: options.root,
    home: options.home!,
    scope: "local" as const,
    platform: "linux" as const,
    cliEntry: process.execPath,
    endpoint: httpEndpoint("127.0.0.1", 4567),
    stateQuery: async () => ({
      exitCode: 0,
      stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n",
      stderr: "",
    }),
    runner: async (command: string[]) => {
      commands.push(command);
      await writeFile(plan.file, "user replacement");
      throw new Error("manager failed");
    },
  };
  const plan = createServicePlan(service);
  await mkdir(path.dirname(plan.file), { recursive: true });
  await writeFile(plan.file, "original service");
  await expect(removeService(service)).rejects.toThrow(
    "rollback was incomplete",
  );
  expect(commands).toHaveLength(1);
  expect(await readFile(plan.file, "utf8")).toBe("user replacement");
});

test("a post-commit temporary cleanup failure retains rollback ancestry", async () => {
  const options = await fixture();
  const file = path.join(options.root, "user-config");
  await writeFile(file, "original");
  const actual = fs.rm;
  let failed = false;
  const cleanup = spyOn(fs, "rm").mockImplementation(
    async (...args: Parameters<typeof fs.rm>) => {
      if (!failed && path.basename(String(args[0])).endsWith(".tmp")) {
        failed = true;
        expect(readFileSync(file, "utf8")).toBe("installed");
        throw new Error("cleanup failed");
      }
      return actual(...args);
    },
  );
  try {
    await expect(writeInstallerFile(file, "installed")).rejects.toThrow(
      "cleanup failed",
    );
    expect(failed).toBe(true);
    expect(await readFile(file, "utf8")).toBe("original");
  } finally {
    cleanup.mockRestore();
  }
});

test("Darwin compensation stops partially started jobs by identifier after restoring plist absence or bytes", async () => {
  for (const existed of [false, true]) {
    const options = await fixture();
    const commands: string[][] = [];
    let failed = false;
    const service = {
      root: options.root,
      home: options.home!,
      scope: "local" as const,
      platform: "darwin" as const,
      cliEntry: process.execPath,
      endpoint: httpEndpoint("127.0.0.1", 4567),
      stateQuery: async (command: string[]) => ({
        exitCode:
          command[0] === "launchctl" && command[1] === "print" && !existed
            ? 113
            : 0,
        stdout:
          command[0] === "systemctl"
            ? existed
              ? "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n"
              : "LoadState=not-found\nActiveState=inactive\nUnitFileState=\n"
            : command[1] === "print-disabled"
              ? "disabled services = {}"
              : "state = running",
        stderr: "Could not find service",
      }),
      runner: async (command: string[]) => {
        commands.push(command);
        if (failed && command[1] === "bootout" && command.length === 3) {
          if (existed)
            expect(readFileSync(plan.file, "utf8")).toBe("original plist");
          else expect(existsSync(plan.file)).toBe(false);
        }
        if (!failed && command[1] === "kickstart") {
          failed = true;
          throw new Error("kickstart failed");
        }
      },
    };
    const plan = createServicePlan(service);
    const domain =
      "gui/" + (typeof process.getuid === "function" ? process.getuid() : 501);
    expect(plan.removeCommands).toEqual([
      ["launchctl", "bootout", domain + "/com.mwillbanks." + plan.id],
    ]);
    if (existed) {
      await mkdir(path.dirname(plan.file), { recursive: true });
      await writeFile(plan.file, "original plist", { mode: 0o600 });
    }
    const before = await contents(options.root);
    await expect(installService(service)).rejects.toThrow("kickstart failed");
    expect(await contents(options.root)).toEqual(before);
    expect(
      commands.filter(
        (command) => command[1] === "bootout" && command.length === 3,
      ),
    ).toEqual(plan.removeCommands);
    if (existed)
      expect(
        commands.filter((command) => command[1] === "bootstrap"),
      ).toHaveLength(2);
  }
});

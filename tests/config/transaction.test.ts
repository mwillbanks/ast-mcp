import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeConfigSource } from "../../src/config/edit";
import {
  migrateConfigSource,
  writeMigratedConfig,
} from "../../src/config/migrate";
import {
  assertConfigWriteTarget,
  configWriteTarget,
  withConfigTransaction,
} from "../../src/config/transaction";
import {
  authorizeRequestedDecision,
  clearSessionApprovals,
  InputRequiredSignal,
  withApprovalContext,
} from "../../src/runtime/approval";
import { withFileLocks } from "../../src/runtime/locks";
import { privateLockDatabasePathSync } from "../../src/runtime/private-lock-directory";
import {
  acquireTransactionLockSync,
  isTransactionLockArtifact,
} from "../../src/runtime/transaction-lock";

const folders: string[] = [];
afterEach(async () => {
  clearSessionApprovals();
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => fs.rm(folder, { recursive: true, force: true })),
  );
});
async function fixture(source = "version = 2\n") {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-config-transaction-"),
  );
  folders.push(root);
  const file = path.join(root, "ast-mcp.toml");
  await fs.writeFile(file, source);
  return { root, file };
}
test.skipIf(process.platform === "win32")(
  "configuration writes preserve symlink targets and permissions",
  async () => {
    const { root, file } = await fixture();
    const target = path.join(root, "shared.toml");
    await fs.rename(file, target);
    await fs.chmod(target, 0o640);
    await fs.symlink(target, file);
    await writeConfigSource(
      file,
      "version = 2\n# linked update\n",
      "version = 2\n",
      file + ".bak",
    );
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toContain("linked update");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
    expect(await fs.readFile(file + ".bak", "utf8")).toBe("version = 2\n");
    withConfigTransaction(file, () =>
      expect(() => withConfigTransaction(target, () => {})).toThrow(
        expect.objectContaining({ code: "configuration_busy" }),
      ),
    );
  },
);

test.skipIf(process.platform === "win32")(
  "configuration retargeting during staging fails without changing either target",
  async () => {
    const { root, file } = await fixture();
    const first = path.join(root, "first.toml");
    const second = path.join(root, "second.toml");
    const original = "version = 2\n";
    await fs.rename(file, first);
    await fs.writeFile(second, original);
    await fs.symlink(first, file);
    const actual = fs.writeFile;
    const writer = spyOn(fs, "writeFile").mockImplementation(
      async (...args: Parameters<typeof fs.writeFile>) => {
        await actual(...args);
        if (String(args[0]).includes(".config-")) {
          await fs.unlink(file);
          await fs.symlink(second, file);
        }
      },
    );
    try {
      await expect(
        writeConfigSource(file, original + "# rejected\n", original),
      ).rejects.toMatchObject({
        code: "configuration_conflict",
        retryable: true,
      });
      expect(await fs.readFile(first, "utf8")).toBe(original);
      expect(await fs.readFile(second, "utf8")).toBe(original);
      expect(
        (await fs.readdir(root)).filter(
          (name) =>
            name.includes(".config-") && !isTransactionLockArtifact(name),
        ),
      ).toEqual([]);
    } finally {
      writer.mockRestore();
    }
  },
);

test("configuration staging and commit use the same canonical target spelling", async () => {
  const { file } = await fixture();
  const { target } = await configWriteTarget(file);
  expect(target).toBe(fsSync.realpathSync(file));
  expect(() => assertConfigWriteTarget(file, target)).not.toThrow();
  await writeConfigSource(file, "version = 2\n# committed\n");
  expect(await fs.readFile(file, "utf8")).toContain("# committed");
});

test("missing and broken configuration targets fail safely without staging bytes", async () => {
  const { root, file } = await fixture();
  const missing = path.join(root, "missing.toml");
  const target = await configWriteTarget(missing, true);
  expect(target.target).toBe(
    path.join(fsSync.realpathSync(root), "missing.toml"),
  );
  expect(target.mode).toBe(0o600);
  let called = false;
  withConfigTransaction(missing, () => {
    called = true;
  });
  expect(called).toBe(true);
  await expect(configWriteTarget(missing)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await fs.unlink(file);
  await fs.symlink(missing, file);
  expect(() => withConfigTransaction(file, () => {})).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
});

test("configuration commit preserves filesystem inspection errors and malformed shared guards", async () => {
  const { root, file } = await fixture();
  const actual = fsSync.realpathSync;
  const realpath = spyOn(fsSync, "realpathSync").mockImplementation(((
    ...args: Parameters<typeof fsSync.realpathSync>
  ) => {
    if (String(args[0]) === file)
      throw Object.assign(new Error("canonical lookup denied"), {
        code: "EACCES",
      });
    return actual(...args);
  }) as typeof fsSync.realpathSync);
  try {
    expect(() => withConfigTransaction(file, () => {})).toThrow(
      "canonical lookup denied",
    );
  } finally {
    realpath.mockRestore();
  }
  const missing = path.join(root, "missing.toml");
  const originalLstat = fsSync.lstatSync;
  const lstat = spyOn(fsSync, "lstatSync").mockImplementation(((
    ...args: Parameters<typeof fsSync.lstatSync>
  ) => {
    if (String(args[0]) === missing)
      throw Object.assign(new Error("link inspection denied"), {
        code: "EACCES",
      });
    return originalLstat(...args);
  }) as typeof fsSync.lstatSync);
  try {
    expect(() => withConfigTransaction(missing, () => {})).toThrow(
      "link inspection denied",
    );
  } finally {
    lstat.mockRestore();
  }
  await fs.writeFile(file + ".config-commit.sqlite", "invalid database", {
    mode: 0o600,
  });
  expect(() => withConfigTransaction(file, () => {})).toThrow();
  expect(await fs.readFile(file, "utf8")).toBe("version = 2\n");
});

test("shared configuration transactions exclude a different private namespace", async () => {
  const { root, file } = await fixture();
  const owner = acquireTransactionLockSync(
    path.join(root, "different-account"),
    {
      sharedDatabasePath: file + ".config-commit.sqlite",
    },
  );
  let invoked = false;
  try {
    expect(() =>
      withConfigTransaction(file, () => {
        invoked = true;
      }),
    ).toThrow(expect.objectContaining({ code: "configuration_busy" }));
    expect(invoked).toBe(false);
  } finally {
    owner.release();
  }
  withConfigTransaction(file, () => {
    invoked = true;
  });
  expect(invoked).toBe(true);
});

test("configuration targets reject non-files and propagate inspection failures", async () => {
  const { root, file } = await fixture();
  await expect(configWriteTarget(root)).rejects.toThrow("regular file");
  const original = fs.stat;
  const inspect = spyOn(fs, "stat").mockImplementation(((
    ...args: Parameters<typeof fs.stat>
  ) =>
    path.basename(String(args[0])) === path.basename(file)
      ? Promise.reject(
          Object.assign(new Error("metadata denied"), { code: "EACCES" }),
        )
      : original(...args)) as typeof fs.stat);
  try {
    await expect(configWriteTarget(file)).rejects.toThrow("metadata denied");
  } finally {
    inspect.mockRestore();
  }
});

test("configuration commit rejects stale source and removes prepared replacement", async () => {
  const { root, file } = await fixture();
  await fs.writeFile(file, "version = 2\n# concurrent update\n");
  await expect(
    writeConfigSource(file, "version = 2\n# stale edit\n", "version = 2\n"),
  ).rejects.toMatchObject({ code: "configuration_conflict", retryable: true });
  expect(await fs.readFile(file, "utf8")).toContain("concurrent update");
  expect(
    (await fs.readdir(root)).filter(
      (name) => name.includes(".config-") && !isTransactionLockArtifact(name),
    ),
  ).toEqual([]);
});
test("persistent approval cannot be overwritten by an in-flight configuration edit", async () => {
  const { root } = await fixture();
  const previous = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
  };
  process.env.XDG_CONFIG_HOME = root;
  process.env.APPDATA = root;
  const file = path.join(root, "ast-mcp", "ast-mcp.toml");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const original = "version = 2\n";
  await fs.writeFile(file, original);
  const decision = {
    canonicalPath: path.join(root, "source.txt"),
    operation: "write" as const,
    policy: "request" as const,
    reason: "test",
    ruleId: "test",
    source: "project" as const,
    specificity: 1,
    symlinks: false,
  };
  const scope = (inputResponses?: unknown) =>
    ({
      context: { sessionId: "config-race", mcpReq: { inputResponses } },
      server: {
        server: { getClientCapabilities: () => ({ elicitation: {} }) },
      },
      tool: "file_write",
    }) as never;
  let responseKey = "";
  try {
    await withApprovalContext(scope(), async () =>
      authorizeRequestedDecision(decision, 1),
    );
  } catch (error) {
    expect(error).toBeInstanceOf(InputRequiredSignal);
    responseKey = Object.keys(
      (error as InputRequiredSignal).result.inputRequests!,
    )[0]!;
  }
  const actual = fs.writeFile;
  const directory = fsSync.realpathSync(path.dirname(file));
  let approved = false;
  const writer = spyOn(fs, "writeFile").mockImplementation(
    async (...args: Parameters<typeof fs.writeFile>) => {
      await actual(...args);
      if (
        path.dirname(String(args[0])) === directory &&
        String(args[0]) !== file &&
        !approved
      ) {
        approved = true;
        await withApprovalContext(
          scope({
            [responseKey]: {
              action: "accept",
              content: { decision: "always_allow" },
            },
          }),
          async () => authorizeRequestedDecision(decision, 1),
        );
      }
    },
  );
  try {
    await expect(
      writeConfigSource(
        file,
        "version = 2\n[telemetry]\nenabled = false\n",
        original,
      ),
    ).rejects.toMatchObject({ code: "configuration_conflict" });
    expect(approved).toBe(true);
    const persisted = await fs.readFile(file, "utf8");
    expect(persisted).toContain("approval-");
    expect(
      (
        Bun.TOML.parse(persisted) as { paths: Array<{ path: string }> }
      ).paths.some((rule) => rule.path === decision.canonicalPath),
    ).toBe(true);
    expect(persisted).not.toContain("[telemetry]");
  } finally {
    writer.mockRestore();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
test("configuration guard fails promptly on contention and releases after callback failure", async () => {
  const { file } = await fixture();
  withConfigTransaction(file, () =>
    expect(() => withConfigTransaction(file, () => {})).toThrow(
      expect.objectContaining({ code: "configuration_busy", retryable: true }),
    ),
  );
  const failure = new Error("commit failed");
  expect(() =>
    withConfigTransaction(file, () => {
      throw failure;
    }),
  ).toThrow(failure);
  expect(withConfigTransaction(file, () => 42)).toBe(42);
  if (process.platform !== "win32")
    expect(
      (await fs.stat(privateLockDatabasePathSync(`${file}.config-commit`)))
        .mode & 0o777,
    ).toBe(0o600);
});
test("configuration commits do not contend with their enclosing file lease", async () => {
  const { file } = await fixture();
  await withFileLocks([file], async () => {
    await writeConfigSource(
      file,
      "version = 2\n# committed under file lease\n",
      "version = 2\n",
    );
  });
  expect(await fs.readFile(file, "utf8")).toContain(
    "committed under file lease",
  );
});

test("configuration ownership recovers immediately after its process is killed", async () => {
  const { file } = await fixture();
  const modulePath = Bun.fileURLToPath(
    new URL("../../src/config/transaction.ts", import.meta.url),
  );
  const script = `import {withConfigTransaction} from ${JSON.stringify(modulePath)}; withConfigTransaction(${JSON.stringify(file)},()=>{console.log("ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Lock owner never became ready")),
          3000,
        );
      }),
    ]);
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    expect(() => withConfigTransaction(file, () => {})).toThrow(
      expect.objectContaining({ code: "configuration_busy" }),
    );
    child.kill("SIGKILL");
    await child.exited;
    expect(withConfigTransaction(file, () => true)).toBe(true);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await reader.cancel().catch(() => undefined);
    await child.exited;
  }
});
test("migration backup and replacement use one guarded source version", async () => {
  const original = "version = 1\n";
  const { file } = await fixture(original);
  const migration = migrateConfigSource(original, file);
  await fs.writeFile(file, original + "# changed\n");
  await expect(
    writeMigratedConfig(file, migration.source, true, original),
  ).rejects.toMatchObject({ code: "configuration_conflict" });
  expect(await Bun.file(file + ".v1.bak").exists()).toBe(false);
  await fs.writeFile(file, original);
  expect(
    await writeMigratedConfig(file, migration.source, true, original),
  ).toBe(file + ".v1.bak");
  expect(await fs.readFile(file + ".v1.bak", "utf8")).toBe(original);
  expect(await fs.readFile(file, "utf8")).toBe(migration.source);
});

test.skipIf(process.platform === "win32")(
  "persistent approval preserves symlink targets and mode and rejects staging races",
  async () => {
    for (const scenario of [
      "commit",
      "retarget",
      "source-change",
      "dangling",
    ] as const) {
      const { root } = await fixture();
      const previous = {
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        APPDATA: process.env.APPDATA,
      };
      process.env.XDG_CONFIG_HOME = root;
      process.env.APPDATA = root;
      const file = path.join(root, "ast-mcp", "ast-mcp.toml");
      const directory = path.join(root, "physical");
      const target = path.join(directory, "shared.toml");
      const other = path.join(directory, "other.toml");
      const original = "version = 2\n";
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.mkdir(directory);
      await fs.writeFile(target, original);
      await fs.writeFile(other, original);
      await fs.chmod(target, 0o640);
      await fs.symlink("../physical/shared.toml", file);
      const decision = {
        canonicalPath: path.join(root, "approved.txt"),
        operation: "write" as const,
        policy: "request" as const,
        reason: "test",
        ruleId: "symlink-test",
        source: "project" as const,
        specificity: 1,
        symlinks: false,
      };
      const scope = (inputResponses?: unknown) =>
        ({
          context: {
            sessionId: "approval-symlink-" + root,
            mcpReq: { inputResponses },
          },
          server: {
            server: { getClientCapabilities: () => ({ elicitation: {} }) },
          },
          tool: "file_write",
        }) as never;
      let responseKey = "";
      let staged = "";
      let writer:
        | ReturnType<typeof spyOn<typeof fsSync, "writeFileSync">>
        | undefined;
      const previousUmask = process.umask();
      try {
        try {
          await withApprovalContext(scope(), async () =>
            authorizeRequestedDecision(decision, 1),
          );
        } catch (error) {
          expect(error).toBeInstanceOf(InputRequiredSignal);
          responseKey = Object.keys(
            (error as InputRequiredSignal).result.inputRequests!,
          )[0]!;
        }
        expect(responseKey.length).toBeGreaterThan(0);
        const actual = fsSync.writeFileSync;
        writer = spyOn(fsSync, "writeFileSync").mockImplementation(
          (...args: Parameters<typeof fsSync.writeFileSync>) => {
            actual(...args);
            if (!String(args[0]).includes(".approval-")) return;
            staged = String(args[0]);
            if (scenario === "retarget") {
              fsSync.unlinkSync(file);
              fsSync.symlinkSync(other, file);
            } else if (scenario === "source-change") {
              actual(target, original + "# concurrent update\n");
            }
          },
        );
        if (scenario === "dangling") await fs.unlink(target);
        process.umask(0o077);
        const accepting = withApprovalContext(
          scope({
            [responseKey]: {
              action: "accept",
              content: { decision: "always_allow" },
            },
          }),
          async () => authorizeRequestedDecision(decision, 1),
        );
        if (scenario === "commit") {
          expect(await accepting).toBe(true);
          expect(await fs.readlink(file)).toBe("../physical/shared.toml");
          expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
          expect(
            (
              Bun.TOML.parse(await fs.readFile(target, "utf8")) as {
                paths: Array<{ path: string }>;
              }
            ).paths,
          ).toContainEqual(
            expect.objectContaining({ path: decision.canonicalPath }),
          );
        } else {
          await expect(accepting).rejects.toMatchObject({
            code:
              scenario === "retarget"
                ? "configuration_conflict"
                : scenario === "source-change"
                  ? "approval_persistence_conflict"
                  : "ENOENT",
          });
          if (scenario !== "dangling") {
            expect(await fs.readFile(target, "utf8")).toBe(
              scenario === "source-change"
                ? original + "# concurrent update\n"
                : original,
            );
          }
        }
        expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(other, "utf8")).toBe(original);
        if (scenario === "dangling") expect(staged).toBe("");
        else expect(path.dirname(staged)).toBe(fsSync.realpathSync(directory));
        expect(
          (await fs.readdir(directory)).filter((name) =>
            name.includes(".approval-"),
          ),
        ).toEqual([]);
      } finally {
        process.umask(previousUmask);
        writer?.mockRestore();
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }
  },
);

import { expect, spyOn, test } from "bun:test";
import * as fsSync from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { privateLockDatabasePath } from "../../src/runtime/private-lock-directory.ts";
import {
  acquireTransactionLock,
  acquireTransactionLockSync,
  isTransactionLockArtifact,
} from "../../src/runtime/transaction-lock.ts";

test("shared guards exclude different logical namespaces and preserve owner locks after local contention", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-shared-guard-"));
  const sharedDatabasePath = path.join(root, "shared.sqlite");
  const identity = path.join(root, "first-account");
  const other = path.join(root, "second-account");
  const owner = await acquireTransactionLock(identity, { sharedDatabasePath });
  const modulePath = Bun.fileURLToPath(
    new URL("../../src/runtime/transaction-lock.ts", import.meta.url),
  );
  try {
    await expect(
      acquireTransactionLock(other, {
        sharedDatabasePath,
        deadline: Date.now() + 25,
      }),
    ).rejects.toMatchObject({ code: "lock_deadline" });
    expect(() =>
      acquireTransactionLockSync(other, { sharedDatabasePath }),
    ).toThrow("already held");
    const privateOnly = acquireTransactionLockSync(other);
    privateOnly.release();
    const abort = new AbortController();
    const waiting = acquireTransactionLock(other, {
      sharedDatabasePath,
      signal: abort.signal,
      pollMs: 1000,
    });
    const abortTimer = setTimeout(() => abort.abort(), 20);
    try {
      await expect(waiting).rejects.toMatchObject({ code: "lock_aborted" });
    } finally {
      clearTimeout(abortTimer);
    }
    // Independent SQLite proves local failed attempts did not release POSIX process locks.
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        "import { acquireTransactionLock } from " +
          JSON.stringify(modulePath) +
          ";" +
          "import { systemAccount } from " +
          JSON.stringify(
            Bun.fileURLToPath(
              new URL(
                "../../src/runtime/private-lock-directory.ts",
                import.meta.url,
              ),
            ),
          ) +
          "; await systemAccount();" +
          "try { const lock = await acquireTransactionLock(" +
          JSON.stringify(path.join(root, "third-account")) +
          ", {sharedDatabasePath:" +
          JSON.stringify(sharedDatabasePath) +
          ",deadline:Date.now()+500}); lock.release(); console.log('unexpected'); }" +
          "catch(error) { console.log(error.code); }",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const childTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    let code: number, output: string, errors: string;
    try {
      [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
    } finally {
      clearTimeout(childTimer);
      child.kill("SIGKILL");
      await child.exited;
    }
    expect(code).toBe(0);
    expect(errors).toBe("");
    expect(output.trim()).toBe("lock_deadline");
    owner.fence();
  } finally {
    owner.release();
    owner.release();
  }
  try {
    const next = acquireTransactionLockSync(other, { sharedDatabasePath });
    next.fence();
    next.release();
    next.release();
    expect(() => next.fence()).toThrow("ownership was lost");
    const firstAgain = acquireTransactionLockSync(identity, {
      sharedDatabasePath,
    });
    firstAgain.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("shared transaction guards reject unsafe paths and release their private ownership on failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-unsafe-guard-"));
  const identity = path.join(root, "identity");
  const target = path.join(root, "guard.sqlite");
  try {
    await expect(
      acquireTransactionLock(identity, {
        sharedDatabasePath: "relative.sqlite",
      }),
    ).rejects.toMatchObject({ code: "lock_database_unsafe" });
    await expect(
      acquireTransactionLock(identity, {
        sharedDatabasePath: path.join(root, "absent", "guard"),
      }),
    ).rejects.toMatchObject({ code: "lock_database_unsafe" });
    await mkdir(target);
    await expect(
      acquireTransactionLock(identity, { sharedDatabasePath: target }),
    ).rejects.toMatchObject({ code: "lock_database_unsafe" });
    await rm(target, { recursive: true });
    const victim = path.join(root, "victim");
    await writeFile(victim, "unchanged", { mode: 0o600 });
    await symlink(victim, target);
    await expect(
      acquireTransactionLock(identity, { sharedDatabasePath: target }),
    ).rejects.toMatchObject({ code: "lock_database_unsafe" });
    await rm(target);
    await link(victim, target);
    expect(() =>
      acquireTransactionLockSync(identity, { sharedDatabasePath: target }),
    ).toThrow("private regular file");
    await rm(target);
    expect(await Bun.file(victim).text()).toBe("unchanged");
    if (process.platform !== "win32") {
      await writeFile(target, "", { mode: 0o644 });
      await expect(
        acquireTransactionLock(identity, { sharedDatabasePath: target }),
      ).rejects.toMatchObject({ code: "lock_database_unsafe" });
      await rm(target);
    }
    const healthy = acquireTransactionLockSync(identity, {
      sharedDatabasePath: target,
    });
    healthy.release();
    const aborted = new AbortController();
    aborted.abort();
    expect(() =>
      acquireTransactionLockSync(identity, { signal: aborted.signal }),
    ).toThrow("cancelled");
    expect(() =>
      acquireTransactionLockSync(identity, { sharedDatabasePath: "relative" }),
    ).toThrow("private regular file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transaction fences detect replacement and removal of live shared databases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-replaced-guard-"));
  const sharedDatabasePath = path.join(root, "shared.sqlite");
  const owner = await acquireTransactionLock(path.join(root, "identity"), {
    sharedDatabasePath,
  });
  try {
    try {
      await rename(sharedDatabasePath, path.join(root, "original"));
    } catch (cause) {
      if (process.platform !== "win32") throw cause;
      expect(["EPERM", "EACCES", "EBUSY"]).toContain(
        (cause as NodeJS.ErrnoException).code ?? "",
      );
      owner.fence();
      return;
    }
    await writeFile(sharedDatabasePath, "", { mode: 0o600 });
    expect(() => owner.fence()).toThrow("private regular file");
    await rm(sharedDatabasePath);
    expect(() => owner.fence()).toThrow("private regular file");
  } finally {
    owner.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("transaction fences preserve inode differences above the JavaScript integer range", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-big-inode-"));
  const sharedDatabasePath = path.join(root, "shared.sqlite");
  const originalOpen = fsSync.openSync;
  const originalLstat = fsSync.lstatSync;
  const originalFstat = fsSync.fstatSync;
  let descriptor: number | undefined;
  let changed = false;
  const originalInode = 9_007_199_254_740_992n;
  expect(Number(originalInode)).toBe(Number(originalInode + 1n));
  const open = spyOn(fsSync, "openSync").mockImplementation(((
    ...args: Parameters<typeof fsSync.openSync>
  ) => {
    const result = originalOpen(...args);
    if (String(args[0]) === sharedDatabasePath) descriptor = result;
    return result;
  }) as typeof fsSync.openSync);
  const lstat = spyOn(fsSync, "lstatSync").mockImplementation(((
    ...args: Parameters<typeof fsSync.lstatSync>
  ) => {
    const metadata = originalLstat(...args);
    if (
      String(args[0]) === sharedDatabasePath &&
      typeof metadata?.ino === "bigint"
    )
      return Object.assign(Object.create(metadata), {
        ino: originalInode + (changed ? 1n : 0n),
      });
    return metadata;
  }) as typeof fsSync.lstatSync);
  const fstat = spyOn(fsSync, "fstatSync").mockImplementation(((
    ...args: Parameters<typeof fsSync.fstatSync>
  ) => {
    const metadata = originalFstat(...args);
    if (args[0] === descriptor && typeof metadata.ino === "bigint")
      return Object.assign(Object.create(metadata), { ino: originalInode });
    return metadata;
  }) as typeof fsSync.fstatSync);
  let owner: ReturnType<typeof acquireTransactionLockSync> | undefined;
  try {
    owner = acquireTransactionLockSync(path.join(root, "identity"), {
      sharedDatabasePath,
    });
    owner.fence();
    changed = true;
    expect(() => owner!.fence()).toThrow("private regular file");
  } finally {
    fstat.mockRestore();
    lstat.mockRestore();
    open.mockRestore();
    owner?.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("independent guard descriptors close while an unrelated owner remains active", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-guard-close-"));
  const owner = acquireTransactionLockSync(path.join(root, "first"));
  const second = acquireTransactionLockSync(path.join(root, "second"), {
    sharedDatabasePath: path.join(root, "shared.sqlite"),
  });
  const close = spyOn(fsSync, "closeSync");
  try {
    second.release();
    expect(close.mock.calls.length).toBe(2);
    owner.fence();
  } finally {
    close.mockRestore();
    second.release();
    owner.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown guard descriptors remain bounded and drain after the live owner releases", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-guard-quarantine-"),
  );
  const owner = acquireTransactionLockSync(path.join(root, "owner"));
  const originalOpen = fsSync.openSync;
  const originalStat = fsSync.fstatSync;
  const poisoned = new Set<number>();
  const open = spyOn(fsSync, "openSync").mockImplementation(((
    ...args: Parameters<typeof fsSync.openSync>
  ) => {
    const descriptor = originalOpen(...args);
    if (String(args[0]).endsWith(".unknown")) poisoned.add(descriptor);
    return descriptor;
  }) as typeof fsSync.openSync);
  const stat = spyOn(fsSync, "fstatSync").mockImplementation(((
    ...args: Parameters<typeof fsSync.fstatSync>
  ) => {
    if (poisoned.has(args[0]))
      throw Object.assign(new Error("inode metadata unavailable"), {
        code: "EIO",
      });
    return originalStat(...args);
  }) as typeof fsSync.fstatSync);
  const close = spyOn(fsSync, "closeSync");
  try {
    for (let index = 0; index < 64; index++)
      expect(() =>
        acquireTransactionLockSync(path.join(root, "identity-" + index), {
          sharedDatabasePath: path.join(root, index + ".unknown"),
        }),
      ).toThrow("private regular file");
    expect(poisoned.size).toBe(64);
    expect(close.mock.calls.filter(([fd]) => poisoned.has(fd))).toHaveLength(0);
    expect(() =>
      acquireTransactionLockSync(path.join(root, "overflow")),
    ).toThrow("private regular file");
    expect(poisoned.size).toBe(64);
    owner.fence();
    owner.release();
    expect(close.mock.calls.filter(([fd]) => poisoned.has(fd))).toHaveLength(
      64,
    );
  } finally {
    close.mockRestore();
    stat.mockRestore();
    open.mockRestore();
    owner.release();
    await rm(root, { recursive: true, force: true });
  }
  const next = acquireTransactionLockSync(path.join(root, "after-quarantine"));
  next.release();
});

test("coordination artifacts are exact reserved SQLite names and sidecars", () => {
  for (const name of [
    "entry.ts.ast-mcp.lock.sqlite",
    ".ast-mcp-checkout.lock.sqlite",
    ".ast-mcp-storage-writer.sqlite",
    ".ast-mcp-export.lock.sqlite",
    "ast-mcp.toml.config-commit.sqlite",
  ])
    for (const suffix of ["", "-journal", "-wal", "-shm"])
      expect(
        isTransactionLockArtifact(path.join("nested", name + suffix)),
      ).toBe(true);
  const token = "91bf6f61-b502-47d9-875c-55b936821dda";
  for (const name of [
    ".entry.ts.ast-mcp.lock",
    ".gitignore.ast-mcp.lock",
    ".0123456789abcdef01234567.ast-mcp.lock",
  ]) {
    for (const suffix of ["", ".pending-" + token, ".stale-" + token])
      expect(
        isTransactionLockArtifact(path.join("nested", name + suffix)),
      ).toBe(true);
  }
  for (const name of [
    ".ENTRY.TS.AST-MCP.LOCK",
    ".ENTRY.TS.AST-MCP.LOCK.PENDING-" + token.toUpperCase(),
    ".ENTRY.TS.AST-MCP.LOCK.STALE-" + token.toUpperCase(),
  ])
    expect(isTransactionLockArtifact(name)).toBe(
      process.platform === "win32" || process.platform === "darwin",
    );
  for (const directory of [
    ".ast-mcp-mutation-locks",
    ".ast-mcp-locks",
    ".git/ast-mcp-locks",
  ]) {
    expect(isTransactionLockArtifact(path.join("nested", directory))).toBe(
      true,
    );
    expect(
      isTransactionLockArtifact(path.join("nested", directory, "guard.sqlite")),
    ).toBe(true);
  }
  expect(isTransactionLockArtifact("entry.ts.AST-MCP.LOCK.SQLITE-WAL")).toBe(
    process.platform === "win32" || process.platform === "darwin",
  );
  for (const name of [
    "ast-mcp-locks/ordinary.ts",
    "nested/ast-mcp-locks/ordinary.ts",
    ".ast-mcp.locknotes.ts",
    "other.sqlite",
    "entry.ts.ast-mcp.lock",
    ".ast-mcp.lock",
    ".entry.ts.ast-mcp.lock.ts",
    ".entry.ts.ast-mcp.lock.pending-",
    ".entry.ts.ast-mcp.lock.pending-not-a-uuid",
    ".entry.ts.ast-mcp.lock.stale-not-a-uuid",
    ".entry.ts.ast-mcp.lock.stale-" + token + ".ts",
    ".ast-mcp-checkout.lock.sqlite.ts",
  ])
    expect(isTransactionLockArtifact(name)).toBe(false);
});

test("artifact scopes preserve Git guards when the root is metadata", () => {
  const root = path.resolve("fixture", ".git");
  const guardRoot = path.join(root, "ast-mcp-locks");
  const guard = path.join(guardRoot, "owner.sqlite");
  expect(isTransactionLockArtifact(guard, root)).toBe(true);
  expect(isTransactionLockArtifact(guard, guardRoot)).toBe(true);
  for (const ancestor of [
    ".ast-mcp-locks",
    ".ast-mcp-mutation-locks",
    "ast-mcp-locks",
  ]) {
    const project = path.resolve("fixture", ancestor, "project");
    expect(
      isTransactionLockArtifact(path.join(project, "ordinary.ts"), project),
    ).toBe(false);
    expect(
      isTransactionLockArtifact(
        path.join(project, ".ast-mcp-locks", "owner.sqlite"),
        project,
      ),
    ).toBe(true);
  }
});

test("transaction locks bound waits, honor cancellation, and release idempotently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-os-lock-"));
  const database = path.join(root, "guard.sqlite");
  const owner = await acquireTransactionLock(database);
  try {
    await expect(
      acquireTransactionLock(database, { deadline: Date.now() + 20 }),
    ).rejects.toMatchObject({ code: "lock_deadline" });
    await expect(
      acquireTransactionLock(database, { tryOnly: true }),
    ).rejects.toMatchObject({ code: "lock_busy", retryable: true });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      acquireTransactionLock(database, { signal: preAborted.signal }),
    ).rejects.toMatchObject({ code: "lock_aborted" });
    await expect(
      acquireTransactionLock(database, { deadline: new Date(Date.now() - 1) }),
    ).rejects.toMatchObject({ code: "lock_deadline" });
    const abort = new AbortController();
    const pending = acquireTransactionLock(database, {
      signal: abort.signal,
      pollMs: 1000,
    });
    const timer = setTimeout(() => abort.abort(), 20);
    try {
      await expect(pending).rejects.toMatchObject({ code: "lock_aborted" });
    } finally {
      clearTimeout(timer);
    }
    owner.fence();
    owner.release();
    owner.release();
    expect(() => owner.fence()).toThrow("ownership was lost");
    const next = await acquireTransactionLock(database);
    next.fence();
    next.release();
  } finally {
    owner.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed lock databases fail immediately without retrying or changing bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-invalid-lock-"));
  const identity = path.join(root, "target");
  const database = await privateLockDatabasePath(identity);
  const invalid = "not a SQLite database";
  try {
    await writeFile(database, invalid);
    await expect(acquireTransactionLock(identity)).rejects.toMatchObject({
      code: "SQLITE_NOTADB",
    });
    expect(await Bun.file(database).text()).toBe(invalid);
  } finally {
    await rm(database, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("the operating system releases a crashed process transaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-os-crash-"));
  const database = path.join(root, "guard.sqlite");
  const modulePath = Bun.fileURLToPath(
    new URL("../../src/runtime/transaction-lock.ts", import.meta.url),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { acquireTransactionLock } from ${JSON.stringify(modulePath)};
    const lock = await acquireTransactionLock(${JSON.stringify(database)});
    console.log("ready");
    await Bun.sleep(60_000);
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value).trim()).toBe("ready");
    await expect(
      acquireTransactionLock(database, { deadline: Date.now() + 20 }),
    ).rejects.toMatchObject({ code: "lock_deadline" });
    child.kill("SIGKILL");
    await child.exited;
    const successor = await acquireTransactionLock(database, {
      deadline: Date.now() + 1_000,
    });
    successor.fence();
    successor.release();
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

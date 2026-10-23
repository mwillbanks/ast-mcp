import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { privateLockDatabasePath } from "../../src/runtime/private-lock-directory.ts";
import { acquireTransactionLock } from "../../src/runtime/transaction-lock.ts";

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
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
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
});

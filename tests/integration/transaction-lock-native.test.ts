import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireTransactionLock,
  acquireTransactionLockSync,
} from "../../src/runtime/transaction-lock.ts";
test("independent processes retain shared exclusion after failed local guard attempts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-shared-native-"));
  const sharedDatabasePath = path.join(root, "shared.sqlite");
  const identity = path.join(root, "first-account");
  const other = path.join(root, "second-account");
  const owner = await acquireTransactionLock(identity, { sharedDatabasePath });
  const modulePath = Bun.fileURLToPath(
    new URL("../../src/runtime/transaction-lock.ts", import.meta.url),
  );
  try {
    await expect(
      acquireTransactionLock(other, { sharedDatabasePath, tryOnly: true }),
    ).rejects.toMatchObject({ code: "lock_busy" });
    expect(() =>
      acquireTransactionLockSync(other, { sharedDatabasePath }),
    ).toThrow("already held");
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
          ",tryOnly:true}); lock.release(); console.log('unexpected'); }" +
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
    expect(output.trim()).toBe("lock_busy");
    owner.fence();
  } finally {
    owner.release();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

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
    await new Promise(resolve => process.stdin.once("data", resolve));
  `,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value).trim()).toBe("ready");
    await expect(
      acquireTransactionLock(database, { tryOnly: true }),
    ).rejects.toMatchObject({ code: "lock_busy" });
    child.kill("SIGKILL");
    await child.exited;
    const successor = await acquireTransactionLock(database, {
      tryOnly: true,
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

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { acquireFileLock } from "../../../src/intelligence/mutation/locks.ts";

test("crashed file owners are recovered before their metadata expires", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-file-crash-"));
  const target = path.join(root, "target");
  const modulePath = Bun.fileURLToPath(
    new URL("../../../src/intelligence/mutation/locks.ts", import.meta.url),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { acquireFileLock } from ${JSON.stringify(modulePath)};
    await acquireFileLock(${JSON.stringify(target)}, { leaseMs: 60_000 });
    console.log("ready");
    await Bun.sleep(60_000);
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value).trim()).toBe("ready");
    child.kill("SIGKILL");
    await child.exited;
    const successor = await acquireFileLock(target, {
      deadline: Date.now() + 1000,
    });
    try {
      expect(successor.epoch).toBeGreaterThan(1);
      await successor.fence();
    } finally {
      await successor.release();
    }
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import path from "node:path";

import { PROCESS_SIGNALS } from "../src/runtime/signals";

test.skipIf(process.platform === "win32")(
  "SIGTERM, SIGINT, and SIGHUP invoke graceful shutdown",
  async () => {
    for (const signal of PROCESS_SIGNALS) {
      const processHandle = Bun.spawn(
        [process.execPath, path.resolve(import.meta.dir, "signal-fixture.ts")],
        {
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const reader = processHandle.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("ready");

      processHandle.kill(signal);

      const [exitCode, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain(`closed:${signal}`);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a second signal forces shutdown while cleanup is pending",
  async () => {
    const processHandle = Bun.spawn(
      [process.execPath, path.resolve(import.meta.dir, "signal-fixture.ts")],
      {
        env: { ...process.env, AST_MCP_TEST_PENDING_SHUTDOWN: "1" },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const reader = processHandle.stdout.getReader();
    await reader.read();
    reader.releaseLock();

    processHandle.kill("SIGTERM");
    const stderr = processHandle.stderr.getReader();
    const closing = await stderr.read();
    stderr.releaseLock();
    expect(new TextDecoder().decode(closing.value)).toContain("closed:SIGTERM");
    processHandle.kill("SIGINT");

    expect(await processHandle.exited).toBe(1);
  },
);

import { expect, test } from "bun:test";

import { runCommandInput } from "../../src/runtime/process-input";

test("command timeout stops a slow leader on every platform", async () => {
  await expect(
    runCommandInput(process.execPath, ["-e", "await Bun.sleep(800)"], "", {
      timeoutMs: 100,
    }),
  ).rejects.toThrow("timed out after 100ms");
});

test("early command exit reports failure without an uncaught stdin EPIPE", async () => {
  await expect(
    runCommandInput(
      process.execPath,
      ["-e", "process.exit(1)"],
      "input".repeat(200_000),
    ),
  ).rejects.toThrow("failed");
});

test("completed command clears its timeout before the caller exits", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'import { runCommandInput } from "./src/runtime/process-input.ts"; await runCommandInput(process.execPath, ["-e", "process.exit(0)"], "", { timeoutMs: 30_000 });',
    ],
    { cwd: process.cwd(), stderr: "pipe", stdout: "ignore" },
  );
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 8_000);
  try {
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    expect(timedOut, stderr).toBe(false);
    expect(exitCode, stderr).toBe(0);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) {
      child.kill(9);
      await child.exited;
    }
  }
}, 10_000);

test.skipIf(process.platform === "win32")(
  "POSIX command timeout includes inherited output pipes after the leader exits",
  async () => {
    const script = `Bun.spawn([process.execPath, "-e", "await Bun.sleep(800)"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }); process.exit(0)`;
    const start = performance.now();
    await expect(
      runCommandInput(process.execPath, ["-e", script], "", { timeoutMs: 100 }),
    ).rejects.toThrow("timed out after 100ms");
    expect(performance.now() - start).toBeLessThan(700);
  },
);

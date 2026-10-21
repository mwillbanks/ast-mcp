import { expect, test } from "bun:test";
import path from "node:path";

import { PROCESS_SIGNALS } from "../../src/runtime/signals";

for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  test(`${event} exits nonzero after starting cleanup without other handles`, async () => {
    const trigger =
      event === "uncaughtException"
        ? 'throw new Error("fatal deadline probe")'
        : 'void Promise.reject(new Error("fatal deadline probe"))';
    const processHandle = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { installProcessFailureHandlers } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/runtime/signals.ts"))};
installProcessFailureHandlers(() => { process.stderr.write("cleanup started\\n"); return new Promise(() => {}); }, process, 50);
setTimeout(() => { ${trigger}; }, 1);`,
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stderr, stdout] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
      new Response(processHandle.stdout).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`fatal ${event}: fatal deadline probe`);
    expect(stderr).toContain("cleanup started");
    if (event === "uncaughtException") {
      expect(stderr).toContain("fatal shutdown timed out");
    }
    expect(stdout).toBe("");
  });
}

test("fatal rejection completes cleanup that starts asynchronous IO", async () => {
  const processHandle = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { readFile } from "node:fs/promises";
import { installProcessFailureHandlers } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/runtime/signals.ts"))};
const keepAlive = setTimeout(() => {}, 1000);
installProcessFailureHandlers(async () => {
  clearTimeout(keepAlive);
  await readFile(${JSON.stringify(path.resolve(import.meta.dir, "../../package.json"))});
  process.stderr.write("async cleanup completed\\n");
}, process, 500);
setTimeout(() => void Promise.reject(new Error("async probe")), 1);`,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stderr).text(),
  ]);
  expect(exitCode).toBe(1);
  expect(stderr).toContain("async cleanup completed");
  expect(stderr).not.toContain("timed out");
});

test.skipIf(process.platform === "win32")(
  "a signal keeps the cleanup deadline alive without other handles",
  async () => {
    const processHandle = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { installProcessSignalHandlers } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/runtime/signals.ts"))};
installProcessSignalHandlers(() => new Promise(() => {}), process, 50);
setTimeout(() => process.emit("SIGTERM"), 1);`,
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("shutdown timed out after SIGTERM");
  },
);

test.skipIf(process.platform === "win32")(
  "SIGTERM, SIGINT, and SIGHUP invoke graceful shutdown",
  async () => {
    for (const signal of PROCESS_SIGNALS) {
      const processHandle = Bun.spawn(
        [
          process.execPath,
          path.resolve(import.meta.dir, "../support/signal-fixture.ts"),
        ],
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
      [
        process.execPath,
        path.resolve(import.meta.dir, "../support/signal-fixture.ts"),
      ],
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

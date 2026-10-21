import { expect, test } from "bun:test";

import { spawnHttpMcpProcess, spawnLiveProcess } from "../support/live-process";

test("live process captures both streams and supports repeated teardown", async () => {
  const live = spawnLiveProcess(process.execPath, [
    "-e",
    'console.log("ready");console.error("fixture warning");await Bun.sleep(8_000)',
  ]);
  try {
    expect(await live.readStdoutLine()).toBe("ready");
    await live.waitForStderr(/fixture warning/);
    expect(live.diagnostics()).toContain("stdout:\nready");
    expect(live.diagnostics()).toContain("stderr:\nfixture warning");
  } finally {
    await live.stop();
    await live.stop();
  }
});

test("live process reports bounded waiting and premature exit diagnostics", async () => {
  const silent = spawnLiveProcess(process.execPath, [
    "-e",
    "await Bun.sleep(8_000)",
  ]);
  try {
    expect(silent.diagnostics()).toBe("no process output");
    await expect(silent.readStdoutLine(25)).rejects.toThrow(
      "timed out after 25ms",
    );
  } finally {
    await silent.stop();
  }
  const exited = spawnLiveProcess(process.execPath, [
    "-e",
    'console.error("startup failed");process.exit(7)',
  ]);
  try {
    expect(await exited.waitForExit()).toBe(7);
    await expect(exited.readStdoutLine()).rejects.toThrow(
      "process exited with code 7",
    );
    expect(exited.diagnostics()).toContain("startup failed");
  } finally {
    await exited.stop();
  }
});

test("HTTP startup failure closes the process and preserves diagnostics", async () => {
  await expect(
    spawnHttpMcpProcess(
      process.execPath,
      ["-e", 'console.error("startup failed");process.exit(7)', "--"],
      { host: false },
    ),
  ).rejects.toThrow("startup failed");
});

test.skipIf(process.platform === "win32")(
  "live teardown kills descendants holding inherited pipes",
  async () => {
    const script =
      'const child=Bun.spawn([process.execPath,"-e",\'process.on("SIGTERM",()=>{});await Bun.sleep(8_000)\'],{stdout:"inherit",stderr:"inherit",stdin:"ignore"});console.log(child.pid);child.unref();process.exit(0)';
    const live = spawnLiveProcess(process.execPath, ["-e", script]);
    let descendant: number | undefined;
    try {
      descendant = Number(await live.readStdoutLine());
      expect(await live.waitForExit()).toBe(0);
      await live.stop();
      expect(descendant).toBeGreaterThan(0);
      if (process.platform === "linux") {
        // Linux can retain killed orphans as zombies until init reaps them.
        const status = await Bun.file(`/proc/${descendant}/status`)
          .text()
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT" || error.code === "ESRCH") return null;
            throw error;
          });
        let stopped = status === null || /^State:\s+Z\b/mu.test(status);
        for (let attempt = 0; attempt < 100 && !stopped; attempt++) {
          await Bun.sleep(20);
          const current = await Bun.file(`/proc/${descendant}/status`)
            .text()
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT" || error.code === "ESRCH")
                return null;
              throw error;
            });
          stopped = current === null || /^State:\s+Z\b/mu.test(current);
        }
        expect(stopped).toBeTrue();
      } else {
        expect(() => process.kill(descendant!, 0)).toThrow();
      }
    } finally {
      if (descendant) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {}
      }
      await live.stop();
    }
  },
  10_000,
);

test.skipIf(process.platform === "win32")(
  "live teardown reports escaped descendants that keep pipes open",
  async () => {
    const script =
      'const child=Bun.spawn([process.execPath,"-e","await Bun.sleep(8_000)"],{detached:true,stdout:"inherit",stderr:"inherit",stdin:"ignore"});console.log(child.pid);child.unref();process.exit(0)';
    const live = spawnLiveProcess(process.execPath, ["-e", script]);
    let descendant: number | undefined;
    try {
      descendant = Number(await live.readStdoutLine());
      expect(await live.waitForExit()).toBe(0);
      await expect(live.stop()).rejects.toThrow(
        "Process pipes did not close after teardown",
      );
    } finally {
      if (descendant) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {}
      }
    }
  },
  7_000,
);

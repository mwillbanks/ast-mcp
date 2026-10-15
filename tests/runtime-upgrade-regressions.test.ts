import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runComparatorCommand } from "../scripts/provision-intelligence-comparators";
import { runCommandInput } from "../src/runtime/process-input";
import {
  readSubprocessOutput,
  terminateProcessTree,
} from "../src/runtime/subprocess";

test("bounded command runners terminate children that exceed the output limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "ast-mcp-output-limit-"));
  try {
    for (const runner of ["input", "comparator"]) {
      const pidFile = join(root, runner + ".pid");
      const script = `await Bun.write(${JSON.stringify(pidFile)},String(process.pid));process.stdout.on("error",()=>{});process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1));setTimeout(()=>process.exit(0),8_000)`;
      let pid: number | undefined;
      try {
        const completion =
          runner === "input"
            ? runCommandInput(process.execPath, ["-e", script], "", {
                timeoutMs: 5_000,
              })
            : runComparatorCommand([process.execPath, "-e", script], 5_000);
        await expect(completion).rejects.toThrow(
          "command output exceeded 16777216 bytes",
        );
        pid = Number(await readFile(pidFile, "utf8"));
        expect(pid).toBeGreaterThan(0);
        expect(() => process.kill(pid!, 0)).toThrow();
      } finally {
        pid ??= Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("output cancellation releases the reader when stream cleanup rejects", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      throw new Error("fixture cancellation failure");
    },
  });
  const completion = readSubprocessOutput(stream, abort.signal, async () => {
    throw new Error("unexpected overflow");
  });
  abort.abort();
  expect(await completion).toBe("");
  await Bun.sleep(0);
  expect(cancelled).toBeTrue();
  expect(stream.locked).toBeFalse();
});

test("comparator timeout tolerates rejected stderr cancellation", async () => {
  const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(8_000)"], {
    detached: process.platform !== "win32",
    stdout: "pipe",
    stderr: "pipe",
  });
  const originalStderr = child.stderr;
  let cancelled = false;
  const stderr = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      throw new Error("fixture stderr cancellation failure");
    },
  });
  Object.defineProperty(child, "stderr", { value: stderr });
  const invocation = spyOn(Bun, "spawn").mockReturnValue(child);
  try {
    await expect(
      runComparatorCommand(["fixture-comparator"], 25),
    ).rejects.toThrow("timed out after 25ms");
    expect(cancelled).toBeTrue();
    expect(stderr.locked).toBeFalse();
  } finally {
    invocation.mockRestore();
    if (child.exitCode === null) child.kill();
    await child.exited;
    await originalStderr.cancel();
  }
});

test("Windows termination bounds a stalled taskkill helper and its target", async () => {
  const spawn = Bun.spawn.bind(Bun);
  const target = spawn([process.execPath, "-e", "await Bun.sleep(8_000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const helper = spawn([process.execPath, "-e", "await Bun.sleep(8_000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const invocation = spyOn(Bun, "spawn").mockImplementation(() => helper);
  try {
    await terminateProcessTree(target, { platform: "win32", graceMs: 20 });
    expect(invocation).toHaveBeenCalledWith(
      ["taskkill.exe", "/PID", String(target.pid), "/T", "/F"],
      { stderr: "ignore", stdin: "ignore", stdout: "ignore" },
    );
    await Promise.all([target.exited, helper.exited]);
    expect([target.exitCode, target.signalCode]).not.toEqual([null, null]);
    expect([helper.exitCode, helper.signalCode]).not.toEqual([null, null]);
  } finally {
    invocation.mockRestore();
    if (target.exitCode === null) target.kill();
    if (helper.exitCode === null) helper.kill();
    await Promise.all([target.exited, helper.exited]);
  }
});

test("Windows termination stops the target when taskkill cannot start", async () => {
  const target = Bun.spawn([process.execPath, "-e", "await Bun.sleep(8_000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const invocation = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("taskkill unavailable");
  });
  try {
    await terminateProcessTree(target, { platform: "win32", graceMs: 20 });
    await target.exited;
    expect([target.exitCode, target.signalCode]).not.toEqual([null, null]);
  } finally {
    invocation.mockRestore();
    if (target.exitCode === null) target.kill();
    await target.exited;
  }
});

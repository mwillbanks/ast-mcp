import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommandInput } from "../../src/runtime/process-input";
import {
  readSubprocessOutput,
  terminateProcessTree,
} from "../../src/runtime/subprocess";

test("bounded command runners terminate children that exceed the output limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "ast-mcp-output-limit-"));
  const pidFile = join(root, "input.pid");
  const script = `await Bun.write(${JSON.stringify(pidFile)},String(process.pid));process.stdout.on("error",()=>{});process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1));setTimeout(()=>process.exit(0),8_000)`;
  let pid: number | undefined;
  try {
    await expect(
      runCommandInput(process.execPath, ["-e", script], "", {
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      code: "command_invalid_output",
      message:
        "Command output must be valid UTF-8 within the 16777216-byte limit",
    });
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
  await expect(completion).rejects.toBe(abort.signal.reason);
  await Bun.sleep(0);
  expect(cancelled).toBeTrue();
  expect(stream.locked).toBeFalse();
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

import { expect, spyOn, test } from "bun:test";

import { runCommandInput } from "../../src/runtime/process-input";
import { createMockTime, deferred } from "../support/mock-time";

test("command failure retains diagnostics without killing an exited native PID", async () => {
  const time = createMockTime();
  const child = {
    exitCode: 7,
    exited: Promise.resolve(7),
    pid: 12345,
    stdout: new Blob().stream(),
    stderr: new Blob(["original command rejection"]).stream(),
    kill() {},
  };
  let invocations = 0;
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    if (invocations++ === 0) return child as never;
    throw new Error("cleanup helper unavailable");
  });
  const kill = spyOn(child, "kill").mockImplementation(() => {
    throw new Error("cleanup signal rejected");
  });
  const signal = spyOn(process, "kill").mockImplementation(() => {
    throw new Error("cleanup group unavailable");
  });
  try {
    await expect(runCommandInput("fixture-command", [], "")).rejects.toThrow(
      "original command rejection",
    );
    expect(kill).not.toHaveBeenCalled();
    expect(child.exitCode).toBe(7);
  } finally {
    signal.mockRestore();
    kill.mockRestore();
    spawn.mockRestore();
    time.dispose();
  }
});

test("stream failure retains the original error when live process cleanup rejects", async () => {
  const time = createMockTime();
  const completion = deferred<number>();
  const original = new Error("original stderr rejection");
  const child = {
    exitCode: null,
    exited: completion.promise,
    pid: 12345,
    stdout: new Blob().stream(),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(original);
      },
    }),
    kill() {},
  };
  let invocations = 0;
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    if (invocations++ === 0) return child as never;
    throw new Error("cleanup helper unavailable");
  });
  const kill = spyOn(child, "kill").mockImplementation(() => {
    throw new Error("cleanup signal rejected");
  });
  const signal = spyOn(process, "kill").mockImplementation(() => {
    throw new Error("cleanup group unavailable");
  });
  try {
    await expect(runCommandInput("fixture-command", [], "")).rejects.toBe(
      original,
    );
    expect(kill).toHaveBeenCalledTimes(1);
    expect(time.pending()).toBe(0);
  } finally {
    completion.resolve(7);
    signal.mockRestore();
    kill.mockRestore();
    spawn.mockRestore();
    time.dispose();
  }
});

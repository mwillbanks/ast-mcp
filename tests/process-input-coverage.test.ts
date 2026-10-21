import { expect, spyOn, test } from "bun:test";

import { runCommandInput } from "../src/runtime/process-input";

test("command failure retains original diagnostics when process cleanup rejects", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      "console.error('original command rejection');process.exit(7)",
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await child.exited;
  let invocations = 0;
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    if (invocations++ === 0) return child;
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
    expect(kill).toHaveBeenCalled();
    expect(child.exitCode).toBe(7);
  } finally {
    signal.mockRestore();
    kill.mockRestore();
    spawn.mockRestore();
  }
});

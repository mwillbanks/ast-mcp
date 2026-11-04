import { expect, spyOn, test } from "bun:test";

import {
  commandForPlatform,
  terminateProcessTree,
} from "../../src/runtime/subprocess";
import { createMockTime, deferred } from "../support/mock-time";

test("adapts Windows batch commands through ComSpec without unquoted operators", () => {
  expect(
    commandForPlatform(
      String.raw`C:\Program Files\tools & helpers\format.cmd`,
      ["--file", "value & whoami.txt"],
      "win32",
      String.raw`C:\Windows\System32\cmd.exe`,
    ),
  ).toEqual({
    args: [
      "/d",
      "/v:off",
      "/s",
      "/c",
      String.raw`call "C:\Program Files\tools & helpers\format.cmd" --file "value & whoami.txt"`,
    ],
    command: String.raw`C:\Windows\System32\cmd.exe`,
    windowsVerbatimArguments: true,
  });
});

/** Model leader exit independently from signals sent to owned descendants. */
function controlledProcess(initialExitCode: number | null = null) {
  let exitCode = initialExitCode;
  const completion = deferred<number>();
  const finish = (code: number) => {
    exitCode = code;
    completion.resolve(code);
  };
  if (initialExitCode !== null) finish(initialExitCode);
  const kill = spyOn(
    { kill(_signal?: number | NodeJS.Signals) {} },
    "kill",
  ).mockImplementation((signal) => {
    if (signal === "SIGKILL") finish(137);
  });
  return {
    finish,
    kill,
    handle: {
      get exitCode() {
        return exitCode;
      },
      exited: completion.promise,
      kill,
      pid: 12345,
    },
  };
}

test("descendant cleanup preserves the live leader grace deadline", async () => {
  const time = createMockTime();
  const child = controlledProcess();
  const group = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("No mock process group"), { code: "ESRCH" });
  });
  const pending = terminateProcessTree(child.handle, {
    ensureDescendantsExit: true,
    graceMs: 250,
    platform: "linux",
  });
  try {
    await time.advanceBy(249);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(child.handle.exitCode).toBeNull();
    await time.advanceBy(1);
    await pending;
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(time.pending()).toBe(0);
  } finally {
    child.finish(0);
    await pending;
    child.kill.mockRestore();
    group.mockRestore();
    time.dispose();
  }
});

test("descendant cleanup escalates the group after its leader exits gracefully", async () => {
  const time = createMockTime();
  const child = controlledProcess();
  const group = spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === "SIGTERM") child.finish(0);
    return true;
  });
  try {
    await terminateProcessTree(child.handle, {
      ensureDescendantsExit: true,
      graceMs: 250,
      platform: "linux",
    });
    expect(group.mock.calls).toEqual([
      [-12345, "SIGTERM"],
      [-12345, "SIGKILL"],
    ]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(time.pending()).toBe(0);
  } finally {
    child.finish(0);
    child.kill.mockRestore();
    group.mockRestore();
    time.dispose();
  }
});

test("exited leader cleanup remains opt in and never falls back to its native PID", async () => {
  const time = createMockTime();
  const child = controlledProcess(0);
  const group = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("No mock process group"), { code: "ESRCH" });
  });
  try {
    await terminateProcessTree(child.handle, { platform: "linux" });
    expect(group).not.toHaveBeenCalled();
    await terminateProcessTree(child.handle, {
      ensureDescendantsExit: true,
      platform: "linux",
    });
    expect(group.mock.calls).toEqual([[-12345, "SIGKILL"]]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(time.pending()).toBe(0);
  } finally {
    child.kill.mockRestore();
    group.mockRestore();
    time.dispose();
  }
});

test("forced process termination still skips the grace period", async () => {
  const time = createMockTime();
  const child = controlledProcess();
  const group = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("No mock process group"), { code: "ESRCH" });
  });
  try {
    await terminateProcessTree(child.handle, {
      force: true,
      graceMs: 250,
      platform: "linux",
    });
    expect(child.kill.mock.calls).toEqual([["SIGKILL"]]);
    expect(time.pending()).toBe(0);
  } finally {
    child.finish(0);
    child.kill.mockRestore();
    group.mockRestore();
    time.dispose();
  }
});

test("Windows cleanup never targets an already exited leader PID", async () => {
  const time = createMockTime();
  const child = controlledProcess(0);
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("No mock taskkill process");
  });
  try {
    for (const options of [{ force: true }, { ensureDescendantsExit: true }]) {
      await terminateProcessTree(child.handle, {
        ...options,
        graceMs: 250,
        platform: "win32",
      });
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(time.pending()).toBe(0);
  } finally {
    child.kill.mockRestore();
    spawn.mockRestore();
    time.dispose();
  }
});

test("Windows taskkill failure never falls back after its leader exits", async () => {
  const time = createMockTime();
  const child = controlledProcess();
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    child.finish(0);
    throw new Error("Mock taskkill raced with leader exit");
  });
  try {
    await terminateProcessTree(child.handle, {
      ensureDescendantsExit: true,
      graceMs: 250,
      platform: "win32",
    });
    expect(spawn.mock.calls[0]?.[0]).toEqual([
      "taskkill.exe",
      "/PID",
      "12345",
      "/T",
      "/F",
    ]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(time.pending()).toBe(0);
  } finally {
    child.finish(0);
    child.kill.mockRestore();
    spawn.mockRestore();
    time.dispose();
  }
});

test("leaves native executables structured and rejects batch control characters", () => {
  expect(commandForPlatform("formatter.exe", ["a b"], "win32")).toEqual({
    args: ["a b"],
    command: "formatter.exe",
  });
  expect(() =>
    commandForPlatform("formatter.cmd", ["value\nwhoami"], "win32"),
  ).toThrow("quotes, expansion characters, or control characters");
  expect(() =>
    commandForPlatform("formatter.cmd", ['value" & whoami'], "win32"),
  ).toThrow("quotes, expansion characters, or control characters");
  for (const value of ["%PATH%", "!PATH!", "^& whoami"]) {
    expect(() => commandForPlatform("formatter.cmd", [value], "win32")).toThrow(
      "expansion characters",
    );
  }
});

import { expect, test } from "bun:test";
import { runCommandInput } from "../src/runtime/process-input";
import { commandForPlatform } from "../src/runtime/subprocess";

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

test("command timeout includes inherited output pipes after the leader exits", async () => {
  const script = `Bun.spawn([process.execPath, "-e", "await Bun.sleep(800)"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }); process.exit(0)`;
  const start = performance.now();
  await expect(
    runCommandInput(process.execPath, ["-e", script], "", { timeoutMs: 100 }),
  ).rejects.toThrow("timed out after 100ms");
  expect(performance.now() - start).toBeLessThan(700);
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

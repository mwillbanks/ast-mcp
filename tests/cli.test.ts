import { expect, test } from "bun:test";
import { type CliHandlers, getCliHelp, runCli } from "../src/cli";

function harness() {
  const calls: string[][] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const handlers: CliHandlers = {
    hook: async () => {
      calls.push(["hook"]);
      return 17;
    },
    installer: async (args) => {
      calls.push(args);
    },
    mcp: async () => {
      calls.push(["mcp"]);
    },
    stderr: (text) => stderr.push(text),
    stdout: (text) => stdout.push(text),
  };
  return { calls, handlers, stderr, stdout };
}

test("dispatches every command and permits option-free subcommands", async () => {
  const { calls, handlers } = harness();
  expect(await runCli(["mcp"], handlers)).toBeUndefined();
  expect(await runCli(["hook"], handlers)).toBe(17);
  await runCli(["install"], handlers);
  await runCli(["update", "--scope", "local"], handlers);
  await runCli(["uninstall", "--target", "codex"], handlers);

  expect(calls).toEqual([
    ["mcp"],
    ["hook"],
    ["install"],
    ["update", "--scope", "local"],
    ["uninstall", "--target", "codex"],
  ]);
});

test("prints root help for no arguments and help aliases", async () => {
  for (const args of [[], ["--help"], ["-h"]]) {
    const { handlers, stdout } = harness();
    expect(await runCli(args, handlers)).toBe(0);
    expect(stdout).toEqual([getCliHelp()]);
  }
});

test("prints help for every subcommand without dispatching it", async () => {
  for (const command of [
    "install",
    "update",
    "uninstall",
    "mcp",
    "hook",
  ] as const) {
    for (const args of [
      [command, "--help"],
      ["help", command],
    ]) {
      const { calls, handlers, stdout } = harness();
      expect(await runCli(args, handlers)).toBe(0);
      expect(stdout).toEqual([getCliHelp(command)]);
      expect(calls).toEqual([]);
    }
  }
});

test("reports unknown commands and unsupported positional arguments cleanly", async () => {
  for (const args of [["unknown"], ["mcp", "extra"], ["hook", "extra"]]) {
    const { handlers, stderr } = harness();
    expect(await runCli(args, handlers)).toBe(1);
    expect(stderr[0]).toContain("ast-mcp:");
    expect(stderr[0]).toContain("Usage:");
  }
});

test("renders installer parser errors with subcommand help", async () => {
  const { handlers, stderr } = harness();
  handlers.installer = async () => {
    const error = new Error("Missing value for --scope");
    error.name = "InstallerUsageError";
    throw error;
  };

  expect(await runCli(["install", "--scope"], handlers)).toBe(1);
  expect(stderr[0]).toContain("Missing value for --scope");
  expect(stderr[0]).toContain("ast-mcp install [options]");
});

test("CLI executable prints help without a stack trace", () => {
  const result = Bun.spawnSync(["bun", "bin/ast-mcp.ts"], {
    cwd: process.cwd(),
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Usage:");
  expect(result.stderr.toString()).toBe("");
});

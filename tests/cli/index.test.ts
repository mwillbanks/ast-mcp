import { expect, spyOn, test } from "bun:test";

import { type CliHandlers, getCliHelp, runCli } from "../../src/cli";

function harness() {
  const calls: string[][] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const handlers: CliHandlers = {
    config: async (args) => {
      calls.push(["config", ...args]);
    },
    hook: async () => {
      calls.push(["hook"]);
      return 17;
    },
    skills: async (args) => {
      calls.push(["skills", ...args]);
    },
    installer: async (args) => {
      calls.push(args);
    },
    mcp: async (args) => {
      calls.push(["mcp", ...args]);
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
  await runCli(["config", "show", "--root", "."], handlers);
  await runCli(["skills", "export", "destination"], handlers);
  await runCli(["install"], handlers);
  await runCli(["update", "--scope", "local"], handlers);
  await runCli(["uninstall", "--target", "codex"], handlers);

  expect(calls).toEqual([
    ["mcp"],
    ["hook"],
    ["config", "show", "--root", "."],
    ["skills", "export", "destination"],
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
    "config",
    "skills",
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
  expect(getCliHelp("config")).toContain("<validate|show|migrate>");
  expect(getCliHelp("config")).toContain("--no-backup");
});

test("reports unknown commands and unsupported positional arguments cleanly", async () => {
  for (const args of [["unknown"], ["hook", "extra"]]) {
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

test("validates global output flags before command routing or help", async () => {
  const { handlers, calls, stderr } = harness();
  await runCli(["--output", "yaml", "config", "show"], handlers);
  await runCli(["skills", "--output=toml", "export", "dest"], handlers);
  expect(calls).toEqual([
    ["config", "show", "--output", "yaml"],
    ["skills", "export", "dest", "--output", "toml"],
  ]);
  for (const args of [
    ["--output", "invalid", "install"],
    ["config", "show", "--output=json", "--output", "human"],
    ["skills", "export", "dest", "--output"],
    ["install", "--help", "--output=invalid"],
    ["mcp", "--output=json"],
    ["--output", "toml", "hook"],
    ["mcp", "--help", "--output=yaml"],
  ]) {
    const before = calls.length;
    expect(await runCli(args, handlers)).toBe(1);
    expect(calls).toHaveLength(before);
  }
  expect(stderr.join("")).toContain(
    "--output is not supported for protocol commands",
  );
});

test("protocol commands reject output flags without protocol stdout", () => {
  for (const command of ["mcp", "hook"]) {
    const result = Bun.spawnSync(
      [process.execPath, "bin/ast-mcp.ts", "--output=json", command],
      {
        cwd: process.cwd(),
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain(
      "--output is not supported for protocol commands",
    );
  }
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

test("help validates topics and extra arguments before dispatch", async () => {
  for (const args of [
    ["help"],
    ["help", "unknown"],
    ["help", "config", "extra"],
  ]) {
    const h = harness();
    const status = await runCli(args, h.handlers);
    expect(status).toBe(args.length === 1 ? 0 : 1);
    expect(h.calls).toEqual([]);
    expect(args.length === 1 ? h.stdout[0] : h.stderr[0]).toContain("Usage:");
  }
  expect(getCliHelp("unknown")).toBeUndefined();
});

test("returns config exit codes and preserves operational handler errors", async () => {
  const h = harness();
  h.handlers.config = async () => 2;
  expect(await runCli(["config", "validate"], h.handlers)).toBe(2);
  delete h.handlers.skills;
  await expect(
    runCli(["skills", "export", "destination"], h.handlers),
  ).rejects.toThrow("Skills command is unavailable");
  for (const value of [new Error("operational failure"), "non-error failure"]) {
    h.handlers.installer = async () => {
      throw value;
    };
    await expect(runCli(["install"], h.handlers)).rejects.toBe(value);
    h.handlers.mcp = async () => {
      throw value;
    };
    await expect(runCli(["mcp"], h.handlers)).rejects.toBe(value);
  }
  const usage = new Error("Invalid protocol option");
  usage.name = "McpUsageError";
  h.handlers.mcp = async () => {
    throw usage;
  };
  expect(await runCli(["mcp"], h.handlers)).toBe(1);
  expect(h.stderr.at(-1)).toContain("Invalid protocol option");
});

test("defaults help and errors to process streams without custom output handlers", async () => {
  const h = harness();
  delete h.handlers.stdout;
  delete h.handlers.stderr;
  const out = spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    expect(await runCli(["help", "config"], h.handlers)).toBe(0);
    expect(out).toHaveBeenCalledWith(getCliHelp("config"));
    expect(await runCli(["unknown"], h.handlers)).toBe(1);
    expect(err.mock.calls[0]?.[0]).toContain("Unknown command");
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
});

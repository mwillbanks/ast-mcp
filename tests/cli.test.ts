import { expect, test } from "bun:test";

const calls: string[][] = [];
const handlers = {} as CliHandlers;

handlers.mcp = async () => {
  calls.push(["mcp"]);
};
handlers.hook = async () => {
  calls.push(["hook"]);
  return 17;
};
handlers.installer = async (args: string[]) => {
  calls.push(args);
};

Object.freeze(handlers);

import { type CliHandlers, runCli } from "../src/cli";

test("single CLI dispatches every subcommand", async () => {
  expect(await runCli(["mcp"], handlers)).toBeUndefined();
  expect(await runCli(["hook"], handlers)).toBe(17);

  await runCli(["install", "--scope", "local"], handlers);
  await runCli(["update", "--scope", "local"], handlers);
  await runCli(["uninstall", "--scope", "local"], handlers);
  expect(calls).toEqual([
    ["mcp"],
    ["hook"],
    ["install", "--scope", "local"],
    ["update", "--scope", "local"],
    ["uninstall", "--scope", "local"],
  ]);
});

test("single CLI rejects missing and unknown subcommands", async () => {
  await expect(runCli([], handlers)).rejects.toThrow(
    "Usage: ast-mcp <install|update|uninstall|hook|mcp>",
  );
  await expect(runCli(["unknown"], handlers)).rejects.toThrow(
    "Usage: ast-mcp <install|update|uninstall|hook|mcp>",
  );
});

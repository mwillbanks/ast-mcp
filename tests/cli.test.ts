import { afterAll, expect, mock, test } from "bun:test";

const installerCalls: string[][] = [];

mock.module("../src/index", () => ({}));
mock.module("../src/hook", () => ({ runHook: () => 17 }));
mock.module("../src/installer", () => ({
  runInstallerCli: async (args: string[]) => {
    installerCalls.push(args);
  },
}));

afterAll(() => {
  mock.restore();
});

import { runCli } from "../src/cli";

test("single CLI dispatches every subcommand", async () => {
  expect(await runCli(["mcp"])).toBeUndefined();
  expect(await runCli(["hook"])).toBe(17);

  await runCli(["install", "--scope", "local"]);
  expect(installerCalls).toEqual([["install", "--scope", "local"]]);
});

test("single CLI rejects missing and unknown subcommands", async () => {
  await expect(runCli([])).rejects.toThrow(
    "Usage: ast-mcp <install|update|uninstall|hook|mcp>",
  );
  await expect(runCli(["unknown"])).rejects.toThrow(
    "Usage: ast-mcp <install|update|uninstall|hook|mcp>",
  );
});

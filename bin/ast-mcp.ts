#!/usr/bin/env bun
const { runCli } = await import("../src/cli");

process.exit(
  (await runCli(process.argv.slice(2), {
    hook: async () => {
      const { runHook } = await import("../src/hook");
      return runHook();
    },
    installer: async (args) => {
      const { runInstallerCli } = await import("../src/installer");
      await runInstallerCli(args);
    },
    mcp: async () => {
      await import("../src/index");
    },
  })) ?? 0,
);

#!/usr/bin/env bun
const { runCli } = await import("../src/cli");

try {
  const exitCode = await runCli(process.argv.slice(2), {
    config: async (args) => {
      const { runConfigCli } = await import("../src/config-cli");
      return await runConfigCli(args);
    },
    hook: async () => {
      const { runHook } = await import("../src/hook");
      return runHook();
    },
    installer: async (args) => {
      const { runInstallerCli } = await import("../src/installer");
      await runInstallerCli(args);
    },
    mcp: async (args) => {
      const { runMcpCli } = await import("../src/mcp-cli");
      await runMcpCli(args);
    },
  });

  if (exitCode !== undefined) process.exitCode = exitCode;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ast-mcp: ${message}\n`);
  process.exitCode = 1;
}

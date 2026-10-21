#!/usr/bin/env bun
const { runCli } = await import("../src/cli");

try {
  const exitCode = await runCli(process.argv.slice(2), {
    config: async (args) => {
      const { runConfigCli } = await import("../src/cli/config");
      return await runConfigCli(args);
    },
    skills: async (args) => {
      const { runSkillsCli } = await import("../src/cli/skills");
      await runSkillsCli(args);
    },
    hook: async () => {
      const { runHook } = await import("../src/hooks");
      return runHook();
    },
    installer: async (args) => {
      const { runInstallerCli } = await import("../src/installer");
      await runInstallerCli(args);
    },
    mcp: async (args) => {
      const { runMcpCli } = await import("../src/cli/mcp");
      await runMcpCli(args);
    },
  });

  if (exitCode !== undefined) process.exitCode = exitCode;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ast-mcp: ${message}\n`);
  process.exitCode = 1;
}

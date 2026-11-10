#!/usr/bin/env bun
const workerMode = process.argv.length === 3 ? process.argv[2] : undefined;
if (typeof process.send === "function") {
  if (workerMode === "--ast-mcp-internal-native-worker=parser")
    await import("../src/intelligence/parser/worker.ts");
  else if (workerMode === "--ast-mcp-internal-native-worker=code-intelligence")
    await import("../src/tools/code-intelligence-worker.ts");
  else if (workerMode === "--ast-mcp-internal-native-worker=patch")
    await import("../src/patch/strategy/worker.ts");
  if (
    workerMode === "--ast-mcp-internal-native-worker=parser" ||
    workerMode === "--ast-mcp-internal-native-worker=code-intelligence" ||
    workerMode === "--ast-mcp-internal-native-worker=patch"
  ) {
    await new Promise<void>((resolve) => process.once("disconnect", resolve));
    process.exit(0);
  }
}

const { runCli } = await import("../src/cli");

try {
  const exitCode = await runCli(process.argv.slice(2), {
    doctor: async (args) => {
      const { runDoctorCli } = await import("../src/cli/doctor");
      return runDoctorCli(args);
    },
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
      const { configureLanguagePackHost } =
        await import("../src/config/language-packs");
      const { runMcpCli } = await import("../src/cli/mcp");
      await runMcpCli(configureLanguagePackHost(args));
    },
    pm: async (args) => {
      const { runLanguagePackCli } = await import("../src/cli/pm");
      return runLanguagePackCli(args);
    },
  });

  if (exitCode !== undefined) process.exitCode = exitCode;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ast-mcp: ${message}\n`);
  process.exitCode = 1;
}

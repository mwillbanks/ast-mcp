export async function runCli(
  args = process.argv.slice(2),
): Promise<number | undefined> {
  const [command, ...rest] = args;
  if (command === "mcp") {
    await import("./index");
    return;
  }
  if (command === "hook") {
    const { runHook } = await import("./hook");
    return runHook();
  }
  if (["install", "update", "uninstall"].includes(command ?? "")) {
    const { runInstallerCli } = await import("./installer");
    await runInstallerCli([command as string, ...rest]);
    return;
  }
  throw new Error(
    "Usage: ast-mcp <install|update|uninstall|hook|mcp> [options]",
  );
}

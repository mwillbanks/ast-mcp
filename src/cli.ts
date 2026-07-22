export interface CliHandlers {
  hook(): Promise<number>;
  installer(args: string[]): Promise<void>;
  mcp(): Promise<void>;
}

export async function runCli(
  args: string[],
  handlers: CliHandlers,
): Promise<number | undefined> {
  const [command, ...rest] = args;
  if (command === "mcp") {
    await handlers.mcp();
    return;
  }
  if (command === "hook") {
    return handlers.hook();
  }
  if (["install", "update", "uninstall"].includes(command ?? "")) {
    await handlers.installer([command as string, ...rest]);
    return;
  }
  throw new Error(
    "Usage: ast-mcp <install|update|uninstall|hook|mcp> [options]",
  );
}

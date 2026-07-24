export interface CliHandlers {
  config(args: string[]): Promise<void>;
  hook(): Promise<number>;
  installer(args: string[]): Promise<void>;
  mcp(args: string[]): Promise<void>;
  stderr?(text: string): void;
  stdout?(text: string): void;
}

const rootHelp = `ast-mcp - AST-aware Model Context Protocol server\n\nUsage:\n  ast-mcp <command> [options]\n\nCommands:\n  config       Validate or display layered ast-mcp.toml configuration\n  install      Configure ast-mcp for one or more supported hosts\n  update       Refresh an existing ast-mcp configuration\n  uninstall    Remove ast-mcp-managed configuration\n  mcp          Start the stdio or Streamable HTTP MCP server\n  hook         Run the pre-tool-use filesystem guard\n  help         Display help for a command\n\nOptions:\n  -h, --help   Display help\n\nRun "ast-mcp help <command>" for command-specific help.\n`;

const installerOptions = `Options:\n  -s, --scope <scope>       Installation scope: local or global (default: local)\n  -t, --target <target>     Host: codex, claude, copilot, or all (default: all)\n  -r, --root <path>         Project root for local scope (default: current directory)\n      --transport <mode>    MCP transport: stdio or http (default: stdio)\n      --host <address>      HTTP bind host (default: layered configuration)\n      --port <number>       HTTP bind port (default: layered configuration)\n      --service             Install and start a managed user HTTP service\n      --no-service          Stop and remove a managed user HTTP service\n  -h, --help                Display help\n`;

const commandHelp: Record<string, string> = {
  config: `Usage:\n  ast-mcp config <validate|show> [options]\n\nValidate configuration or display the resolved values, sources, and provenance.\n\nOptions:\n  -r, --root <path>  Project root to resolve (default: current directory)\n  -h, --help         Display help\n`,
  hook: `Usage:\n  ast-mcp hook\n\nRun the pre-tool-use filesystem guard. Hook input is read from stdin.\n\nOptions:\n  -h, --help   Display help\n`,
  install: `Usage:\n  ast-mcp install [options]\n\nConfigure ast-mcp for supported hosts.\n\n${installerOptions}`,
  mcp: `Usage:\n  ast-mcp mcp [options]\n\nStart the MCP server. Stdio is the default; HTTP listens on the layered configuration unless flags override it.\n\nOptions:\n      --transport <mode>  MCP transport: stdio or http (default: stdio)\n      --host <address>    HTTP bind host\n      --port <number>     HTTP bind port\n  -h, --help              Display help\n`,
  uninstall: `Usage:\n  ast-mcp uninstall [options]\n\nRemove ast-mcp-managed configuration while preserving shared host files.\n\n${installerOptions}`,
  update: `Usage:\n  ast-mcp update [options]\n\nRefresh managed configuration and installed skill content.\n\n${installerOptions}`,
};

export function getCliHelp(): string;
export function getCliHelp(command: keyof typeof commandHelp): string;
export function getCliHelp(command: string): string | undefined;
export function getCliHelp(command?: string) {
  return command && Object.hasOwn(commandHelp, command)
    ? commandHelp[command]
    : command
      ? undefined
      : rootHelp;
}

function writeHelp(handlers: CliHandlers, command?: string) {
  const output =
    command === undefined ? getCliHelp() : (getCliHelp(command) ?? rootHelp);
  if (handlers.stdout) handlers.stdout(output);
  else process.stdout.write(output);
}

function usageError(handlers: CliHandlers, message: string, command?: string) {
  const help =
    command === undefined ? getCliHelp() : (getCliHelp(command) ?? rootHelp);
  const output = `ast-mcp: ${message}\n\n${help}`;
  if (handlers.stderr) handlers.stderr(output);
  else process.stderr.write(output);
  return 1;
}

export async function runCli(
  args: string[],
  handlers: CliHandlers,
): Promise<number | undefined> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    writeHelp(handlers);
    return 0;
  }
  if (command === "help") {
    const [topic, ...extra] = rest;
    if (extra.length > 0)
      return usageError(handlers, `Unexpected argument: ${extra[0]}`);
    if (topic && !Object.hasOwn(commandHelp, topic))
      return usageError(handlers, `Unknown command: ${topic}`);
    writeHelp(handlers, topic);
    return 0;
  }
  if (!Object.hasOwn(commandHelp, command))
    return usageError(handlers, `Unknown command: ${command}`);
  if (rest.includes("--help") || rest.includes("-h")) {
    writeHelp(handlers, command);
    return 0;
  }
  if (command === "mcp") {
    try {
      await handlers.mcp(rest);
      return;
    } catch (error) {
      if (error instanceof Error && error.name === "McpUsageError")
        return usageError(handlers, error.message, command);
      throw error;
    }
  }
  if (command === "hook") {
    if (rest.length > 0)
      return usageError(
        handlers,
        `Unexpected argument for hook: ${rest[0]}`,
        command,
      );
    return handlers.hook();
  }
  try {
    if (command === "config") await handlers.config(rest);
    else await handlers.installer([command, ...rest]);
    return;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "InstallerUsageError" ||
        error.name === "ConfigurationUsageError" ||
        error.name === "McpUsageError")
    )
      return usageError(handlers, error.message, command);
    throw error;
  }
}

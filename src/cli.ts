export interface CliHandlers {
  hook(): Promise<number>;
  installer(args: string[]): Promise<void>;
  mcp(): Promise<void>;
  stderr?(text: string): void;
  stdout?(text: string): void;
}

const rootHelp = `ast-mcp - AST-aware Model Context Protocol server

Usage:
  ast-mcp <command> [options]

Commands:
  install      Configure ast-mcp for one or more supported hosts
  update       Refresh an existing ast-mcp configuration
  uninstall    Remove ast-mcp-managed configuration
  mcp          Start the stdio MCP server
  hook         Run the pre-tool-use filesystem guard
  help         Display help for a command

Options:
  -h, --help   Display help

Run "ast-mcp help <command>" for command-specific help.
`;

const installerOptions = `Options:
  -s, --scope <scope>    Installation scope: local or global (default: local)
  -t, --target <target>  Host: codex, claude, copilot, or all (default: all)
  -r, --root <path>      Project root for local scope (default: current directory)
  -h, --help             Display help
`;

const commandHelp: Record<string, string> = {
  hook: `Usage:
  ast-mcp hook

Run the pre-tool-use filesystem guard. Hook input is read from stdin.

Options:
  -h, --help   Display help
`,
  install: `Usage:
  ast-mcp install [options]

Configure ast-mcp for supported hosts.

${installerOptions}`,
  mcp: `Usage:
  ast-mcp mcp

Start the stdio MCP server. Protocol messages are read from stdin and written to stdout.

Options:
  -h, --help   Display help
`,
  uninstall: `Usage:
  ast-mcp uninstall [options]

Remove ast-mcp-managed configuration while preserving shared host files.

${installerOptions}`,
  update: `Usage:
  ast-mcp update [options]

Refresh managed configuration and installed skill content.

${installerOptions}`,
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
    if (rest.length > 0)
      return usageError(
        handlers,
        `Unexpected argument for mcp: ${rest[0]}`,
        command,
      );
    await handlers.mcp();
    return;
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
    await handlers.installer([command, ...rest]);
    return;
  } catch (error) {
    if (error instanceof Error && error.name === "InstallerUsageError")
      return usageError(handlers, error.message, command);
    throw error;
  }
}

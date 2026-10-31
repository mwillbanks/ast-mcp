# CLI commands

Use the installed executable for the intended scope.
Use `./node_modules/.bin/ast-mcp` for a local package.
Use its persistent package-manager alias for a global package.
For a source checkout, use `bun run bin/ast-mcp.ts`.
Do not download an executable through an implicit package runner.

## Command catalog

| Command     | Purpose and arguments                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| `config`    | Inspect, validate, or migrate runtime configuration.                               |
| `doctor`    | Collect host diagnostics and check the latest package version.                     |
| `install`   | Create managed host configuration.                                                 |
| `update`    | Refresh managed host configuration without upgrading the package.                  |
| `uninstall` | Remove managed host configuration while preserving shared files and manual skills. |
| `mcp`       | Serve stdio or Streamable HTTP.                                                    |
| `skills`    | Export or update a selected manual skill directory.                                |
| `hook`      | Run the filesystem guard with host hook JSON on stdin.                             |
| `help`      | Display root help or help for a command.                                           |

Run `ast-mcp help <command>` or `ast-mcp <command> --help` for executable-specific help.
Root `-h` and `--help` also display help.
Ordinary commands accept `--output human|json|yaml|toml`.
Protocol commands `mcp` and `hook` reject `--output`; stdout belongs to their protocol.
Usage errors return a nonzero exit.

## Configuration

`ast-mcp config show --output json` displays effective configuration.
`ast-mcp config validate --output json` validates it.
`ast-mcp config migrate` previews migration.
Use `--file <path>` for one configuration file or `--global` for the user-global configuration.
Use `--to 2` for the supported migration target.
Use `--check` to exit 2 when migration is required.
Use `--write` only after reviewing the preview.
Writing retains a backup unless `--no-backup` explicitly disables it.
The deprecated `-r` or `--root <path>` selects a root or migration directory.
Use MCP `config_core` and `config_paths` for supported version 2 edits.
Load [configuration.md](configuration.md) for configuration fields and policies.

## Host installation

`install`, `update`, and `uninstall` accept these options:

| Option                    | Meaning                                                   |
| ------------------------- | --------------------------------------------------------- |
| `-s`, `--scope <scope>`   | Select local or global installation scope; default local. |
| `-t`, `--target <target>` | Select codex, claude, copilot, or all; default all.       |
| `-r`, `--root <path>`     | Deprecated project-root override.                         |
| `--transport <mode>`      | Select stdio or http; default stdio.                      |
| `--host <address>`        | Override the HTTP bind address.                           |
| `--port <number>`         | Override the HTTP port.                                   |
| `--service`               | Install or start a supported managed HTTP user service.   |
| `--no-service`            | Stop and remove the managed user service.                 |
| `--output <format>`       | Select human, JSON, YAML, or TOML output.                 |

Host options do not select MCP authorization policy.
Claude Desktop, Grok, and other MCP clients can use standard MCP connections without Codex-specific settings.
Load [installation.md](installation.md) before repairs, upgrades, service changes, or host refreshes.

## Server and hook

`ast-mcp mcp` starts stdio.
Use `--transport http` for Streamable HTTP.
The optional `--host` and `--port` override layered HTTP configuration.
Keep server diagnostics on stderr.
The host owns process startup and reconnection.

`ast-mcp hook` reads one hook input from stdin.
It accepts no operational arguments.
Do not launch the hook as a substitute for MCP file operations.

## Manual skills

`ast-mcp skills export <destination> --output json` exports without replacing existing files.
`ast-mcp skills update <destination> --output json` refreshes unchanged managed files and preserves customizations.
Conflicts produce a nonzero exit.
Inspect structured results before retrying.
Do not change baseline hashes to force replacement.
Prefer negotiated MCP Skills when the host supports them.

## Diagnostics

Use `ast-mcp doctor` for the executing package and host configuration.
Use MCP `diagnostics` to inspect the connected server.
These can identify different versions.
Doctor accepts `--scope local|global`, `--target auto|codex|claude|copilot`, `--root <path>`, and `--profile <name>`.
The defaults are local scope, automatic host selection, and the current directory.
Doctor's `--scope` selects host configuration inspection only.
Runtime configuration diagnostics still describe the effective merged configuration for the selected project.
`--profile` selects a Codex disk profile; it does not select or prove an active session policy.
Doctor exits 0 after rendering a report, including unavailable registry or host facts.
Invalid arguments return exit 1.
Load [diagnostics.md](diagnostics.md) for doctor options, approval probes, and release checks.
Load [issue-reporting.md](issue-reporting.md) before reporting unexpected behavior.

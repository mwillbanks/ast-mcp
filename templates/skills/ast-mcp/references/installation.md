# Installation and recovery

Use this only when the ast-mcp tools are absent, incomplete, or disconnected. Do not continue with a different editor.

## Diagnose

From the installed skill directory, run the read-only checker:

`bun run scripts/check-install.ts --scope local --target codex`

Replace `codex` with `claude` or `copilot`. Pass `--scope global` for a global installation. Pass the HTTP address and port for HTTP installations. The checker validates guidance, MCP definitions, hooks, skills, managed services, and the native intelligence tool surface. It also detects stable package-manager aliases and duplicate handlers. It rejects package-internal or stale commands. It prints an exact install, update, or dependency-repair command.

## Install from this package checkout

When the `@mwillbanks/ast-mcp` source checkout is already available, install its dependencies and build the stable CLI before configuring a host:

`bun install && bun run build`

`bun run bin/ast-mcp.ts install --scope local --target all`

For one host globally:

`bun run bin/ast-mcp.ts install --scope global --target codex`

Targets are `codex`, `claude`, `copilot`, or `all`. Stdio is the default transport. Use the HTTP options for HTTP host entries. Add `--service` to manage a macOS LaunchAgent or Linux systemd user unit.

## Install from the published package

If the package is not already installed, obtain user authorization before allowing a package manager to download or install it. Install it into the repository so native intelligence dependencies and `dprint` remain available, then run the installed CLI:

```npm
npm install --save-dev @mwillbanks/ast-mcp
```

When installing with Bun, allow the pinned native installers:

`bun pm trust dprint`

`./node_modules/.bin/ast-mcp install --scope local --target all`

For a global host surface, use the package manager's persistent global install:

```npm
npm install --global @mwillbanks/ast-mcp
```

Then run `ast-mcp install --scope global --target codex`. Use a project-local installation with Yarn 2+. Yarn 2+ does not provide the Yarn Classic global workflow. Bun blocks transitive lifecycle scripts by default. Trust `dprint` to run its pinned native installer. Approve that package when another manager blocks dependency build scripts.

Local MCP, hook, service, and repair surfaces always use `./node_modules/.bin/ast-mcp`. Global surfaces use a discovered Bun, npm, pnpm, or Yarn global-bin alias and reject package-internal paths. The runtime checks package binaries, package metadata, global bins, and `PATH`. The installer uses the stable CLI and its `mcp` and `hook` subcommands. Run the local binary for local updates and removal. Run `ast-mcp update` or `ast-mcp uninstall` for global installations.

The native Bun implementation supports macOS, Linux, and Windows without a Rust or Cargo prerequisite. The installer verifies the MCP surface before reporting a healthy host configuration.

## Activate and verify

1. Run `ast-mcp config validate` before reconnecting. Use `ast-mcp config show` when the effective source is unclear. `--root` remains deprecated for one release.
2. Restart or reconnect MCP servers in the host. A skill file cannot make MCP tools callable. Send `SIGHUP` to request graceful cleanup and restart.
3. Confirm `file_hash`, `file_read`, `file_write`, and `file_patch` are present.
4. Confirm direct intelligence tools such as `digest`, `map`, `show`, `context`, and `impact` are present; there is no proxy tool.
5. Verify that read and mutation tools accept their current batch fields. Reject dictionary-only mutation schemas and the legacy whole-file read schema.
6. Rerun `check-install.ts` if the tool list remains incomplete.
7. Run `bun run tools:check` from the package checkout when startup fails. Report the missing dependency or startup error. Preserve the write boundary.

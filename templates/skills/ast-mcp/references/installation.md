# Installation and recovery

Use this only when the ast-mcp tools are absent, incomplete, or disconnected. Do not continue with a different editor.

## Diagnose

From an explicitly exported skill directory or the canonical package skill directory, run the read-only checker:

`bun run scripts/check-install.ts --scope local --target codex`

Replace `codex` with `claude` or `copilot`. Pass `--scope global` for a global installation. Pass the HTTP address and port for HTTP installations. The checker validates guidance, MCP definitions, hooks, managed services, initialization, and the native intelligence tool surface. Verify skill delivery separately through MCP discovery and resource retrieval. It also detects stable package-manager aliases and duplicate handlers. It rejects package-internal or stale commands. It prints an exact install, update, or dependency-repair command.

## Install from this package checkout

When the `@mwillbanks/ast-mcp` source checkout is already available, install its dependencies and build the stable CLI before configuring a host:

`bun install && bun run build`

`bun run bin/ast-mcp.ts install --scope local --target all`

For one host globally:

`bun run bin/ast-mcp.ts install --scope global --target codex`

Targets are `codex`, `claude`, `copilot`, or `all`. Stdio is the default transport. Use the HTTP options for HTTP host entries. Add `--service` to manage a macOS LaunchAgent or Linux systemd user unit.

## Install from the published package

If the package is not already installed, obtain user authorization before allowing a package manager to download or install it. Install it into the repository so native intelligence dependencies remain available, then run the installed CLI:

```npm
npm install --save-dev @mwillbanks/ast-mcp
```

`./node_modules/.bin/ast-mcp install --scope local --target all`

For a global host surface, use the package manager's persistent global install:

```npm
npm install --global @mwillbanks/ast-mcp
```

Then run `ast-mcp install --scope global --target codex`. Use a project-local installation with Yarn 2+. Yarn 2+ does not provide the Yarn Classic global workflow. Formatting is disabled by default. Install and configure your preferred formatter separately; ast-mcp does not install or download formatters during file operations.

Local MCP, hook, service, and repair surfaces always use `./node_modules/.bin/ast-mcp`. Global surfaces use a discovered Bun, npm, pnpm, or Yarn global-bin alias and reject package-internal paths. The runtime checks package binaries, package metadata, global bins, and `PATH`. The installer uses the stable CLI and its `mcp` and `hook` subcommands. Run the local binary for local updates and removal. Run `ast-mcp update` or `ast-mcp uninstall` for global installations.

The native Bun implementation supports macOS, Linux, and Windows without a Rust or Cargo prerequisite. The installer verifies the MCP surface before reporting a healthy host configuration.

## Skills delivery and migration

The server advertises `io.modelcontextprotocol/skills` through `server/discover` on protocol 2026-07-28. Fetch `skills/list`, `skills/get`, and each exact `resources/read` manifest URI. Include required protocol-version and client-capabilities request metadata. Verify byte sizes and SHA-256 digests; honor cache metadata and resource pagination. Legacy clients can still use ordinary tools.

For a host without MCP Skills support, run `ast-mcp skills export <destination>`. Supply the exact skill directory, such as `.codex/skills/ast-mcp`, then enable that directory in the host. Export preserves every existing file; compare customized files manually. It rejects symbolic-link directories. Install and update do not copy skills automatically, and uninstall preserves existing legacy skills.

Modern HTTP does not use transport sessions. Reuse workspaces through explicit `workspaceId` values. Host approvals requiring a stable session return `approval_required`; configure explicit global rules or use a stable stdio host connection. Global unrestricted access still respects OS permissions, hashes, and immutable revisions.

## Activate and verify

1. Run `ast-mcp config validate` before reconnecting. Use `ast-mcp config show` when the effective source is unclear. `--root` remains deprecated for one release.
2. Restart or reconnect MCP servers in the host. A skill file cannot make MCP tools callable. `SIGHUP` requests graceful cleanup; the host controls whether and when the process restarts.
3. Confirm `file_hash`, `file_read`, `file_write`, and `file_patch` are present.
4. Confirm direct intelligence tools such as `digest`, `map`, `show`, `context`, and `impact` are present; there is no proxy tool.
5. Verify that read and mutation tools accept their current batch fields. Reject dictionary-only mutation schemas and the legacy whole-file read schema.
6. Rerun `check-install.ts` if the tool list remains incomplete.
7. Run `bun run tools:check` from the package checkout when startup fails. Report the missing dependency or startup error. Preserve the write boundary.

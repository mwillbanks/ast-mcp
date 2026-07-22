# Installation and recovery

Use this only when the ast-mcp tools are absent, incomplete, or disconnected. Do not continue with a different editor.

## Diagnose

From the installed skill directory, run the read-only checker:

`bun run scripts/check-install.ts --scope local --target codex --root "$PWD"`

Replace `codex` with `claude` or `copilot`. For a global installation, pass `--scope global`. The JSON result validates the marked guidance against the bundled template, checks the host-specific MCP, hook payload and registration, skill, and prints the appropriate install or update command.

## Install from this package checkout

When the `@mwillbanks/ast-mcp` source checkout is already available, install its dependencies and build the stable CLI before configuring a host:

`bun install && bun run build`

`bun run bin/ast-mcp.ts install --scope local --target all --root "$PWD"`

For one host globally:

`bun run bin/ast-mcp.ts install --scope global --target codex`

Targets are `codex`, `claude`, `copilot`, or `all`.

## Install from the published package

If the package is not already installed, obtain user authorization before allowing Bun to download or install it. Install it into the repository so `@ast-bro/cli` and `dprint` remain available, then run the installed CLI:

`bun add --dev @mwillbanks/ast-mcp`

`bun pm trust @ast-bro/cli dprint`

`bunx ast-mcp install --scope local --target all --root "$PWD"`

For a global host surface, use `bun add --global --trust @ast-bro/cli dprint @mwillbanks/ast-mcp` followed by `ast-mcp install --scope global --target codex`. Bun blocks transitive lifecycle scripts by default; explicitly trusting `@ast-bro/cli` and `dprint` runs their pinned native installers instead of leaving stale or missing cache paths. Do not use `bunx --package` for host installation because its temporary package path can disappear after configuration is written. The installer records the stable installed CLI and uses its `mcp` and `hook` subcommands. Run `ast-mcp update` to refresh managed surfaces and `ast-mcp uninstall` to remove them.

## Activate and verify

1. Restart or reconnect MCP servers in the host; a skill file alone cannot make MCP tools callable. A supervised ast-mcp process may receive `SIGHUP`, which performs graceful cleanup and exits 0 so the host can restart it from refreshed code and configuration.
2. Confirm `file_hash`, `file_read`, `file_write`, and `file_patch` are present.
3. Confirm direct intelligence tools such as `digest`, `map`, `show`, `context`, and `impact` are present; there is no proxy tool.
4. Verify that `file_read` accepts batched `files`, `file_hash` accepts batched `filePaths`, and `file_write`/`file_patch` accept path-keyed batches with ordered per-file operations; the legacy whole-file `file_read({ filePath })` schema is stale.
5. Rerun `check-install.ts` if the tool list remains incomplete.
6. If configuration is correct but startup fails, run the package's `bun run tools:check` from its checkout and report the missing dependency or startup error. Do not bypass the write boundary.

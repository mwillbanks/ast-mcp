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

If the package is not already installed, obtain user authorization before allowing a package manager to download or install it. Install it into the repository so `@ast-bro/cli` and `dprint` remain available, then run the installed CLI:

```npm
npm install --save-dev @mwillbanks/ast-mcp
```

When installing with Bun, allow the pinned native installers:

`bun pm trust @ast-bro/cli dprint`

`./node_modules/.bin/ast-mcp install --scope local --target all --root "$PWD"`

For a global host surface, use the package manager's persistent global install:

```npm
npm install --global @mwillbanks/ast-mcp
```

Then run `ast-mcp install --scope global --target codex`. Yarn 2+ should use a project-local installation because it does not provide the Yarn Classic global workflow. Bun blocks transitive lifecycle scripts by default; explicitly trusting `@ast-bro/cli` and `dprint` runs their pinned native installers instead of leaving stale or missing cache paths. If another manager blocks dependency build scripts, approve those two packages through that manager.

Do not use an ephemeral package executor for host installation because its temporary package path can disappear after configuration is written. The runtime checks ancestor `node_modules/.bin` directories, package metadata, Bun/pnpm/npm/Yarn global bins, and finally `PATH`. The installer records the stable installed CLI and uses its `mcp` and `hook` subcommands. For a local installation, run `./node_modules/.bin/ast-mcp update` to refresh managed surfaces and `./node_modules/.bin/ast-mcp uninstall` to remove them; global installations use `ast-mcp update` and `ast-mcp uninstall`.

The pinned `@ast-bro/cli@3.0.0` package has a precompiled binary only for macOS Apple Silicon. On Linux or macOS Intel, install it with `cargo install ast-bro --version 3.0.0 --locked`, set `AST_BRO_BINARY="$HOME/.cargo/bin/ast-bro"`, and persist that export in `~/.profile` or `~/.zprofile`. On Windows, use the same Cargo command and persist `AST_BRO_BINARY` as `$HOME\.cargo\bin\ast-bro.exe` in the user environment. GUI-launched hosts must inherit that variable from their launcher. The ast-mcp installer verifies the binary before modifying host configuration and returns these commands when manual setup is required.

## Activate and verify

1. Restart or reconnect MCP servers in the host; a skill file alone cannot make MCP tools callable. A supervised ast-mcp process may receive `SIGHUP`, which performs graceful cleanup and exits 0 so the host can restart it from refreshed code and configuration.
2. Confirm `file_hash`, `file_read`, `file_write`, and `file_patch` are present.
3. Confirm direct intelligence tools such as `digest`, `map`, `show`, `context`, and `impact` are present; there is no proxy tool.
4. Verify that `file_read` accepts batched `files`, `file_hash` accepts batched `filePaths`, and `file_write`/`file_patch` accept path-keyed batches with ordered per-file operations; the legacy whole-file `file_read({ filePath })` schema is stale.
5. Rerun `check-install.ts` if the tool list remains incomplete.
6. If configuration is correct but startup fails, run the package's `bun run tools:check` from its checkout and report the missing dependency or startup error. Do not bypass the write boundary.

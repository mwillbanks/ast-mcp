# @mwillbanks/ast-mcp

<p align="center">
  <img src="logo.svg" alt="AST MCP" width="180" />
</p>

<p align="center">
  <strong>Inspect structurally. Write safely.</strong><br />
  A zero-trust MCP boundary for coding agents.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mwillbanks/ast-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@mwillbanks/ast-mcp" /></a>
  <a href="https://github.com/mwillbanks/ast-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/mwillbanks/ast-mcp/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

`@mwillbanks/ast-mcp` combines native AST intelligence, deterministic file operations, state-machine-enforced edits, best-effort routing hooks, and agent guidance. It gives Codex, Claude Code, GitHub Copilot, and VS Code Copilot a capable repository workflow without granting them an unbounded editor.

**[Read the documentation](https://mwillbanks.github.io/ast-mcp/)**

## Why ast-mcp

Coding agents need more than a text editor. They need a way to understand code relationships, preserve current state, and prove that an intended change is the change that reaches disk.

| Capability              | What it provides                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Structural intelligence | Directory digests, symbols, semantic search, context, calls, dependencies, cycles, impact, and public API inspection  |
| Guarded file operations | Batched hashing, bounded text reads, deterministic creation, exact patches, attributes, and reference-aware deletion  |
| Root isolation          | One shared path policy for every file and ast-bro operation, with symlink rejection and explicit external-root opt-in |
| Safe commits            | Fresh SHA-256 checks, deterministic cross-process locks, candidate formatting, hash rechecks, and atomic replacement  |
| Agent routing           | Best-effort hooks, a unified skill, and idempotent installers for Codex, Claude, Copilot, and VS Code                 |

AST-capable files stay on the intelligence path instead of being retrieved as whole-file text. Unsupported formats use bounded reads and exact Aider search/replace blocks.

## The guarded workflow

1. Map the target with `digest`, `show`, `context`, or another direct intelligence tool.
2. Use `impact` before changing shared or public behavior.
3. Preview exact structural matches with `run`.
4. Hash every target immediately before mutation.
5. Apply ordered `astRules` or `aiderBlocks` through a keyed `file_patch` batch.
6. Verify the resulting structure and run the repository's own quality gates.

A stale hash, ambiguous match, capped preview, unsupported route, formatter rejection, or lost MCP connection stops the write. ast-mcp never chooses a weaker editor path to force an edit through.

## Distribution

Bun is required. The package publishes one Bun-bundled `ast-mcp` CLI with `install`, `update`, `uninstall`, `hook`, and `mcp` subcommands. Host configurations reference the stable installed CLI, so its pinned `@ast-bro/cli` and `dprint` dependencies remain available for the lifetime of the installation.

Runtime dependencies are pinned where binary compatibility matters. `@ast-bro/cli` powers code intelligence and structural rewrites; dprint and its configured plugins format candidate writes across supported languages.

## Install

Install the MCP server, best-effort routing hooks, unified skill, and managed instructions into the current repository:

The hooks nudge common direct editor and manual mutation attempts toward ast-mcp. They are not a security boundary and deliberately leave Git operations, output redirection, repository scripts, and arbitrary execution to the host framework and sandbox.

```npm
npm install --save-dev @mwillbanks/ast-mcp
```

When installing with Bun, allow the pinned native installers:

```bash
bun pm trust @ast-bro/cli dprint
```

```bash
./node_modules/.bin/ast-mcp install \
  --scope local \
  --target all
```

Stdio remains the default. To generate Streamable HTTP entries instead, select HTTP and an endpoint:

```bash
./node_modules/.bin/ast-mcp install \
  --scope local \
  --target all \
  --transport http \
  --host 127.0.0.1 \
  --port 3768
```

Add `--service` to create and start a macOS LaunchAgent or Linux systemd user unit. Local services require an explicit port. Without `--service`, the installer prints the manual `ast-mcp mcp --transport http` startup command. Windows supports manual HTTP startup but not managed services.

Bun blocks transitive lifecycle scripts by default, so the explicit trust step runs the pinned ast-bro and dprint installers before the MCP starts. If another package manager blocks dependency build scripts, approve `@ast-bro/cli` and `dprint` through that manager before configuring a host. npm, pnpm, Yarn Classic, and Yarn 2+ project installations are supported. The runtime resolves binaries from ancestor package bins, package metadata, package-manager global bins, and then `PATH`.

Targets are `codex`, `claude`, `copilot`, or `all`. Local surfaces always use `./node_modules/.bin/ast-mcp`; global surfaces use a recognized Bun, npm, pnpm, or Yarn global-bin alias. The installer creates version 2 configuration and omits MCP environment fields. Uninstall preserves configuration.

### ast-bro platform support

`@ast-bro/cli@4.2.0` currently publishes a precompiled binary only for macOS Apple Silicon. The ast-mcp installer verifies that the pinned binary can execute before writing host configuration. On Linux, Windows, or macOS Intel, install it through Cargo and set `AST_BRO_BINARY` to the resulting executable before rerunning the installer:

```bash
cargo install ast-bro --version 4.2.0 --locked
export AST_BRO_BINARY="$HOME/.cargo/bin/ast-bro"
printf '%s\n' 'export AST_BRO_BINARY="$HOME/.cargo/bin/ast-bro"' >> "$HOME/.profile"
```

For Windows PowerShell:

```powershell
cargo install ast-bro --version 4.2.0 --locked
$env:AST_BRO_BINARY = "$HOME\.cargo\bin\ast-bro.exe"
[Environment]::SetEnvironmentVariable("AST_BRO_BINARY", "$HOME\.cargo\bin\ast-bro.exe", "User")
```

Install Rust and Cargo from [rustup](https://rustup.rs/) first when they are not already available. The example persists the variable for POSIX login shells; zsh users can write the same line to `~/.zprofile` instead. GUI-launched hosts must be started from that configured environment or receive `AST_BRO_BINARY` through their launcher. Restart the host after installation. The installer fails without changing host configuration when the binary is missing or has the wrong version.

From a source checkout:

```bash
bun install
bun run build
bun run bin/ast-mcp.ts install --scope local --target all
```

## Configuration

Install or update ast-mcp to create `ast-mcp.toml`. The installer migrates version 1 files and preserves version 2 files.

```toml
version = 2

[workspace]
roots = ["."]

[safety]
require_hash = true

[[paths]]
id = "workspace"
path = "."
policies = { read = "allow", write = "allow", delete = "deny" }
follow_symlinks = false
includes = ["**/*"]
excludes = [".git/**"]

[safety.hook]
enabled = true

[formatting]
enabled = true
dprint_config = "./dprint.json"

[[formatting.formatters]]
extensions = [".rs"]
command = "rustfmt"
args = ["--emit", "stdout"]

[http]
host = "127.0.0.1"
port = 3768
```

Resolution is deterministic: environment overrides, project `ast-mcp.toml`, the platform global `ast-mcp/ast-mcp.toml`, then built-in defaults. The server uses MCP client workspace roots when available, so one global installation automatically selects the connected project. Existing environment variables remain supported as explicit overrides.

Formatting uses dprint by default and supports shell-free external formatters. Mutation tools expose a declared `files` batch. Version 2 requires explicit `[[paths]]` rules outside the host baseline, including temporary paths. Path rules control symlinks, hashes, and hook policy.

Inspect the result with `ast-mcp config validate` and `ast-mcp config show`. See the [configuration reference](https://mwillbanks.github.io/ast-mcp/docs/reference/configuration/) for the full schema, discovery rules, cache behavior, formatter contract, safety semantics, and migration guidance.

## MCP configuration

A stdio definition contains the stable local or package-manager global executable alias and `mcp` subcommand. Generated definitions omit environment fields. Project configuration supplies local roots. Select `--transport http` during install to generate native URL entries for Codex, Claude Code, Copilot CLI, and VS Code.

Start HTTP manually with `ast-mcp mcp --transport http [--host <address>] [--port <number>]`, or install a user service with `--service`. CLI flags override environment variables, project TOML, global TOML, and built-in defaults. The endpoint is `/mcp`; wildcard bind addresses generate loopback client URLs, while explicit non-loopback addresses deliberately expose the server. MCP session IDs correlate requests and are not authentication; stdio remains the trusted default transport. HTTP uses SSE by default and emits one event per request; JSON-array responses require `enableJsonResponse`.

`SIGTERM`, `SIGINT`, and `SIGHUP` all initiate graceful shutdown. The stdio process closes its MCP server; the HTTP process stops accepting requests, closes every active MCP session, then closes remaining connections. Successful cleanup exits 0, cleanup failure exits 1, and a second signal forces exit 1 while cleanup is pending. `SIGHUP` intentionally exits after cleanup so the host supervisor can restart ast-mcp from refreshed code and configuration.

## Documentation

The full documentation covers installation, host surfaces, code-intelligence selection, file tools, root isolation, the write state machine, Streamable HTTP, evaluation workflows, configuration, and limitations.

**[Open the documentation website →](https://mwillbanks.github.io/ast-mcp/)**

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, quality gates, documentation checks, pull-request expectations, and automated release process.

## License

MIT

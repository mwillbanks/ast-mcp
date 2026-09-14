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

- **Structural intelligence:** Directory digests, symbols, search, context, calls, dependencies, cycles, impact, and public API inspection.
- **Guarded file operations:** Batched hashes, bounded reads, deterministic creation, exact patches, attributes, and reference-aware deletion.
- **Root isolation:** One path policy covers file and intelligence operations, symlink rejection, and explicit external roots.
- **Safe commits:** Fresh hashes, deterministic locks, candidate formatting, hash rechecks, and atomic replacement.
- **Agent routing:** Best-effort hooks, one skill, and idempotent installers for Codex, Claude, Copilot, and VS Code.

AST-capable files stay on the intelligence path instead of being retrieved as whole-file text. Unsupported formats use bounded reads and exact Aider search/replace blocks.

## Native code and repository intelligence

Open the exact checkout with `workspace_open`, then build its LanceDB index with `index`. Use `graph_query`, `graph_path`, `graph_explain`, and `graph_diff` for typed relationships. Use `retrieve` for bounded exact, lexical, semantic, and graph-ranked evidence. The optional `generate` tool accepts only explicit, revision-scoped evidence and returns validated citations.

LanceDB stores metadata, graph records, lexical data, jobs, revisions, and vectors. Global storage is the default. Local, parent-folder, and explicit paths are supported. Cross-repository requests require explicit federation.

## The guarded workflow

1. Map the target with `digest`, `show`, `context`, or another direct intelligence tool.
2. Use `impact` before changing shared or public behavior.
3. Preview exact structural matches with `run`.
4. Hash every target immediately before mutation.
5. Apply ordered `astRules` or `aiderBlocks` through a keyed `file_patch` batch.
6. Verify the resulting structure and run the repository's own quality gates.

A stale hash, ambiguous match, capped preview, unsupported route, formatter rejection, or lost MCP connection stops the write. ast-mcp never chooses a weaker editor path to force an edit through.

## Distribution

Bun is required. The package publishes one Bun-bundled `ast-mcp` CLI with `install`, `update`, `uninstall`, `hook`, and `mcp` subcommands. It also includes explicit parser-worker bundles, the tree-sitter runtime WASM, a pinned grammar manifest, and every available grammar WASM under `dist/workers`. Host configurations reference the stable installed CLI, so native intelligence and the pinned formatter remain available for the installation lifetime.

Native Bun, tree-sitter, ast-grep, LanceDB, and Transformers components power code intelligence. JSON and JSONC configuration parsing uses Bun support without another parsing dependency. Dprint formats candidate writes across supported languages. Extracted-package tests exercise parse, index, status, retrieval, and guarded writes through both stdio and Streamable HTTP.

## Install

Install the MCP server, best-effort routing hooks, unified skill, and managed instructions into the current repository:

The hooks nudge common direct editor and manual mutation attempts toward ast-mcp. They are not a security boundary and deliberately leave Git operations, output redirection, repository scripts, and arbitrary execution to the host framework and sandbox.

```npm
npm install --save-dev @mwillbanks/ast-mcp
```

When installing with Bun, allow the pinned native installers:

```bash
bun pm trust dprint
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

Bun blocks transitive lifecycle scripts by default, so the explicit trust step runs the pinned dprint installer before the MCP starts. If another package manager blocks dependency build scripts, approve `dprint` through that manager before configuring a host. npm, pnpm, Yarn Classic, and Yarn 2+ project installations are supported. The runtime resolves binaries from ancestor package bins, package metadata, package-manager global bins, and then `PATH`.

Targets are `codex`, `claude`, `copilot`, or `all`. Local surfaces always use `./node_modules/.bin/ast-mcp`; global surfaces use a recognized Bun, npm, pnpm, or Yarn global-bin alias. The installer creates version 2 configuration and omits MCP environment fields. Uninstall preserves configuration.

### Platform support

The native Bun implementation supports macOS, Linux, and Windows without a Rust or Cargo prerequisite. Optional parser and embedding providers report explicit capability failures when their platform artifacts are unavailable.

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

## Intelligence indexes

Open each checkout with `workspace_open` before indexing or querying it. A workspace records its checkout, repository, revision, and storage identities. This prevents a worktree request from reading or updating the repository's root checkout.

The default `global` placement shares content-addressed LanceDB artifacts across workspaces. Select `local`, `parent`, or `explicit` placement through `workspace_open` when isolation or a specific storage location is required. Cross-repository graph comparison requires `federation: true`; ordinary graph requests remain repository-scoped.

Use `index` with `build`, `refresh`, `verify`, `collect`, or `status`. Use `index_status` for a read-only health view. `graph_query`, `graph_path`, `graph_explain`, and `graph_diff` require explicit workspace IDs and return generation, evidence, coverage, freshness, and pagination metadata. LanceDB is the only persistent database.

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

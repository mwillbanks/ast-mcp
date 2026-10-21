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
- **Local filesystem boundary:** File authorization applies to local files; intelligence workspace roots remain separate. Use web or connected tools for remote content, and apply normal file policy when saving it locally.
- **Safe commits:** Fresh hashes, deterministic locks, candidate formatting, hash rechecks, and atomic replacement.
- **Agent routing:** Best-effort hooks, MCP-delivered skill instructions, and idempotent host configuration for Codex, Claude, Copilot, and VS Code.

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

A stale hash, ambiguous match, capped preview, unsupported route, or lost MCP connection stops the write. Formatter failures preserve candidate content by default; explicit reject mode stops the write. ast-mcp never chooses a weaker editor path to force an edit through.

## Distribution

Bun is required. The package publishes one Bun-bundled `ast-mcp` CLI with `install`, `update`, `uninstall`, `hook`, `mcp`, and `skills` subcommands. It also includes explicit parser-worker bundles, the tree-sitter runtime WASM, a pinned grammar manifest, and every available grammar WASM under `dist/workers`. Host configurations reference the stable installed CLI, so native intelligence remains available for the installation lifetime.

Native Bun, tree-sitter, ast-grep, LanceDB, and Transformers components power code intelligence. JSON and JSONC configuration parsing uses Bun support without another parsing dependency. Formatting is optional and uses explicitly configured external commands; ast-mcp does not download formatters during file operations. Extracted-package tests exercise parse, index, status, retrieval, and guarded writes through both stdio and Streamable HTTP.

## Install

Install the MCP server, best-effort routing hooks, and managed instructions into the current repository. Hosts that support MCP Skills can load the canonical skill from the server; other clients can use an explicit local export with `ast-mcp skills export <destination>`. See the [MCP Skills guide](https://mwillbanks.github.io/ast-mcp/docs/guides/skills/) for details.

For a manual skill, run `ast-mcp skills update <destination>` after a package upgrade. It updates unchanged managed files and preserves customizations. Conflicts require manual reconciliation and return a nonzero exit. MCP Skills clients need no disk refresh unless they select a local copy. Check host selection when an old local copy shadows current MCP instructions.

The hooks nudge common direct editor and manual mutation attempts toward ast-mcp. They are not a security boundary and deliberately leave Git operations, output redirection, repository scripts, and arbitrary execution to the host framework and sandbox.

```npm
npm install --save-dev @mwillbanks/ast-mcp
```

Formatting is disabled by default. Install and configure a formatter separately only when you choose to enable formatting; ast-mcp does not download formatter binaries during file operations.

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

npm, pnpm, Yarn Classic, and Yarn 2+ project installations are supported. The runtime resolves native dependencies from the installed package; any configured formatter must already be available on the server.

Targets are `codex`, `claude`, `copilot`, or `all`. Local stdio definitions use absolute Bun runtime and CLI entry paths, pass `mcp`, and set the project directory as `cwd`; global definitions use a recognized Bun, npm, pnpm, or Yarn global-bin alias. The installer creates version 2 configuration and omits MCP environment fields. Uninstall preserves configuration.

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

[cli.output]
interactive = "human"
non_interactive = "json"

[workspace]
roots = ["."]

[safety]
filesystem = "restricted"
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
enabled = false

[telemetry]
enabled = true

[http]
host = "127.0.0.1"
port = 3768
```

Resolution is deterministic: environment overrides, project `ast-mcp.toml`, the platform global `ast-mcp/ast-mcp.toml`, then built-in defaults. The server uses MCP client workspace roots when available, so one global installation automatically selects the connected project. Existing environment variables remain supported as explicit overrides.

User-facing config, installer, and skills commands default to `human` when stdout is a terminal and `json` when redirected. Set `[cli.output]` defaults or override them with `--output human|json|yaml|toml`. See the [commands reference](https://mwillbanks.github.io/ast-mcp/docs/reference/commands/#output-formats).

Formatting is disabled by default. Enable it only with an installed external formatter configured for the target files. See the [formatting guide](https://mwillbanks.github.io/ast-mcp/docs/guides/formatting/) for dprint, Prettier, oxfmt, Biome, and other formatter setups. File access is restricted by default; see [filesystem access modes](https://mwillbanks.github.io/ast-mcp/docs/guides/filesystem-access/) before enabling unrestricted access. Unrestricted file access does not change intelligence workspace roots. Mutation tools expose a declared `files` batch. In restricted mode, version 2 requires explicit `[[paths]]` rules for file access outside the host baseline, including temporary paths.

Inspect the result with `ast-mcp config validate` and `ast-mcp config show`. See the [configuration reference](https://mwillbanks.github.io/ast-mcp/docs/reference/configuration/) for the full schema, discovery rules, cache behavior, formatter contract, safety semantics, and migration guidance.

## Telemetry

Telemetry is enabled by default. It records registered tool names, durations, outcomes, known error codes, package/build versions, random server-session IDs, and sanitized package stack frames for unexpected errors. It excludes source, file paths, arguments, responses, agent intent, raw error messages, and identifying client metadata. Set `[telemetry] enabled = false` in global configuration to disable SDK initialization and analytics network activity, or in project configuration to suppress that project's events. See the [telemetry and error reporting guide](https://mwillbanks.github.io/ast-mcp/docs/guides/telemetry/) for details and the opt-out example.

## Intelligence indexes

Open each checkout with `workspace_open` before indexing or querying it. A workspace records its checkout, repository, revision, and storage identities. This prevents a worktree request from reading or updating the repository's root checkout.

The default `global` placement shares content-addressed LanceDB artifacts across workspaces. Select `local`, `parent`, or `explicit` placement through `workspace_open` when isolation or a specific storage location is required. Cross-repository graph comparison requires `federation: true`; ordinary graph requests remain repository-scoped.

Use `index` with `build`, `refresh`, `verify`, `collect`, or `status`. Use `index_status` for a read-only health view. `graph_query`, `graph_path`, `graph_explain`, and `graph_diff` require explicit workspace IDs and return generation, evidence, coverage, freshness, and pagination metadata. LanceDB is the only persistent database.

## MCP configuration

A local stdio definition contains absolute Bun runtime and CLI entry paths, the `mcp` subcommand, and the project directory as `cwd`; a global definition uses a recognized global executable alias. Generated definitions omit environment fields. Project configuration supplies local roots. Select `--transport http` during install to generate native URL entries for Codex, Claude Code, Copilot CLI, and VS Code.

Start HTTP manually with `ast-mcp mcp --transport http [--host <address>] [--port <number>]`, or install a user service with `--service`. CLI flags override environment variables, project TOML, global TOML, and built-in defaults. The endpoint is `/mcp`; wildcard bind addresses generate loopback client URLs, while explicit non-loopback addresses deliberately expose the server. The modern HTTP protocol is stateless: it requires neither an initialize exchange nor an MCP session header. Pass `workspaceId` to reuse an application workspace opened on the same server. Legacy clients retain isolated MCP sessions; their session IDs correlate requests and are not authentication. Stdio keeps one connection state per process. HTTP uses SSE by default and emits one event per request; JSON-array responses require `enableJsonResponse`.

`SIGTERM`, `SIGINT`, and `SIGHUP` all initiate graceful shutdown. The stdio process closes its MCP server; the HTTP process stops accepting requests, closes legacy stateful sessions and the modern stateless handler, then closes remaining connections. Successful cleanup exits 0, cleanup failure exits 1, and a second signal forces exit 1 while cleanup is pending. `SIGHUP` intentionally exits after cleanup so the host supervisor can restart ast-mcp from refreshed code and configuration.

## Documentation

The full documentation covers installation, host surfaces, MCP Skills delivery and export, telemetry and error reporting, code-intelligence selection, file tools, root isolation, optional formatting, filesystem access modes, connection diagnosis, the write state machine, Streamable HTTP, evaluation workflows, configuration, and limitations.

**[Open the documentation website →](https://mwillbanks.github.io/ast-mcp/)**

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, quality gates, documentation checks, pull-request expectations, and automated release process.

## License

MIT

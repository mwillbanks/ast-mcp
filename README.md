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

`@mwillbanks/ast-mcp` combines native AST intelligence, deterministic file operations, state-machine-enforced edits, blocking hooks, and agent guidance. It gives Codex, Claude Code, GitHub Copilot, and VS Code Copilot a capable repository workflow without granting them an unbounded editor.

**[Read the documentation](https://mwillbanks.github.io/ast-mcp/)**

## Why ast-mcp

Coding agents need more than a text editor. They need a way to understand code relationships, preserve current state, and prove that an intended change is the change that reaches disk.

| Capability              | What it provides                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Structural intelligence | Directory digests, symbols, semantic search, context, calls, dependencies, cycles, impact, and public API inspection  |
| Guarded file operations | Batched hashing, bounded text reads, deterministic creation, exact patches, attributes, and reference-aware deletion  |
| Root isolation          | One shared path policy for every file and ast-bro operation, with symlink rejection and explicit external-root opt-in |
| Safe commits            | Fresh SHA-256 checks, deterministic cross-process locks, candidate formatting, hash rechecks, and atomic replacement  |
| Host enforcement        | Blocking hooks, a unified skill, and idempotent installers for Codex, Claude, Copilot, and VS Code                    |

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

Install the MCP server, blocking hooks, unified skill, and managed instructions into the current repository:

```bash
bun add --dev @mwillbanks/ast-mcp
bun pm trust @ast-bro/cli dprint
bunx ast-mcp install \
  --scope local \
  --target all \
  --root "$PWD"
```

Bun blocks transitive lifecycle scripts by default, so the explicit trust step runs the pinned ast-bro and dprint installers before the MCP starts. Targets are `codex`, `claude`, `copilot`, or `all`. Use `update` to reconcile every managed surface and `uninstall` to remove only ast-mcp-managed configuration.

From a source checkout:

```bash
bun install
bun run build
bun run bin/ast-mcp.ts install --scope local --target all --root "$PWD"
```

## MCP configuration

A minimal stdio configuration is:

```json
{
  "mcpServers": {
    "ast-mcp": {
      "command": "bun",
      "args": [
        "/absolute/path/to/node_modules/@mwillbanks/ast-mcp/dist/ast-mcp.js",
        "mcp"
      ],
      "env": { "AST_MCP_ROOTS": "/absolute/project/root" }
    }
  }
}
```

The server also supports Streamable HTTP at `/mcp` with `bun run start:http`. It binds to `127.0.0.1` by default; set `AST_MCP_HTTP_HOST=0.0.0.0` only when deliberate network exposure is required. MCP session IDs correlate requests and are not authentication; stdio remains the trusted default transport. HTTP uses SSE by default and emits one event per request; JSON-array responses require `enableJsonResponse`.

`SIGTERM`, `SIGINT`, and `SIGHUP` all initiate graceful shutdown. The stdio process closes its MCP server; the HTTP process stops accepting requests, closes every active MCP session, then closes remaining connections. Successful cleanup exits 0, cleanup failure exits 1, and a second signal forces exit 1 while cleanup is pending. `SIGHUP` intentionally exits after cleanup so the host supervisor can restart ast-mcp from refreshed code and configuration.

## Documentation

The full documentation covers installation, host surfaces, code-intelligence selection, file tools, root isolation, the write state machine, Streamable HTTP, evaluation workflows, configuration, and limitations.

**[Open the documentation website →](https://mwillbanks.github.io/ast-mcp/)**

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, quality gates, documentation checks, pull-request expectations, and automated release process.

## License

MIT

# Contributing to ast-mcp

Thanks for helping improve ast-mcp. Changes should preserve its core promise: repository access stays bounded, source inspection stays structural, and every write is deterministic, guarded, formatted, and reviewable.

## Prerequisites

- Bun 1.3 or newer
- the pinned `ast-bro` and `dprint` binaries installed by `bun install`
- a checkout with no unrelated changes in files you plan to edit

Install dependencies:

```bash
bun install
bun install --cwd website
```

## Development workflow

Use the local entry points while developing:

```bash
bun run dev
bun run dev:http
bun run inspect
```

Tests live in `tests/`. Keep stdio output protocol-safe: server diagnostics belong on stderr, never stdout.

Before opening a pull request, run:

```bash
bun run format
bun run tools:check
bun run typecheck
bun run test
bun run skill:check
bun run evals:check
bun run fallow
bun run build
bun run --cwd website lint
bun run --cwd website typecheck
bun run --cwd website test
VITE_BASE_PATH=/ast-mcp/ bun run --cwd website build
bun pm pack --dry-run
```

The formatter command intentionally applies Biome's safe and unsafe fixes and treats every remaining warning as a failure.

### Optional live host smoke checks

Live model-host checks are disabled by default. `bun run smoke:hosts` does not spawn Codex, Claude, Copilot, or any other host unless an environment variable named `AST_MCP_HOST_SMOKE_<NAME>` is present. These checks are deliberately separate from `bun run check`, CI, and release workflows.

The variable value is a JSON object with a shell-free `command` argument array, optional `expect` marker or marker array, and optional `timeoutMs`. The suffix is arbitrary, so every host uses the same opt-in contract without ast-mcp assuming a particular CLI is installed or authenticated. Independent enabled checks run concurrently.

```bash
AST_MCP_HOST_SMOKE_MY_HOST='{"command":["my-host","--non-interactive","run an ast-mcp config_status smoke check"],"expect":["config_status","generation"]}' bun run smoke:hosts
```

The default timeout is 60 seconds. Set `AST_MCP_HOST_SMOKE_TIMEOUT_MS` to change it for every enabled check, or use `timeoutMs` in one host definition. A configured host failure fails this optional command, while an unconfigured host is always skipped.

## Pull requests

- Keep changes focused and explain the user-visible or boundary-level behavior.
- Add regression coverage for changed security, path, transport, patch, installer, or lifecycle behavior.
- Update the skill templates and documentation when a public contract changes.
- Use Conventional Commits so release-please can determine the next version and changelog.
- Do not commit generated `dist/`, `website/.output/`, or dependency directories.

## Releases

Releases are automated from `main`. Release Please opens and maintains the release pull request; merging it creates the GitHub release, builds the single `ast-mcp` Bun executable, and publishes the package to npm with provenance.

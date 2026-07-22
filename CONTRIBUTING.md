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

## Pull requests

- Keep changes focused and explain the user-visible or boundary-level behavior.
- Add regression coverage for changed security, path, transport, patch, installer, or lifecycle behavior.
- Update the skill templates and documentation when a public contract changes.
- Use Conventional Commits so release-please can determine the next version and changelog.
- Do not commit generated `dist/`, `website/.output/`, or dependency directories.

## Releases

Releases are automated from `main`. Release Please opens and maintains the release pull request; merging it creates the GitHub release, builds the single `ast-mcp` Bun executable, and publishes the package to npm with provenance.

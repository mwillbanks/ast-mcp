# Contributing to ast-mcp

Thanks for helping improve ast-mcp. Changes should preserve its core promise: repository access stays bounded, source inspection stays structural, and every write is deterministic, guarded, formatted, and reviewable.

## Prerequisites

- Bun 1.4.2 or newer
- Node.js 22.19 or newer when running MCP Inspector commands
- the pinned `dprint` binary and native intelligence dependencies installed by `bun install`
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

The formatter command applies Oxfmt deterministically. Oxlint treats every warning as a failure.

### Optional live host smoke checks

Live model-host checks are disabled by default. `bun run smoke:hosts` does not spawn Codex, Claude, Copilot, or any other host unless an environment variable named `AST_MCP_HOST_SMOKE_<NAME>` is present. These checks are deliberately separate from `bun run check`, CI, and release workflows.

The variable value is a JSON object with a shell-free `command` argument array, optional `expect` marker or marker array, and optional `timeoutMs`. The suffix is arbitrary, so every host uses the same opt-in contract without ast-mcp assuming a particular CLI is installed or authenticated. Independent enabled checks run concurrently.

```bash
AST_MCP_HOST_SMOKE_MY_HOST='{"command":["my-host","--non-interactive","run an ast-mcp config_status smoke check"],"expect":["config_status","generation"]}' bun run smoke:hosts
```

The default timeout is 60 seconds. Set `AST_MCP_HOST_SMOKE_TIMEOUT_MS` to change it for every enabled check, or use `timeoutMs` in one host definition. A configured host failure fails this optional command, while an unconfigured host is always skipped.

### Native Windows proof

Use a local Windows VM when one is available. If storage prevents that, create one temporary, isolated Windows debug workflow and connect to its runner before changing Windows code. The key-only OpenSSH and Bore workflow used for PR #18 is recorded at commit `f39a5d1` (`.github/workflows/windows-debug.yml`). Restrict it to the intended PR and actor. Fetch only that actor's registered GitHub SSH keys, disable password authentication, validate `sshd_config`, and restart `sshd` before exposing port 2222. Verify the pinned Bore ZIP SHA-256 before starting the tunnel. Delete the temporary workflow after native proof; do not make shell access a release gate.

Windows Actions runners can expose the profile through an 8.3 alias. The caller's path spelling must remain native for config values and formatter arguments. Resolve aliases separately when checking authorization, containment, and locks. Use this command prompt recipe in the PR checkout with Bun 1.4.2 and dependencies installed:

```cmd
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
for %I in ("%USERPROFILE%") do @set "TEMP=%~sI\AppData\Local\Temp"
set "TMP=%TEMP%"
bun --version
set AST_MCP_SKIP_PACKAGE_SMOKE=1
bun test --max-concurrency=1 --timeout=30000 tests/config.test.ts tests/config-cli.test.ts tests/format-config.test.ts tests/git-worktrees.test.ts tests/workspace-concurrency.test.ts
bun scripts/test-shard.ts --shard 0 --shards 3
bun scripts/test-shard.ts --shard 1 --shards 3
bun scripts/test-shard.ts --shard 2 --shards 3
bun test --dots --max-concurrency=1 --timeout=30000
bun run intelligence:qualify
bun test tests/mcp.test.ts --test-name-pattern "calls native code intelligence through the server"
```

An SSH service may not inherit Bun's Actions PATH. The recipe resolves Bun from `%USERPROFILE%` and checks its version. Run tests without `--bail` during diagnosis so every failure appears. The multi-call native MCP test has a 30-second budget because a healthy Windows run can approach Bun's default five seconds. Use `git fetch` and an isolated worktree to test a pushed fix on the same runner. Use SSH keepalives for long suites. If SSH disconnects, inspect `tasklist` for an orphaned Bun suite and stop only its exact PID before restarting. Run one Windows suite at a time. Cancel automatically triggered package CI runs during diagnosis. Remove the debug workflow and run required Actions checks once after native proof. If Actions still disagree, return to a native reproducer before patching.

## Pull requests

- Keep changes focused and explain the user-visible or boundary-level behavior.
- Add regression coverage for changed security, path, transport, patch, installer, or lifecycle behavior.
- Update the skill templates and documentation when a public contract changes.
- Use Conventional Commits so release-please can determine the next version and changelog.
- Do not commit generated `dist/`, `website/.output/`, or dependency directories.

## Releases

Releases are automated from `main`. Release Please opens and maintains the release pull request; merging it creates the GitHub release, builds the single `ast-mcp` Bun executable, and publishes the package to npm with provenance.

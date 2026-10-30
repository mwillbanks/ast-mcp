# Contributing to ast-mcp

Thanks for helping improve ast-mcp. Changes should preserve its core promise: repository access stays bounded, source inspection stays structural, and every write is deterministic, guarded, and reviewable. Formatting is optional at runtime.

## Prerequisites

- Bun 1.4.4 or newer
- Node.js 22.19 or newer when running MCP Inspector commands
- native intelligence dependencies installed by `bun install`
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

Tests mirror source domains beneath `tests/`; use `tests/integration/` for cross-domain behavior and `tests/tooling/` for repository tooling. Keep shared fixtures and helpers under `tests/fixtures/` and `tests/support/`. Application modules live under `src/config`, `src/cli`, `src/installer`, `src/http`, `src/server`, `src/hooks`, and `src/skills`, alongside `src/intelligence`, `src/runtime`, `src/patch`, and `src/tools`. Operational scripts are grouped under `scripts/build`, `scripts/release`, `scripts/validation`, `scripts/testing`, and `scripts/benchmark`; host-smoke implementation belongs under `scripts/testing`. Keep stdio output protocol-safe: server diagnostics belong on stderr, never stdout.

Validate locally before committing or pushing for CI. Treat CI as independent confirmation, not the primary debugging loop.

When a check exposes a defect, inspect the related domain for the same failure class. Add a reproducer, review sibling paths, and request an independent review before pushing again. After affected checks and review pass, freeze source and run `bun run check:coverage`; a passing test suite alone does not satisfy the per-file coverage gate. Do not mutate source during validation. Restart affected and downstream gates after an edit.

Keep boundary contracts executable. Freeze configuration identity inputs for cached reloads and test ambient environment and caller mutation. Test Windows and POSIX path spellings on every host, preserve user-owned configuration through install-update-uninstall cycles, and validate remote diagnostic payloads before reusing them. Keep optional diagnostics separate from required protocol success. Preserve observed approval outcomes and propagate unrelated failures. Prefer shared parsers and ownership helpers over duplicated conditionals; add regression matrices when a source-pattern lint cannot establish behavior safely.

Before opening a pull request, run:

```bash
bun run format
bun run tools:check
bun run lint
bun run test
bun run skill:check
bun run evals:check
bun run fallow
bun run build
bun run --cwd website lint
bun run --cwd website test
BASE_PATH=/ast-mcp/ bun run --cwd website build
bun run --cwd website test:browser
bun pm pack --dry-run
```

The repository's `bun run format` command runs `bun fmt`; `bun run format:check` runs `bun fmt --check`. This development formatter is separate from ast-mcp's optional runtime formatting. Runtime formatting defaults to disabled and never downloads formatter binaries. See the [formatting guide](https://mwillbanks.github.io/ast-mcp/docs/guides/formatting/) for external formatter configuration. The `lint` script combines formatting checks, Bun typechecking, and runtime import-boundary validation. Use `bun check --no-script` to invoke Bun's native checker without the repository's aggregate `check` script. General Oxlint diagnostics beyond these gates are no longer enabled.

### Optional live host smoke checks

Live model-host checks are disabled by default. `bun run smoke:hosts` does not spawn Codex, Claude, Copilot, or any other host unless an environment variable named `AST_MCP_HOST_SMOKE_<NAME>` is present. These checks are deliberately separate from `bun run check`, CI, and release workflows.

The variable value is a JSON object with a shell-free `command` argument array, optional `expect` marker or marker array, and optional `timeoutMs`. The suffix is arbitrary, so every host uses the same opt-in contract without ast-mcp assuming a particular CLI is installed or authenticated. Independent enabled checks run concurrently.

```bash
AST_MCP_HOST_SMOKE_MY_HOST='{"command":["my-host","--non-interactive","run an ast-mcp config_status smoke check"],"expect":["config_status","generation"]}' bun run smoke:hosts
```

The default timeout is 60 seconds. Set `AST_MCP_HOST_SMOKE_TIMEOUT_MS` to change it for every enabled check, or use `timeoutMs` in one host definition. A configured host failure fails this optional command, while an unconfigured host is always skipped.

### Native Windows proof

Use a local Windows VM when one is available. If storage prevents that, create one temporary, isolated Windows debug workflow and connect to its runner before changing Windows code. The key-only OpenSSH and Bore workflow used for PR #18 is recorded at commit `f39a5d1` (`.github/workflows/windows-debug.yml`). Restrict it to the intended PR and actor. Fetch only that actor's registered GitHub SSH keys, disable password authentication, validate `sshd_config`, and restart `sshd` before exposing port 2222. Verify the pinned Bore ZIP SHA-256 before starting the tunnel. Delete the temporary workflow after native proof; do not make shell access a release gate.

Windows Actions runners can expose the profile through an 8.3 alias. The caller's path spelling must remain native for config values and formatter arguments. Resolve aliases separately when checking authorization, containment, and locks. Use this command prompt recipe in the PR checkout with Bun 1.4.4 and dependencies installed:

```cmd
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
for %I in ("%USERPROFILE%") do @set "TEMP=%~sI\AppData\Local\Temp"
set "TMP=%TEMP%"
bun --version
set AST_MCP_SKIP_PACKAGE_SMOKE=1
bun test --max-concurrency=1 --timeout=30000 tests/config/index.test.ts tests/cli/config.test.ts tests/runtime/format-config.test.ts tests/runtime/git-worktrees.test.ts tests/intelligence/workspace/concurrency.test.ts
bun scripts/testing/test-shard.ts --shard 0 --shards 3
bun scripts/testing/test-shard.ts --shard 1 --shards 3
bun scripts/testing/test-shard.ts --shard 2 --shards 3
bun test --dots --max-concurrency=1 --timeout=30000
bun run intelligence:qualify
bun test tests/integration/mcp.test.ts --test-name-pattern "calls native code intelligence through the server"
```

An SSH service may not inherit Bun's Actions PATH. The recipe resolves Bun from `%USERPROFILE%` and checks its version. Run tests without `--bail` during diagnosis so every failure appears. The multi-call native MCP test has a 30-second budget because a healthy Windows run can approach Bun's default five seconds. Use `git fetch` and an isolated worktree to test a pushed fix on the same runner. Use SSH keepalives for long suites. If SSH disconnects, inspect `tasklist` for an orphaned Bun suite and stop only its exact PID before restarting. Run one Windows suite at a time. Cancel automatically triggered package CI runs during diagnosis. Remove the debug workflow and run required Actions checks once after native proof. If Actions still disagree, return to a native reproducer before patching.

## Pull requests

- Keep changes focused and explain the user-visible or boundary-level behavior.
- Add regression coverage for changed security, path, transport, patch, installer, or lifecycle behavior.
- Update canonical MCP skill resources, evaluation fixtures, and documentation when a public contract changes.
- Use Conventional Commits so release-please can determine the next version and changelog.
- Do not commit generated `dist/`, `website/.output/`, or dependency directories.

## Releases

Releases are automated from `main`. Release Please opens and maintains the release pull request. Before validation is dispatched, the workflow formats its generated `CHANGELOG.md` with the pinned Bun formatter and checks the result. If formatting changes the file, it creates a changelog-only commit against the expected release-branch head; if already formatted, it skips that commit. It dispatches CI for the resulting exact head SHA. Formatting failures, API errors, invalid release PRs, or concurrent head changes stop dispatch. Merging the release pull request creates the GitHub release and builds one package archive. Clean Bun and npm production installations qualify those exact bytes on macOS ARM64, Linux ARM64 GNU, Linux x64, and Windows x64. ARM64 consumers also test the Bun 1.4.3 runtime minimum. Archive checksum verification and all consumer jobs must pass before npm publication with provenance. The publish job downloads the qualified archive and does not rebuild it.

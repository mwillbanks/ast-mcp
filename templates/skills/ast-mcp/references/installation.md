# Installation and recovery

Load this reference when tools disconnect, installation is incomplete, or selected instructions are stale.
Stop local mutation until the required MCP tools work.
Never use another writer to bypass the boundary.

## Identify the failing layer

Package upgrades, host configuration, runtime configuration, reconnection, and manual skills are separate operations.
Do not assume one operation repairs the others.

| Symptom                                              | Check and action                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Tools disconnect or disappear                        | Inspect host stderr and package startup. Repair the package or host command, then reconnect. |
| Tools reject current fields                          | Compare discovered schemas with the catalog. Upgrade the server package and reconnect.       |
| Host starts an old executable                        | Refresh the managed host entry with the correct local or global CLI.                         |
| Runtime configuration is outdated                    | Preview configuration migration, then write it with a backup.                                |
| Selected skill contains old instructions             | Identify its active location. Update a manual copy only when the host selects that copy.     |
| MCP resources are current but instructions are stale | Check host caches and local skill shadowing. Let the host select the intended skill.         |

Inspect pending files again after reconnection.
A failed response does not prove that no file changed.

## Diagnose the host

Start with [diagnostics.md](diagnostics.md).
Call MCP `diagnostics` for the connected server, or run `ast-mcp doctor --output json` when MCP is unavailable.
Both attempt a fresh latest stable version check.
Record unavailable registry checks explicitly and continue local diagnosis.
Distinguish the running server from project and global installations before recommending an upgrade.
For reproducible unexpected behavior, follow [issue-reporting.md](issue-reporting.md) and search existing issues first.

When this skill exists on disk and Bun is available, run its read-only checker from the active skill directory:

`bun run scripts/check-install.ts --scope local --target codex`

Pass `--root <absolute-project-path>` when the active skill directory is outside the project.
Replace `codex` with `claude` or `copilot`.
Use `--scope global` for a global installation.
For HTTP, pass `--transport http --host <address> --port <port>`.
Add `--service` only for a managed HTTP service.

The checker inspects managed guidance, host definitions, hooks, services, startup, and selected intelligence tools.
It launches the configured MCP server and calls `diagnostics` when the server advertises that tool.
Otherwise, it attempts a standalone fresh release check using a valid server version from initialization when available.
It labels the connected server version unknown when neither response supplies a valid version.
It reports unavailable diagnostics explicitly.
A bounded optional timeout or tool-level error does not invalidate successful required protocol checks.
Malformed transport, premature EOF, and natural process failures still fail the smoke check.
It reports repair commands and stale executable paths.
It does not prove complete tool coverage or MCP skill activation.
Verify those separately.

For MCP-only skill delivery, do not assume scripts have local paths.
Use host diagnostics and the installed CLI instead.
Run `bun run tools:check` only from an available AST-MCP source checkout.

## Install or upgrade the package

Obtain authorization before a package download unless the task already authorizes installation.
Choose the package manager and installation scope already used by the project.

Local npm installation or upgrade:

`npm install --save-dev @mwillbanks/ast-mcp@latest`

Use `./node_modules/.bin/ast-mcp` for subsequent local commands.
For a persistent global npm installation or upgrade:

`npm install --global @mwillbanks/ast-mcp@latest`

Use the discovered global `ast-mcp` executable for subsequent global commands.
Do not configure ephemeral package-runner paths or internal package files.
Yarn 2+ installations must use a project-local package.

For an existing source checkout, install dependencies and build before configuring a host:

`bun install`

`bun run build`

Use `bun run bin/ast-mcp.ts` as the CLI prefix for that checkout.
AST-MCP uses native Bun implementations on macOS, Linux, and Windows.

## Refresh host configuration

For a new local host installation:

`./node_modules/.bin/ast-mcp install --scope local --target codex`

For existing local managed configuration:

`./node_modules/.bin/ast-mcp update --scope local --target codex`

For global managed configuration:

`ast-mcp update --scope global --target codex`

Targets are `codex`, `claude`, `copilot`, and `all`.
These targets select managed host configuration, not a restriction on standard MCP clients.
Claude Desktop, Grok, and other clients use their host's normal MCP connection settings.
The default transport is stdio.
Use `--transport http --host <address> --port <port>` for HTTP.
Use `--service` to manage a supported macOS or Linux user service.

`update` refreshes managed host entries, hooks, and guidance blocks.
It preserves surrounding user guidance.
It does not upgrade the package or refresh manual skills.
Uninstall also preserves manual skill directories.
Host refresh preserves environment values, timeouts, tool settings, and unrelated configuration.
Launch ownership receipts let uninstall restore imported launch settings without overwriting later user edits.
Codex stores receipts in managed comments; JSON hosts use a sibling `<configuration-file>.ast-mcp.json` receipt.
Keep these receipts through installation and update; do not edit them to force removal.
Unrecognized or malformed JSON receipts stop refresh before host configuration changes.
Uninstall preserves unrecognized receipts and their server entries for inspection.
Historical or customized entries without sufficient ownership evidence remain complete, so retained entries still satisfy host configuration requirements.
Legacy hook scripts and registrations remain when their ownership cannot be established.
Inspect retained entries before any separately authorized manual removal.
For malformed runtime configuration, explicit output permits removal without loading output defaults:

`ast-mcp uninstall --scope global --target codex --output json`

Use the local CLI and local scope for local removal.
Do not uninstall merely to refresh instructions.
For Codex, honor `CODEX_HOME`, project overrides, and the selected disk profile.
A generated configuration does not prove that an active Desktop profile or CLI session loaded it.
Load [diagnostics.md](diagnostics.md) for effective-session approval conflicts.

## Migrate runtime configuration

Inspect the effective configuration:

`ast-mcp config show --output json`

Validate it:

`ast-mcp config validate --output json`

Preview version migration:

`ast-mcp config migrate --output json`

Write the reviewed migration:

`ast-mcp config migrate --write --output json`

Use `--global` for global configuration or `--file <path>` for an explicit migration target.
Migration previews by default.
Writing creates a `.v1.bak` backup unless `--no-backup` explicitly disables it.
Preserve the backup during recovery.
`--check` exits with code 2 when migration is required.
Migration does not repair arbitrary malformed or unknown settings.
Inspect diagnostics and use an authorized repair route. Never bypass local file policy.
Use `config_core` and `config_paths` for supported version 2 edits when MCP remains available.

## Select and update skills

Prefer MCP Skills when the host supports `io.modelcontextprotocol/skills`.
Upgrade the server package and reconnect to obtain current bundled resources.
Do not export or refresh disk copies unnecessarily.

The host negotiates the extension and activates the skill.
It uses `skills/list`, `skills/get`, and exact manifest resource URIs through `resources/read`.
These are protocol methods, not tools.
Verify advertised sizes and SHA-256 values, pagination, and cache metadata.
Resource retrieval alone does not activate instructions.
A selected local copy can shadow current MCP instructions.
Inspect the host-selected skill location before changing any copy.

For unsupported hosts, export to the exact skill directory:

`ast-mcp skills export .codex/skills/ast-mcp --output json`

Then let the host activate that directory.
For a selected existing manual copy:

`ast-mcp skills update .codex/skills/ast-mcp --output json`

Use the actual global, agent-local, or project-local destination.
Explicit `--output json` also permits these commands when malformed runtime configuration blocks output defaults.

Export never overwrites existing files.
The destination-local `.ast-mcp-export.json` records managed file baselines.
Update replaces tracked files only when their current hashes match those baselines.
It adds missing resources and preserves customized, untracked, and obsolete files.
Legacy files matching current bundled bytes can become tracked.
Other existing legacy files produce conflicts.

Inspect structured `written`, `updated`, `unchanged`, `preserved`, `obsolete`, and `conflicts` results.
Conflicts or operational failures produce a nonzero exit code.
Do not delete custom files or edit baseline hashes to force an update.
Reconcile conflicts through an authorized guarded workflow.
Malformed manifests and symlink traversal fail closed.
Interrupted updates can leave completed files; rerun only after inspecting the reported state.
Do not remove an export lock until you verify that its owner has stopped.

Inside the skill, resolve relative links from its active directory.
For MCP delivery, use exact manifest URIs.
Do not treat `$ast-mcp/references/...` as a filesystem expansion.

## Reconnect and verify

1. Ask the host to reconnect or restart its MCP server.
2. Confirm initialization and compare discovered tools with [tool-catalog.md](tool-catalog.md).
3. Verify current `files` batch schemas and a bounded `file_read`.
4. For MCP Skills, verify the manifest and resource hashes, then confirm host activation.
5. Inspect the selected manual skill if stale instructions remain.
6. Reinspect touched and pending files before resuming mutation.

A skill cannot start or reconnect the server.
`SIGHUP` requests graceful cleanup; the host decides whether to restart it.
Modern HTTP requires explicit `workspaceId` values across requests.
Session-dependent approvals fail closed with `approval_required`.
Use authorized global rules or a stable host approval scope.

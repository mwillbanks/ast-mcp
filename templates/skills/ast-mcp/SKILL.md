---
name: ast-mcp
description: Use for local repository exploration, code intelligence, guarded file operations, AST-MCP installation, diagnostics, recovery, and unexpected-behavior reports. Use when tools disconnect, approvals fail, configuration needs migration, or selected manual skills need updates. Do not use for unrelated remote-only research, supplied text, or general AST explanations.
---

# AST MCP

Use AST-MCP for local files and local code intelligence.
Use web or connector tools for remote content without local-file approval.
Apply local file policy when you save remote content locally.
Never use direct editors, shell writers, or interpreter writes to bypass this boundary.

## Load the correct instructions

The host selects and activates the skill.
For disk delivery, resolve relative links from the active skill directory, whether global or project-local.
For MCP delivery, request each reference through its exact manifest URI.
Do not invent a `$ast-mcp/references/...` filesystem path.
Reading a resource does not activate a skill.

- Load [tool-catalog.md](references/tool-catalog.md) for tool inputs, workspace selection, indexing, retrieval, and graph operations.
- Load [cli.md](references/cli.md) for supported CLI commands, subcommands, options, and output.
- Load [diagnostics.md](references/diagnostics.md) for failures, approval probes, host policy conflicts, and release checks.
- Load [host-context.md](references/host-context.md) for host permission limits and exact checkout selection.
- Load [issue-reporting.md](references/issue-reporting.md) before drafting or submitting an unexpected-behavior report.
- Load [patch-state-machine.md](references/patch-state-machine.md) before file mutations or recovery from rejected patches.
- Load [installation.md](references/installation.md) for missing tools, disconnections, upgrades, stale instructions, or configuration migration.
- Load [configuration.md](references/configuration.md) for path rules, approvals, formatting, telemetry, and CLI output.

## Diagnose unexpected behavior

Use MCP `diagnostics` for the connected server or CLI `doctor` when MCP is unavailable.
Every diagnostic and issue workflow must attempt a fresh latest stable version check.
Report unavailable checks explicitly. Never infer the connected version from an installed executable.
Search open and closed upstream issues before proposing a new report.
Read likely matches and preserve reporting authorization boundaries.
Keep Codex-specific recovery separate from Claude, Claude Desktop, Grok, Copilot, and other MCP hosts.

## Check availability

1. Confirm that file tools and direct intelligence tools are callable.
2. If tools are missing or disconnected, stop mutation and load the installation reference.
3. Let the host reconnect the server, then verify discovery and a bounded read.
4. Reinspect pending files after any connection failure. Never switch to another writer.

## Explore local code

1. Start unfamiliar work with `digest`. Use `map` for file structure and `show` for symbols.
2. Use `search` or `find_related` for discovery, and `context` for nearby calls.
3. Use `impact` before shared API changes. Use callers, dependencies, and graph tools to check affected code.
4. Batch independent reads when schemas permit. Keep overlapping writes and dependent operations sequential.
5. Keep native intelligence requests within one project root. Use absolute paths for linked worktrees.
6. Use `file_read` with explicit `mode` when intent matters.
7. Use source `symbols`, structured-document `selectors`, or bounded text ranges.
8. Use `document_query` for bounded JSON, JSONC, TOML, and YAML values.

Use AST-MCP as the primary repository search route.
Do not invoke `ast-grep` directly or use `sed` for repository reads.
Use `rg` only for exact literals, identifiers, non-AST formats, or discovery unavailable through AST-MCP.
Git metadata, validation, external transcripts, and runtime reproduction remain permitted exceptions.

## Select a workspace

1. Call `workspace_open` for the exact checkout and revision.
2. Pass its `workspaceId` to indexed tools and subsequent workspace-scoped calls.
3. Use `workspace_status` to inspect open workspaces.
4. Build or refresh the index before indexed retrieval when necessary.
5. Treat commit, branch, tag, and index revisions as immutable.
6. Preserve evidence and citation ranges when using retrieval or optional generation.

Modern HTTP has no implicit workspace selection across requests.
Keep the returned `workspaceId` and pass it explicitly.

## Write through guarded tools

1. Inspect each target. Call `file_capabilities` when method support is uncertain.
2. Select `ast` for structural patches or `aider_block` for small, uniquely anchored text changes.
3. Preview AST matches with bounded `run` calls. Reject capped output.
4. Use `file_patch` with `preview: true` for a guarded dry run.
5. Call `file_hash` immediately before the guarded mutation.
6. Send one path-keyed `files` batch with each target's fresh `expectedSha256`.
7. Use ordered `astRules` or `aiderBlocks` with the selected `patchStrategy`.
8. Use `file_write` for new files or permitted whole-file replacement.
9. Use `file_rename` for guarded moves. Destinations must not exist.
10. Use `file_chattr` for metadata and `file_delete` for deletion.
11. Verify changed files, then run repository validation.

`run` supports search and rewrite previews only. `write: true` fails with `use_file_patch`.
Use narrow one-match AST rules where practical. `expectedMatches` is optional; explicit counts protect reviewed intent.
Preview does not format. Commit applies enabled formatting, including receipt commits.
Mutation batches contain at most 50 requests. Rename batches create authorized missing parents without marker files.
Batch preflight checks all targets. Do not assume whole-batch crash atomicity.
Inspect incomplete and truncated bulk intelligence coverage, including budget omissions. Narrow the scope before treating missing matches as evidence.

## Stop and recover

Stop on stale hashes, ambiguous matches, stale receipts, capped reads, permission failures, or formatter failures.
Reinspect the target and rebuild the operation through the supported route.
Distinguish path policy from OS permissions. Do not broaden access without authorization.
Change `ast-mcp.toml` through `config_core` and `config_paths`, never whole-file writers.
Host approval is required by default. Model arguments cannot grant approval.

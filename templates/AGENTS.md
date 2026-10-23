# AST MCP local file boundary

Load and follow `$ast-mcp` before local repository exploration, reads, or changes.
Use AST-MCP tools for local files and code intelligence.
Never use direct editors, `apply_patch`, shell writers, interpreter writes, or Git patches for local file changes.
Use web or connector tools for remote content without local-file approval.
Apply local file policy when you save remote content locally.

## Load skill references

The host selects and activates the skill.
Resolve these paths from the host-provided active skill directory, whether global, agent-local, or project-local.
For MCP delivery, obtain the skill manifest and read each reference through its exact resource URI.
Do not treat `$ast-mcp/references/...` as a filesystem expansion.

- Load `references/tool-catalog.md` for every tool, input, limit, workspace, and MCP skill method.
- Load `references/patch-state-machine.md` before mutations or recovery from rejected patches.
- Load `references/configuration.md` for path rules, approvals, formatting, and telemetry.
- Load `references/installation.md` for missing, disconnected, outdated, or incompatible tools and stale instructions.

## Guard local changes

1. Inspect targets through AST-MCP. Use `file_capabilities` when method support is uncertain.
2. Select `ast` for structural changes or `aider_block` for small, uniquely anchored text changes.
3. Preview AST matches with bounded `run` calls. Preview the guarded patch with `file_patch` and `preview: true`.
4. Call `file_hash` immediately before mutation. Supply each fresh `expectedSha256` in one path-keyed `files` batch.
5. Send ordered `astRules` or `aiderBlocks` with the selected `patchStrategy` through `file_patch`.
6. Use `file_write` for new files and `file_rename` for guarded moves to absent destinations.
   Both create authorized missing parents. Do not create marker files to prepare destination directories.
7. Use `file_chattr` for metadata and `file_delete` for deletion. Verify results and run repository validation.

Use `run` for search and previews only. Never request `write: true`.
Change `ast-mcp.toml` only through `config_core` and `config_paths`.
Host approval is required by default. Model arguments cannot grant approval.
Use shell commands only for Git metadata, repository validation, runtime checks, or authorized package and host operations.

## Stop and recover

Stop on missing tools, disconnections, stale hashes, stale receipts, ambiguous matches, capped results, permission failures, or formatter failures.
Reinspect affected files and rebuild the guarded operation. Never switch to a fallback writer.
The host controls reconnection and skill activation. A skill cannot reconnect its server.
Follow the installation reference before repairing package versions, host entries, runtime configuration, or selected manual skills.
Treat package upgrades, host refresh, configuration migration, reconnection, and manual skill updates as separate operations.
Prefer MCP Skills. Use `ast-mcp skills update <destination>` only for an intentionally selected manual copy, and preserve customization conflicts.
If references are unavailable, inspect installed `ast-mcp --help` and host diagnostics before obtaining the missing instructions.

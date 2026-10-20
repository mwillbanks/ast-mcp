# AST MCP isolated environment

CRITICAL INSTRUCTION: You are operating in an AST-isolated environment.

- Load and follow the `$ast-mcp` skill before exploring or changing repository files.
- You have zero permission to create, overwrite, patch, move, or delete files through direct editor tools, `apply_patch`, unified patches, shell utilities, or interpreter scripts.
- For repository structure, source, dependencies, callers, and exact file content, use only ast-mcp tools.
- Use `file_capabilities` when the supported read or patch methods are uncertain; `file_read`, `run`, and `file_patch` enforce the same result.
- `file_read.mode` is agent-selectable: `ast` returns a source map/requested symbols or RFC 6901-selected structured-document values, `text` returns a bounded slice, and `auto` prefers AST. Batch multiple files in one call.
- Use `file_hash` for fresh whole-file SHA-256 values without retrieving content.
- For new files, use only `file_write`.
- For existing files, call `file_hash` immediately before a guarded `file_patch`; mutation tools declare a `files` property containing the path-keyed batch.
- The agent selects `file_patch.patchStrategy` per target from the effective methods reported by `file_capabilities`. Prefer `ast` for structural changes and `aider_block` for small exact text changes; parseable source commonly supports both.

## Available ast-mcp tools

File boundary: `file_capabilities`, `file_hash`, `file_read`, `file_write`, `file_patch`, `file_chattr`, `file_delete`.

Configuration: `config_status`, `policy_check`, `document_query`, `config_core`, `config_paths`.

Code intelligence: `digest`, `map`, `show`, `search`, `find_related`, `surface`, `deps`, `reverse_deps`, `cycles`, `graph`, `callers`, `callees`, `trace`, `impact`, `context`, `implements`, `index`, `run`, `squeeze`.

Call every intelligence tool directly by name. There is no proxy tool. Use `run` for bounded AST searches and previews. Direct `run` rewrites with `write: true` are a lower-level escape hatch for intentionally bounded cases; they remain first-match-per-file and are not the normal agent patch route. All mutation tools accept a declared `files` object, are file-operation-root bounded, SHA-guarded where required, and preflight the complete batch before committing any entry. In version 2, access outside the host baseline—including the OS temporary directory—requires an explicit top-level `[[paths]]` rule; legacy `safety.allow_temp_directory` and `safety.allow_any_path` apply only to version 1 configuration. `file_write` and `file_patch` share the `file_chattr` contract rather than independent chmod/chown keys; `file_delete` is the only directory cleanup capability and only removes empty ancestors after a successful file deletion.

## Forbidden mutation paths

Never use `apply_patch`, `patch`, direct Edit/Write/Create tools, output redirection, heredoc writes, `cat`, `echo`, `printf`, `tee`, `sed -i`, `awk`, `ed`, `touch`, `truncate`, `dd`, file-writing PowerShell commands, or interpreter one-liners to mutate files. Repository scripts invoked through Bun, Node, or another package runner are allowed when the task authorizes them; their writes are best-effort monitored rather than pre-execution provable. Never use `git apply`, destructive Git worktree commands, or `dprint fmt` as an editing bypass. Hooks deny known manual paths.

Shell commands are limited to read-only inspection that ast-mcp cannot provide and repository-defined validation. Package-manager mutation is allowed only for an explicitly authorized dependency or ast-mcp installation, never as a content-editing mechanism.

## Repository search routing

Use ast-mcp intelligence tools as the primary repository search surface: `digest`, `map`, `show`, `search`, `find_related`, `callers`, `callees`, `trace`, `impact`, and bounded `run`. Do not invoke `ast-grep` directly; ast-mcp owns structural search and rewrites. `sed` is prohibited for repository reads and edits. `rg` is a fallback only for exact literals, identifiers, non-AST formats, or discovery that ast-mcp cannot provide; do not use it as the primary search route. External transcript/session analysis, Git metadata, repository-defined validation, and live runtime reproduction remain permitted exceptions.

Change `ast-mcp.toml` only through grouped `config_core` and batched `config_paths`. Never rewrite the whole file. Host approval is required by default; `[mcp.configuration]` changes always require approval. Successful writes reload the in-process snapshot immediately.

## Required write workflow

1. Explore with the smallest direct intelligence or `file_read` call; use `impact` before shared API changes and `file_capabilities` when method support is uncertain.
2. Select `file_read.mode` explicitly when intent matters. Select `file_patch.patchStrategy` per file: AST for structural edits, Aider for small exact text edits, subject to the reported effective capabilities.
3. Preview structural matches with `run({ pattern, paths, lang?, json: true })`, bounded to explicit paths. Use `file_patch` with `preview: true` for the full guarded dry-run contract of either strategy. Preview does not format; commit, including `previewReceipt` commit, formats.
4. Call `file_hash({ filePaths })` immediately before a SHA-guarded patch.
5. Call one `file_patch({ files: { ... } })` batch with one fresh hash and matching ordered `astRules` or `aiderBlocks` per path. Each keyed path is locked and atomically committed once.
6. Use one `file_write({ files: { ... } })` batch for new files or permitted SHA-guarded whole-file replacement.
7. Use direct `run` with `rewrite` and `write: true` only when an intentionally bounded lower-level rewrite is required; do not use it instead of `file_patch` for normal agent edits.
8. Verify keyed results with `show`, `map`, `run`, or bounded `file_read` slices, then run repository validation and review the final diff without mutating through Git.

A stale hash, ambiguous Aider block, unexpected match count, capped run preview, capped file slice, dprint preflight failure, missing MCP, or lost MCP connection is a safe stop. Refresh `file_hash`, re-inspect through the correct route, or restore ast-mcp and rebuild the operation; never switch to a forbidden writer.

## Transport and transcript evidence

A JSON-RPC transport batch may contain requests and notifications. Stdio emits one framed response per request; live streamable HTTP uses SSE by default and emits one event per request. Notifications never receive responses. Preserve every request ID and do not assume the live HTTP response is a JSON array unless `enableJsonResponse` is configured.

`evals:measure` inventories direct MCP records and statically visible `tools.mcp__ast_mcp__*` calls inside top-level Codex `exec` source. Put exactly one `ast-mcp-eval:<id>` marker in the user evaluation prompt, or in a direct record input supplied by an evaluation harness, to associate following direct MCP records with that case. Marked nested `exec` evidence and multi-marker evidence fail closed because an outer result cannot prove each nested call. Scoring requires schema-relevant inputs, workspace-root compliance from transcript context, required sequencing, expected output evidence, fixture assertions, and a successful output bound to each direct call. Pass `--allow-any-path` and/or `--no-temp-directory` when the measured run used non-default file safety; scorer options are validated rather than inferred from layered project configuration.

## Missing MCP

If the skill is present but tools are absent, stop all mutation and follow the skill's `references/installation.md`. Diagnose with `scripts/check-install.ts`, install `@mwillbanks/ast-mcp` for the required local or global host surface, reconnect the MCP server, and verify all file and direct intelligence tools before continuing. Obtain authorization before downloading a package that is not already available.

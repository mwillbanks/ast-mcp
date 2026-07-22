# AST MCP isolated environment

CRITICAL INSTRUCTION: You are operating in an AST-isolated environment.

- Load and follow the `$ast-mcp` skill before exploring or changing repository files.
- You have zero permission to create, overwrite, patch, move, or delete files through direct editor tools, `apply_patch`, unified patches, shell utilities, or interpreter scripts.
- For repository structure, source, dependencies, callers, and exact file content, use only ast-mcp tools.
- AST-capable files must be inspected with AST intelligence tools, never `file_read`.
- Use `file_read` only for bounded slices of non-AST content, and batch multiple files in one call.
- Use `file_hash` for fresh whole-file SHA-256 values without retrieving content.
- For new files, use only `file_write`.
- For existing files, call `file_hash` immediately before a guarded `file_patch`; use its path-keyed batch shape for both AST and Aider operations.
- Parseable rewrite-supported files use `file_patch` with `patchStrategy: "ast"` and ordered `astRules`; unsupported, unparseable, or inspection-only formats use `patchStrategy: "aider_block"` and ordered `aiderBlocks`.

## Available ast-mcp tools

File boundary: `file_hash`, `file_read`, `file_write`, `file_patch`, `file_chattr`, `file_delete`.

Code intelligence: `digest`, `map`, `show`, `search`, `find_related`, `surface`, `deps`, `reverse_deps`, `cycles`, `graph`, `callers`, `callees`, `trace`, `impact`, `context`, `implements`, `index`, `run`, `squeeze`.

Call every intelligence tool directly by name. There is no proxy tool. Use `run` for bounded AST searches and previews. Direct `run` rewrites with `write: true` are a lower-level escape hatch for intentionally bounded cases; they remain first-match-per-file and are not the normal agent patch route. All `file_patch`, `file_write`, `file_chattr`, and `file_delete` batches are root-bounded, SHA-guarded where required, and atomically committed per keyed path. `file_write` and `file_patch` share the `file_chattr` contract rather than independent chmod/chown keys; `file_delete` is the only directory cleanup capability and only removes empty ancestors after a successful file deletion.

## Forbidden mutation paths

Never use `apply_patch`, `patch`, direct Edit/Write/Create tools, output redirection, heredoc writes, `cat`, `echo`, `printf`, `tee`, `sed -i`, `awk`, `ed`, `touch`, `truncate`, `dd`, file-writing PowerShell commands, or interpreter one-liners to mutate files. Repository scripts invoked through Bun, Node, or another package runner are allowed when the task authorizes them; their writes are best-effort monitored rather than pre-execution provable. Never use `git apply`, destructive Git worktree commands, or `dprint fmt` as an editing bypass. Hooks deny known manual paths.

Shell commands are limited to read-only inspection that ast-mcp cannot provide and repository-defined validation. Package-manager mutation is allowed only for an explicitly authorized dependency or ast-mcp installation, never as a content-editing mechanism.

## Repository search routing

Use ast-mcp intelligence tools as the primary repository search surface: `digest`, `map`, `show`, `search`, `find_related`, `callers`, `callees`, `trace`, `impact`, and bounded `run`. Do not invoke `ast-grep` directly; ast-mcp owns structural search and rewrites. `sed` is prohibited for repository reads and edits. `rg` is a fallback only for exact literals, identifiers, non-AST formats, or discovery that ast-mcp cannot provide; do not use it as the primary search route. External transcript/session analysis, Git metadata, repository-defined validation, and live runtime reproduction remain permitted exceptions.

## Required write workflow

1. Explore AST-capable content with the smallest direct intelligence call; use `impact` before shared API changes. Use batched, bounded `file_read` slices only for non-AST content.
2. Preview structural matches with `run({ pattern, paths, lang?, json: true })`, bounded to explicit paths. Use `file_patch` with `preview: true` when you need the full guarded and formatted dry-run contract.
3. Call `file_hash({ filePaths })` immediately before a SHA-guarded patch.
4. Call one keyed `file_patch` batch with one fresh hash and ordered operations per path:
   - AST targets: `{ expectedSha256, patchStrategy: "ast", astRules: [...] }`
   - Unsupported targets: `{ expectedSha256, patchStrategy: "aider_block", aiderBlocks: [...] }`
     Each keyed path is locked and atomically committed once; preview every AST rule before the batch.
5. Use one keyed `file_write` batch for new files or SHA-guarded replacement of existing non-structurally-rewritable files.
6. Use direct `run` with `rewrite` and `write: true` only when an intentionally bounded lower-level rewrite is required; do not use it instead of `file_patch` for normal agent edits.
7. Verify keyed results with `show`, `map`, `run`, or bounded `file_read` slices, then run repository validation and review the final diff without mutating through Git.

A stale hash, ambiguous Aider block, unexpected match count, capped run preview, capped file slice, dprint preflight failure, missing MCP, or lost MCP connection is a safe stop. Refresh `file_hash`, re-inspect through the correct route, or restore ast-mcp and rebuild the operation; never switch to a forbidden writer.

## Transport and transcript evidence

A JSON-RPC transport batch may contain requests and notifications. Stdio emits one framed response per request; live streamable HTTP uses SSE by default and emits one event per request. Notifications never receive responses. Preserve every request ID and do not assume the live HTTP response is a JSON array unless `enableJsonResponse` is configured.

`evals:measure` inventories direct MCP records and statically visible `tools.mcp__ast_mcp__*` calls inside top-level Codex `exec` source. Put exactly one `ast-mcp-eval:<id>` marker in the user evaluation prompt, or in a direct record input supplied by an evaluation harness, to associate following direct MCP records with that case. Marked nested `exec` evidence and multi-marker evidence fail closed because an outer result cannot prove each nested call. Scoring requires schema-relevant inputs, workspace-root compliance from transcript context, required sequencing, expected output evidence, fixture assertions, and a successful output bound to each direct call.

## Missing MCP

If the skill is present but tools are absent, stop all mutation and follow the skill's `references/installation.md`. Diagnose with `scripts/check-install.ts`, install `@mwillbanks/ast-mcp` for the required local or global host surface, reconnect the MCP server, and verify all file and direct intelligence tools before continuing. Obtain authorization before downloading a package that is not already available.

---
name: ast-mcp
description: Use ast-mcp when exploring unfamiliar code, tracing symbols or dependencies, reading and hashing files, creating files, or editing existing code under AST-isolated write rules. Also use when ast-mcp tools are missing and the MCP, hooks, or skill need local or global installation.
---

# AST MCP

Treat ast-mcp as the only code-intelligence and filesystem boundary. Do not call direct editors, `apply_patch`, shell mutation utilities, or interpreter write scripts.

## Start with availability

1. Confirm that `file_hash`, `file_read`, `file_write`, `file_patch`, and the direct intelligence tools are callable.
2. If any are unavailable, stop mutation and follow [installation.md](references/installation.md). Run `scripts/check-install.ts` to diagnose the configured host when Bun and this skill directory are available.
3. After installation, ask the host to reconnect or restart MCP servers, then list tools again. Never fall back to another writer.

## Explore before editing

- Start unfamiliar work with `digest`, use `map` for one file's shape, and use `show` for exact symbols. When a file workflow is uncertain, call `file_capabilities` once for all relevant paths; `file_read`, `run`, and `file_patch` enforce that same result.
- Use `search` when names are unknown and `find_related` for code similar to a known location.
- Use `context` for a symbol plus nearby calls; use `impact` before changing a public or shared symbol.
- Use `deps`, `reverse_deps`, `graph`, or `cycles` for module relationships.
- Use `callers`, `callees`, or `trace` for execution flow; use `implements` for type hierarchies.
- Use `surface` for exported API shape, `index` for search-index maintenance, and `squeeze` only for repetitive logs or text.
- `file_read` accepts an agent-selected `mode`: `ast` returns a source map/requested symbols or RFC 6901-selected structured-document values, `text` returns a bounded zero-based end-exclusive slice, and `auto` prefers AST when supported. Use `symbols` for source and `selectors` for JSON, JSONC, TOML, or YAML. Text mode remains available for AST-capable files when exact source text is necessary. Batch multiple files in one call.
- Use ast-mcp intelligence as the primary repository search route. Never invoke `ast-grep` directly and never use `sed` for repository reads or edits. `rg` is permitted only as a discouraged fallback for exact literals, identifiers, non-AST formats, or discovery unavailable through ast-mcp; external transcript analysis, Git metadata, validation, and live-runtime reproduction are exceptions.

Read [tool-catalog.md](references/tool-catalog.md) for exact arguments and combinations.

## Batch and parallelize safely

- Batch paths, symbols, selectors, and keyed files into one call whenever the tool schema supports them. Prefer one bounded multi-target call over repeated single-target calls.
- Issue independent read-only calls in the same model turn or host executor, and return all parallel results together when the host protocol requires it.
- Keep each AST intelligence request within one project root. Split cross-root work into root-specific calls; independent read-only calls may run in parallel.
- Linked git worktrees of the config-bearing repository are authorized according to `workspace.worktrees` (`include` by default). Pass absolute paths into a worktree; if `PWD` is a linked worktree, relative paths resolve there. Do not treat a toml-less worktree as a different project root.
- Keep dependent and overlapping work sequential: inspect, preview, hash, then mutate. Never parallelize writes that can touch the same path, configuration generation, or dependency chain.
- Call `config_status` before the first mutation when formatter selection, path policy, configuration health, or generation is uncertain. Use `policy_check` to preflight read, write, and delete decisions without side effects.
- Change `ast-mcp.toml` only through grouped `config_core` and batched `config_paths`. Do not rewrite the whole file with `file_write` or `file_patch`. Host elicitation is required by default (`mcp.configuration.require_approval = true`). Changing `[mcp.configuration]` always requires approval, including disabling the surface. Successful writes invalidate the in-process registry so the new generation applies without restarting the MCP server.
- Use `document_query` for bounded JSON, JSONC, TOML, and YAML inspection instead of attempting whole-file reads of structured manifests.

## Mutate through declared file batches

1. Inspect with `map`, `show`, `context`, a bounded `run`, or `file_read`. Call `file_capabilities` before choosing a read or patch method when intrinsic support or effective configuration is uncertain.
2. Select `file_read.mode` explicitly when intent matters. Use `ast` with `symbols` for source structure or with RFC 6901 `selectors` for structured documents; use `text` for a bounded exact slice. `auto` is suitable when AST-first behavior is desired.
3. Select `file_patch.patchStrategy` per file. Prefer `ast` for semantic, repeated, or structurally anchored changes; prefer `aider_block` for a small exact text replacement with unique context. Both remain selectable for parseable source whenever `file_capabilities` reports them, and configuration may narrow the effective choices.
4. Preview every AST rule with `run({ pattern, paths: [filePath], lang?, json: true })`; inspect all matches and reject capped output before mutation. For a contract-level dry run of either strategy, send the same `file_patch` file entry with `preview: true`. Preview returns the unformatted strategy candidate and does not run formatters; formatting occurs only at commit, including `previewReceipt` commit.
5. Call one batched `file_hash({ filePaths: [...] })` immediately before guarded edits. Keep one returned hash per file. The runtime can make hashes optional through `safety.require_hash = false`, but the normal agent workflow should still supply them whenever current-state protection matters.
6. Mutation tools accept a declared `files` property whose value is a path-keyed object. Use one `file_patch({ files: { ... } })` call for one or more files with exactly one explicit strategy and its matching ordered operations. Each path runs under one lock; preview never commits and normal mode commits atomically.
7. Use one `file_write({ files: { ... } })` batch for new files or permitted SHA-guarded whole-file replacement. Supply the shared `chattr` object when chmod/chown metadata is required. The complete batch policy preflight finishes first; in-place formatter staging may transiently create, revalidate, and remove missing parents before the guarded commit recreates them, without writing the live target.
8. Use one `file_rename({ files: { ... } })` batch for hash-guarded moves; validate every source and destination, reject existing destinations, and use no-replace moves. Ordinary failures roll back completed entries when possible; the operation is not crash-atomic.
9. Use `file_chattr({ files: { ... } })` for metadata-only changes. Use hash-guarded `file_delete({ files: { ... } })` for deletion; it preflights all targets and AST import references before any deletion, requires an explicit `forceReferences` override for referenced source, and removes empty ancestor directories after lock release.
10. Use direct `run` with `rewrite` and `write: true` only for an intentionally bounded lower-level rewrite; it is not the normal agent patch route and still rewrites only the first match per file.
11. Verify results with `show`, `map`, `run`, or bounded `file_read` slices, then run repository validation.

Version 2 grants no implicit OS-temporary access. Express every exception through the narrowest top-level `[[paths]]` rule; `request` access must be approved through the host and model arguments can never bypass policy. Legacy v1 booleans remain readable only for compatibility and should be migrated with `ast-mcp config migrate`.

Example batched AST patch:

```json
file_patch({
  "files": {
    "/repo/src/service.ts": {
      "expectedSha256": "<from file_hash>",
      "patchStrategy": "ast",
      "astRules": [
        { "pattern": "oldName($$$ARGS)", "fix": "newName($$$ARGS)", "expectedMatches": 1 },
        { "pattern": "oldFlag", "fix": "newFlag", "expectedMatches": 1 }
      ]
    }
  }
})
```

Example batched Aider patch:

```json
file_patch({
  "files": {
    "/repo/notes.md": {
      "expectedSha256": "<from file_hash>",
      "patchStrategy": "aider_block",
      "aiderBlocks": [{ "search": "old paragraph", "replace": "new paragraph" }]
    }
  }
})
```

Example batched file write:

```json
file_write({
  "files": {
    "/repo/new-a.txt": { "content": "alpha\\n" },
    "/repo/existing.txt": { "content": "beta\\n", "expectedSha256": "<from file_hash>" }
  }
})
```

MCP transport requests may use a single JSON-RPC array containing requests and notifications. The stdio transport expands the array, preserves request IDs, and emits one line per request response. The live streamable HTTP transport uses SSE by default and emits one event per request response. Neither transport emits a response for notifications; do not assume that live HTTP returns a JSON array unless `enableJsonResponse` was explicitly configured.

Read [patch-state-machine.md](references/patch-state-machine.md) for routing and rejection recovery.

## Update configuration through MCP

Use `config_core` for grouped core sections (`workspace`, `safety`, `files`, `formatting`, `http`, `dependencies`, `mcp.configuration`) and `config_paths` for batched `[[paths]]` add, update, or remove operations. Batch related keys in one group; do not send a whole-file rewrite or one call per individual key. `target` defaults to `project` and may be `global`. Version 1 files must be migrated first. When `mcp.configuration.enabled = false`, both tools fail closed.

```json
config_core({
  "safety": { "require_hash": false },
  "workspace": { "worktrees": "request" }
})
```

```json
config_paths({
  "operations": [
    {
      "op": "add",
      "rule": {
        "id": "docs",
        "path": "./docs",
        "policies": { "read": "allow", "write": "request" }
      }
    },
    { "op": "update", "id": "workspace", "rule": { "excludes": [".git/**"] } }
  ]
})
```

## Recover safely

- Stale SHA: refresh `file_hash`, re-inspect with the selected AST or text mode, and rebuild the patch.
- Zero or excess matches: narrow each AST rule; every astRules item must match exactly one node because ast-bro rewrites the first match per file, while ordered arrays let one declared `file_patch.files` entry apply multiple reviewed operations.
- Capped direct preview: narrow paths, glob, or pattern before writing.
- Unavailable method: call `file_capabilities` and select a reported read or patch method. Aider ambiguity or a disabled matcher is a safe stop; request a larger `mode: "text"` slice and expand the search block with unique surrounding context.
- Formatter preflight failure: call `config_status`, inspect the selected formatter and fallback, and do not write until stdout or staged in-place formatting succeeds. A v2 `preserve` fallback deliberately keeps unmatched content unchanged.
- MCP loss mid-task: stop writing, restore the server, then re-inspect touched and pending files through their correct AST or non-AST routes.

## Completion check

Confirm the old structure is absent through AST search, callers are correct, touched files were verified through their proper route, configured formatter-backed writes succeeded (or formatting is explicitly disabled), repository validation passes, and no direct-write or whole-file-read bypass was used.

Use `evals:check` for fixture-matrix integrity. `evals:measure` inventories batch density, parallel read-only execution, validation-error codes, calls per recorded model-tool turn, direct MCP transcript records and statically visible `tools.mcp__ast_mcp__*` calls inside top-level Codex `exec` source. Put exactly one `ast-mcp-eval:<id>` marker in the user evaluation prompt, or in a direct record input supplied by an evaluation harness, to associate the following direct MCP records with that case. An outer `exec` result cannot prove each nested call, so marked nested calls and multi-marker evidence fail closed. Scoring validates schema-relevant inputs, transcript workspace roots, required order, expected output evidence, assertions, and successful per-call outputs. When the measured run used non-default file safety, pass the validated scorer options `--allow-any-path` and/or `--no-temp-directory`; the scorer does not infer layered project configuration from a transcript. Use `evals:score --strict` only for a complete marked matrix; transcript scoring is matched task-execution evidence, not a blanket agent-quality claim.

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

- AST-capable files must be inspected with AST intelligence, never `file_read`: start unfamiliar work with `digest`, use `map` for one file's shape, and use `show` for exact symbols.
- Use `search` when names are unknown and `find_related` for code similar to a known location.
- Use `context` for a symbol plus nearby calls; use `impact` before changing a public or shared symbol.
- Use `deps`, `reverse_deps`, `graph`, or `cycles` for module relationships.
- Use `callers`, `callees`, or `trace` for execution flow; use `implements` for type hierarchies.
- Use `surface` for exported API shape, `index` for search-index maintenance, and `squeeze` only for repetitive logs or text.
- Use `file_read` only for unsupported non-AST content. Request explicit zero-based, end-exclusive line slices, accept the default `[0, 100]` only when sufficient, and batch multiple files in one call.
- Use ast-mcp intelligence as the primary repository search route. Never invoke `ast-grep` directly and never use `sed` for repository reads or edits. `rg` is permitted only as a discouraged fallback for exact literals, identifiers, non-AST formats, or discovery unavailable through ast-mcp; external transcript analysis, Git metadata, validation, and live-runtime reproduction are exceptions.

Read [tool-catalog.md](references/tool-catalog.md) for exact arguments and combinations.

## Mutate through declared file batches

1. Inspect AST-capable targets with `map`, `show`, `context`, or a bounded `run` search. For unsupported content, use one batched `file_read({ files: [...] })` call with narrow line ranges.
2. Preview every AST rule with `run({ pattern, paths: [filePath], lang?, json: true })`; inspect all matches and reject capped output before mutation. For a contract-level dry run, send the same `file_patch` file entry with `preview: true`; it returns the formatted bounded diff and never commits.
3. Call one batched `file_hash({ filePaths: [...] })` immediately before guarded edits. Keep one returned hash per file. The runtime can make hashes optional through `safety.require_hash = false`, but the normal agent workflow should still supply them whenever current-state protection matters.
4. Mutation tools accept a declared `files` property whose value is a path-keyed object. Use one `file_patch({ files: { ... } })` call for one or more files:
   - AST targets: `{ expectedSha256, patchStrategy: "ast", astRules: [{ pattern, fix, expectedMatches: 1 }], preview?: boolean }`
   - Unsupported targets: `{ expectedSha256, patchStrategy: "aider_block", aiderBlocks: [{ search, replace }], preview?: boolean }`
     Operations in each array run in order under one file lock; preview returns without committing and normal mode commits atomically.
5. Use one `file_write({ files: { ... } })` batch for new files or SHA-guarded replacement of existing non-structurally-rewritable files. Supply the shared `chattr` object when chmod/chown metadata is required; missing parents are created only after a guarded `ENOENT` write and path revalidation.
6. Use one `file_rename({ files: { ... } })` batch for hash-guarded moves; validate every source and destination, reject existing destinations, and use no-replace moves. Ordinary failures roll back completed entries when possible; the operation is not crash-atomic.
7. Use `file_chattr({ files: { ... } })` for metadata-only changes. Use hash-guarded `file_delete({ files: { ... } })` for deletion; it preflights all targets and AST import references before any deletion, requires an explicit `forceReferences` override for referenced source, and removes empty ancestor directories after lock release.
8. Use direct `run` with `rewrite` and `write: true` only for an intentionally bounded lower-level rewrite; it is not the normal agent patch route and still rewrites only the first match per file.
9. Verify results with `show`, `map`, `run`, or bounded `file_read` slices, then run repository validation.

The OS temporary directory is an allowed file-operation root by default. Set `safety.allow_temp_directory = false` to disable it. `safety.allow_any_path = true` is an explicit unrestricted mode for file tools; do not enable it merely to avoid configuring a workspace root.

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

## Recover safely

- Stale SHA: refresh `file_hash`, re-inspect through AST or a bounded unsupported-content slice, and rebuild the patch.
- Zero or excess matches: narrow each AST rule; every astRules item must match exactly one node because ast-bro rewrites the first match per file, while ordered arrays let one declared `file_patch.files` entry apply multiple reviewed operations.
- Capped direct preview: narrow paths, glob, or pattern before writing.
- Aider ambiguity: request a larger bounded slice and expand the search block with unique surrounding context.
- Formatter preflight failure: inspect the active `[formatting]` policy. Do not write until the matching external formatter or dprint fallback succeeds; `enabled = false` deliberately skips formatting.
- MCP loss mid-task: stop writing, restore the server, then re-inspect touched and pending files through their correct AST or non-AST routes.

## Completion check

Confirm the old structure is absent through AST search, callers are correct, touched files were verified through their proper route, configured formatter-backed writes succeeded (or formatting is explicitly disabled), repository validation passes, and no direct-write or whole-file-read bypass was used.

Use `evals:check` for fixture-matrix integrity. `evals:measure` inventories direct MCP transcript records and statically visible `tools.mcp__ast_mcp__*` calls inside top-level Codex `exec` source. Put exactly one `ast-mcp-eval:<id>` marker in the user evaluation prompt, or in a direct record input supplied by an evaluation harness, to associate the following direct MCP records with that case. An outer `exec` result cannot prove each nested call, so marked nested calls and multi-marker evidence fail closed. Scoring validates schema-relevant inputs, transcript workspace roots, required order, expected output evidence, assertions, and successful per-call outputs. When the measured run used non-default file safety, pass the validated scorer options `--allow-any-path` and/or `--no-temp-directory`; the scorer does not infer layered project configuration from a transcript. Use `evals:score --strict` only for a complete marked matrix; transcript scoring is matched task-execution evidence, not a blanket agent-quality claim.

# Patch state machine

The server distinguishes AST inspection from structural rewrite support. AST-capable files use `map`, `show`, `search`, `context`, or `run` for content discovery; a rewrite target is structurally capable only when its language supports `run` and ast-bro reports `error_count: 0`.

## Route selection

1. Inspect AST-capable content with intelligence tools. Inspect unsupported content with batched, bounded `file_read` slices.
2. Preview every ordered structural rule with ast-bro `run`; for the full guarded and formatted dry run, use the same keyed `file_patch` entry with `preview: true`, then obtain one fresh `file_hash` per keyed path immediately before mutation.
3. Use one path-keyed `file_patch` object for one or more files. Each value has one `expectedSha256`, one `patchStrategy`, ordered `astRules` or `aiderBlocks` arrays, and optional `preview`.
4. Use one path-keyed `file_write` object for new files or existing non-structurally-rewritable files; existing replacements still require their own fresh `expectedSha256`. Use the shared `chattr` object for chmod/chown metadata. Missing parents are created only after a guarded write returns `ENOENT`, followed by path revalidation.
5. Use `file_rename` with a fresh byte hash for root-bounded moves; preflight every source and destination, reject duplicate destinations, lock all endpoints, use no-replace moves, and roll back prior moves when a later move fails. The contract is recoverable on ordinary failures, not crash-atomic. Use `file_chattr` for metadata-only changes. Use `file_delete` with a fresh hash for deletion; it preflights all targets and AST import references before any deletion, rejects referenced source unless `forceReferences` is explicit, then removes empty ancestor directories after releasing locks.
6. Operations for one path are serialized under one lock and one atomic commit. A preview returns a bounded diff and leaves that path unchanged; a failed rule also leaves it unchanged.
7. Use direct `run` with `rewrite` and `write: true` only for an intentionally bounded lower-level rewrite; normal agent mutations belong to `file_patch`.
8. New files use `file_write`.

MCP transport requests may contain a JSON-RPC array of requests and notifications. Preserve request IDs and expect one response per request, with notifications omitted.

## Structural rule discipline

- Pattern the smallest complete syntax node that uniquely expresses the change.
- Use `$NODE` for one node and `$$NODES` for zero or more nodes.
- Preview with the same language, explicit paths, and optional glob.
- Inspect search matches, then use `file_patch` with `preview: true` for the full guarded diff; keep direct `run.write` for exceptional lower-level rewrites only.
- ast-bro 3.0.0 changes only the first match in each file; narrow ambiguous patterns rather than assuming replace-all behavior.
- Split declarations, calls, and type references into separate rules.

## Aider block discipline

The native TypeScript matcher attempts exact, whitespace-normalized, relative-indentation, and diff-match-patch matching. Use bounded `file_read` slices to identify the smallest unique surrounding block, expand the slice and block on ambiguity, and never use fallback matching to bypass a structurally rewritable route.

## Rejections

- `Stale file context`: refresh `file_hash`, re-inspect through the correct AST or bounded non-AST route, and rebuild the patch.
- AST-capable `file_read` rejection: route to `map`, `show`, `search`, `context`, or `run`.
- `matched N nodes; expected M`: inspect and narrow the rule.
- `first match per file`: reduce file_patch to one match or use a bounded direct run across files.
- capped preview or read: narrow paths, glob, pattern, line ranges, or byte caps.
- dprint preflight failure: the formatter does not support the target under the active configuration; no direct run write occurs.
- path or symlink rejection: use a real path under `AST_MCP_ROOTS`.

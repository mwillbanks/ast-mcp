# Patch state machine

The server distinguishes AST inspection from structural rewrite support. AST-capable files use `map`, `show`, `search`, `context`, or `run` for content discovery; a rewrite target is structurally capable only when its language supports `run` and ast-bro reports `error_count: 0`.

## Route selection

1. Call `file_capabilities` when the route is uncertain. It is the authoritative contract shared by `file_read`, `run`, and `file_patch`, and reports intrinsic support separately from configuration-filtered methods.
2. Choose `file_read.mode` explicitly when intent matters: `ast` returns a source map/requested symbols or RFC 6901-selected structured-document values, `text` returns a bounded slice, and `auto` prefers AST when available. Text remains selectable for AST-capable files.
3. Choose `file_patch.patchStrategy` per target. `ast` and `aider_block` are both valid for parseable source when reported by `file_capabilities`; prefer AST for semantic or repeated structural changes and Aider for a small, exact, uniquely anchored text replacement. Configuration may narrow either method but never silently changes the agent's selection.
4. Preview every ordered AST rule with `run`; for the full guarded dry run, use the same keyed `file_patch` entry with `preview: true`. Preview does not format; commit, including `previewReceipt` commit, formats. Then obtain one fresh `file_hash` per keyed path immediately before mutation. Aider patches also support the guarded preview receipt workflow.
5. Use one `file_patch({ files: { ... } })` object for one or more files. Each path value declares exactly one `patchStrategy`, the corresponding ordered `astRules` or `aiderBlocks`, optional `preview`, and normally one fresh `expectedSha256`.
6. Use one `file_write({ files: { ... } })` object for new files or explicit whole-file replacement where permitted. Use the shared `chattr` object for chmod/chown metadata. The complete batch policy preflight finishes before filesystem preparation.
7. Use `file_rename`, `file_chattr`, and `file_delete` for their dedicated operations. Rename requires source `delete` and destination `write`; guarded mutations honor `safety.require_hash` and supplied hashes are always enforced.
8. Operations for one path are serialized under one lock and one atomic commit. A preview returns a bounded diff and leaves that path unchanged; a failed rule also leaves it unchanged.
9. Use direct `run` with `rewrite` and `write: true` only for an intentionally bounded lower-level rewrite; normal agent mutations belong to `file_patch`.

MCP transport requests may contain a JSON-RPC array of requests and notifications. Preserve request IDs and expect one response per request, with notifications omitted.

## Structural rule discipline

- Pattern the smallest complete syntax node that uniquely expresses the change.
- Use `$NODE` for one node and `$$NODES` for zero or more nodes.
- Preview with the same language, explicit paths, and optional glob.
- Inspect search matches, then use `file_patch` with `preview: true` for the full guarded diff; keep direct `run.write` for exceptional lower-level rewrites only.
- ast-bro 4.2.0 changes only the first match in each file; narrow ambiguous patterns rather than assuming replace-all behavior.
- Split declarations, calls, and type references into separate rules.

## Aider block discipline

Version 2 enables exact, whitespace-normalized, relative-indentation, and diff-match-patch matching by default. Repositories may narrow `[files.patch].aider_matchers` when they intentionally want a stricter matching policy. Use `file_read` with `mode: "text"` to identify the smallest unique surrounding block, expand the slice and block on ambiguity, and select Aider only when the capability result permits it. Matcher ambiguity or a disabled fallback is a safe stop, never a reason to broaden the patch silently.

## Rejections

- `Stale file context`: refresh `file_hash`, re-inspect through the correct AST or bounded non-AST route, and rebuild the patch.
- `read_mode_unavailable` or `patch_strategy_unavailable`: call `file_capabilities`, then make a supported explicit selection; do not retry a different method blindly.
- `matched N nodes; expected M`: inspect the returned bounded locations and narrow the rule.
- `first match per file`: narrow `file_patch` to one structural node or use a bounded direct run only when the lower-level rewrite is intentional.
- capped preview or read: narrow paths, glob, pattern, line ranges, or byte caps.
- formatter preflight failure: the selected external formatter or dprint fallback does not support the target; no write occurs. Formatting is skipped only when `[formatting].enabled = false`.
- path or symlink rejection: use a real path permitted by the effective host baseline and top-level `[[paths]]` rules. Version 2 grants no implicit OS-temporary access; add a narrow explicit path rule when it is required. Legacy `safety.allow_temp_directory`, `safety.allow_any_path`, and `safety.follow_symlinks` apply only to version 1. In version 2, both a link and its resolved target must be authorized and the winning rule must set `follow_symlinks = true`.

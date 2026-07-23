# Direct tool catalog

All tools are exposed directly by ast-mcp. Do not wrap ast-bro calls in a proxy tool and do not shell out to ast-bro.

## File boundary

- `file_hash({ filePaths })`: batch up to 50 AST or non-AST paths and stream each whole file into SHA-256 without returning source content.
- `file_read({ files })`: batch up to 50 non-AST files. Each request accepts a zero-based, end-exclusive `lines` tuple and `maxBytes`; defaults are `[0, 100]` and 1 MiB, with hard caps of 1,000 lines and 1 MiB per slice. AST-capable files are rejected and routed to intelligence tools.
- `file_chattr({ "/repo/a.txt": { chattr, expectedSha256? } })`: applies the shared `chattr` contract (`chmod?`, same-owner `chown?`) under deterministic locks and reports the effective attributes.
- `file_write({ "/repo/a.txt": { content, chattr? }, "/repo/b.txt": { content, expectedSha256?, chattr? } })`: create or replace multiple files in one keyed batch; existing replacements remain limited to non-AST-rewritable files. Missing parents are created only after the write attempt returns `ENOENT`, then the path is revalidated.
- `file_patch({ "/repo/src/a.ts": { expectedSha256, patchStrategy: "ast", astRules: [...], chattr? } })`: patch one or more files in one keyed batch. Use ordered `astRules` or `aiderBlocks`; every path has one fresh hash and one atomic commit.
- `file_rename({ "/repo/a.txt": { destination, expectedSha256 } })`: renames multiple regular files in one root-bounded batch using byte-accurate hashes, locks every source and destination, rejects cross-root and duplicate/existing destinations, uses no-replace moves, rolls back prior moves when a later move fails, and reports a per-file result. Crash-atomic recovery is not guaranteed.
- `file_delete({ "/repo/a.txt": { expectedSha256, forceReferences? } })`: preflights all targets and AST import references before any deletion, rejects referenced source unless explicitly overridden, and removes empty ancestor directories within the configured root.
- The keyed mutation tools return a `files` result map. MCP transport also accepts JSON-RPC request/notification arrays and returns one response per request ID.

## Shape and source

- `digest({ paths, include_private?, include_fields?, max_members?, json? })`: compact map of unfamiliar directories.
- `map({ paths, glob?, no_private?, no_fields?, no_docs?, no_attrs?, no_lines?, json? })`: signatures, parse error counts, and line ranges.
- `show({ path, symbols, json? })`: source for known symbols.
- `surface({ path, tree?, include_chain?, include_private?, max_depth?, lang?, json? })`: public API and re-exports.

## Discovery, dependencies, and calls

- `search({ query, path?, top_k?, alpha?, languages?, json? })`, `find_related({ path, line, root?, top_k?, json? })`, `context({ target, path?, budget?, json? })`, `index({ path?, rebuild?, stats?, json? })`.
- `deps({ file, ... })`, `reverse_deps({ file, ... })`, `graph({ path?, ... })`, `cycles({ path?, ... })`.
- `callers({ target, ... })`, `callees({ target, ... })`, `trace({ from, to, ... })`, `implements({ target, paths?, direct?, json? })`.
- `impact({ target, path?, mode?, depth?, limit?, tests?, exclude_tests?, hide_ambiguous?, json? })`: combined blast radius. Valid modes are `all`, `deps`, `dependents`, and `tests`.

## Structural run

`run({ pattern, paths?, lang?, glob?, rewrite?, write?, json? })` provides:

- search when `rewrite` is omitted, including location and matched text;
- dry-run per-file diffs when `rewrite` is present and `write` is false or omitted;
- disk rewrite when both `rewrite` and `write: true` are present.

For pinned ast-bro 3.0.0, write mode changes the first match per file, caps a call at 50 files, and reports rewritten files rather than node counts. Through ast-mcp, paths are root-checked, search is repeated as a non-capped safety preview, each candidate is checked against dprint, and each rewritten file is atomically formatted. Narrow rules to one intended match per file.

- `squeeze({ path, start?, end?, raw?, json? })`: compression for repetitive logs/text, not source code.

## Common sequences

- Rename: `impact` → `show`/`context` → `run` search → `run` dry diff → bounded `run.write` → AST absence check.
- Atomic single-file edit: AST inspection → `run` search → `file_hash` → `file_patch` with one expected match → AST verification.
- Unsupported text edit: bounded batched `file_read` → `file_hash` → unique Aider block → bounded `file_read` verification.
- Refactor module: `surface` → `deps` + `reverse_deps` → `impact` → edits → `cycles`.

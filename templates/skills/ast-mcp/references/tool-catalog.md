# Direct tool catalog

All tools are exposed directly by ast-mcp. Do not wrap ast-bro calls in a proxy tool and do not shell out to ast-bro.

## File boundary

- `file_hash({ filePaths })`: batch up to 50 AST or non-AST paths and stream each whole file into SHA-256 without returning source content.
- `file_capabilities({ filePaths })`: batch up to 50 paths and return file kind, language, parse health, configuration generation, intrinsic read/patch/search support, and effective methods after configuration filtering.
- `file_read({ files })`: batch up to 50 files. Each request accepts `mode: "auto" | "ast" | "text"`, optional source `symbols`, structured-document RFC 6901 `selectors`, and `language`, plus `range: { start, end }`; the numeric zero-based, end-exclusive `lines: [start, end]` tuple remains a permanent compatibility alias. AST mode returns a source map/requested symbols or selected JSON, JSONC, TOML, or YAML values; text mode returns a bounded slice, and auto prefers AST when available.
- `file_chattr({ files: { "/repo/a.txt": { chattr, expectedSha256? } } })`: applies the shared `chattr` contract (`chmod?`, same-owner `chown?`) under deterministic locks and reports the effective attributes.
- `file_write({ files: { "/repo/a.txt": { content, chattr? }, "/repo/b.txt": { content, expectedSha256?, chattr? } } })`: create or replace multiple files in one declared batch; existing replacements remain limited to non-AST-rewritable files. The complete batch policy preflight runs first. For a new nested target, in-place formatter staging may transiently create, revalidate, and remove missing parents before the guarded commit recreates them; the live target is not written before commit.
- `file_patch({ files: { "/repo/src/a.ts": { expectedSha256?, patchStrategy: "ast" | "aider_block", astRules?: [...], aiderBlocks?: [...], chattr?, preview? } } })`: patch one or more files in one declared batch with an explicit agent-selected strategy supported by `file_capabilities`. A preview returns an opaque one-use `previewReceipt`; commit with `{ previewReceipt }` to reuse the reviewed formatted candidate after session, policy, generation, and source-hash rechecks.
- `file_rename({ files: { "/repo/a.txt": { destination, expectedSha256? } } })`: renames multiple regular files in one file-operation-root-bounded batch, locks every source and destination, rejects cross-root and duplicate/existing destinations, uses no-replace moves, rolls back prior moves when a later move fails, and reports a per-file result. Crash-atomic recovery is not guaranteed.
- `file_delete({ files: { "/repo/a.txt": { expectedSha256?, forceReferences? } } })`: preflights all targets and AST import references before any deletion, rejects referenced source unless explicitly overridden, and removes empty ancestor directories within the allowed operation root.
- `expectedSha256` is required by the secure default for patch, existing-file write, rename, and delete. `safety.require_hash = false` makes it optional; supplied hashes are always verified.
- Mutation tools use a declared `files` input object, preflight the complete batch, and return a `files` result map. Version 2 grants no implicit temporary access; use explicit top-level `[[paths]]` rules and approval policies. MCP transport also accepts JSON-RPC request/notification arrays and returns one response per request ID.
- `config_status({})` returns redacted effective configuration, source provenance, generation, health, and formatter selection.
- `policy_check({ checks })` explains batched read/write/delete decisions without side effects.
- `document_query({ filePath, selectors })` returns bounded RFC 6901-selected JSON, JSONC, TOML, or YAML values plus the whole-file hash.

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
- Atomic single-file edit: `file_capabilities` when uncertain → select AST or Aider → preview → `file_hash` → `file_patch` → matching AST or text verification.
- Exact text edit: batched `file_read` with `mode: "text"` → `file_hash` → unique Aider block → bounded text verification.
- Structured manifest: `document_query` with multiple selectors → targeted edit workflow; do not request the whole manifest.
- Uncertain mutation policy: `config_status` → batched `policy_check` → preview → hash → mutation.
- Refactor module: `surface` → `deps` + `reverse_deps` → `impact` → edits → `cycles`.

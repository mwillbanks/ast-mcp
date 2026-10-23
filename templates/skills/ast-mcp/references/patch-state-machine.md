# Guarded file operations

## Select the route

1. Call `file_capabilities` when read or patch support is uncertain.
2. Choose a reported effective method. Configuration can narrow intrinsic support.
3. Use `file_read.mode: "ast"` for symbols or structured-document selectors.
4. Use `mode: "text"` for bounded exact text. Use `auto` for AST-first selection.
5. Choose `ast` for structural changes or `aider_block` for small text changes with unique context.

## Preview and commit

1. Preview each AST pattern with `run({ pattern, paths: [absolutePath], json: true })`.
2. Inspect every match. Narrow capped results before proceeding.
3. Preview the complete patch with `file_patch` and `preview: true`.
4. Call `file_hash` immediately before mutation.
5. Supply each file's `expectedSha256` and ordered operations in one `files` object.
6. Verify each keyed result, then inspect the changed content.

`run.write: true` fails with `use_file_patch`. Never use it as a mutation escape hatch.
Preview returns an unformatted candidate. Commit runs enabled formatters.
A receipt commit supplies `previewReceipt` without `patchStrategy`, patch operations, or `preview`.
Receipts bind the inspected candidate, workspace, configuration, and expiry. The complete batch reserves receipts against concurrent replay.
Receipts are consumed only after mutation completion succeeds. Confirmed no-change failures or verified rollback release reservations.
Changed sources or uncertain recovery invalidate receipts. Reinspect and preview again after stale, expired, or uncertain results.

Each file has one lock and an atomic replacement.
Batch preflight checks all targets before committing entries. Do not assume crash atomicity across files.
Existing hashes remain mandatory by default. Always supply a fresh hash for guarded edits.

## Structural rules

- Match the smallest complete syntax node.
- Use `$NODE` for one node and `$$$NODES` for a variadic sequence.
- Separate declarations, calls, and references into ordered rules.
- Supply `pattern`, `fix`, and an optional positive `expectedMatches` for each rule.
- Prefer narrow, one-match rules with explicit counts. Do not widen a count to hide ambiguity.

```json
{
  "files": {
    "/repo/src/service.ts": {
      "expectedSha256": "<fresh SHA-256>",
      "patchStrategy": "ast",
      "astRules": [
        {
          "pattern": "oldName($$$ARGS)",
          "fix": "newName($$$ARGS)",
          "expectedMatches": 1
        }
      ]
    }
  }
}
```

## Text blocks

Read a bounded text slice, then select unique surrounding context.
Each Aider block has `search` and `replace` strings.
Version 2 enables exact, whitespace, relative-indentation, and diff-match-patch matchers by default.
Configuration can narrow these matchers.
An ambiguous match must stop the operation. Expand unique context after reinspection.

## Other operations

Use `file_write` for new files or permitted whole-file replacement.
Existing AST-capable files can require structural patches instead.
Use shared `chattr` metadata for permissions or ownership; do not add independent chmod or chown fields.

Use `file_rename` for moves.
Hash every source and verify each absent destination.
The tool checks source delete policy and destination write policy.
Moves create authorized missing destination parents without marker files. Parent policies and physical paths are revalidated before side effects.
Moves never replace destinations. Ordinary failures attempt rollback; moves are not crash-atomic.
Rollback removes only operation-owned empty directories and preserves directories created or replaced by other actors.

Use `file_delete` for files.
The tool checks references before deletion; referenced source requires explicit `forceReferences`.
Cleanup removes authorized empty ancestors only after successful file deletion.
Reference inventory and parsing are shared across all targets in a batch. Explicit overrides remain required for unverifiable references.
Default cancellation returns the string error code `aborted`. Incomplete rollback reports bounded cause codes and affected paths; inspect recovery information before retrying.

## Rejection recovery

| Result                 | Action                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| Stale hash             | Hash and inspect again. Rebuild the patch against current bytes.                           |
| Stale preview receipt  | Repeat inspection and preview. Commit the new receipt.                                     |
| Unexpected match count | Inspect returned locations and narrow the rule.                                            |
| Ambiguous Aider block  | Read more unique context and rebuild the block.                                            |
| Unavailable method     | Inspect `file_capabilities` and select a supported method.                                 |
| Capped output          | Narrow paths, patterns, ranges, or byte limits.                                            |
| Policy denial          | Inspect `policy_check` and effective configuration. Request only authorized access.        |
| OS permission failure  | Report the OS restriction. Unrestricted mode cannot bypass it.                             |
| Formatter failure      | Inspect `config_status` and the installed formatter. Repair configuration before retrying. |
| Missing file           | Confirm the path and workspace. Do not treat it as a permission error.                     |

Formatting defaults to disabled. File operations never download formatters.
Load [configuration.md](configuration.md) for formatter selection, path rules, approvals, and immutable revisions.

# Optional SQL assistance

SQL assistance improves patch feedback without requiring a dialect for guarded text edits.
Generic structural recovery counts cannot establish SQL validity.
Keep existing TypeScript and structured-document validation unchanged.

## Policy boundary

Keep validation evidence separate from permission to apply a guarded patch.
Default operations perform no dialect validation.
Requested advisory checks report bounded diagnostics and permit the patch.
Explicit required checks reject incomplete, unsupported, unavailable, or invalid results.
A per-operation skip overrides configured SQL validation requirements.
None of these options changes filesystem approval, path policy, hashes, locks, receipts, or matcher requirements.

## PostgreSQL parser qualification

The initial candidate is `libpg-query@18.2.2`, an MIT-licensed WASM binding.
Its package metadata identifies PostgreSQL parser output version 180004.
The package declares about 1.84 MB of unpacked assets and requires no native compilation.
The root orchestrator installed it in an isolated, ignored qualification directory.
No project application or database was contacted or modified.

A local Bun 1.4.4 experiment established:

- The issue 53 policy example parses successfully.
- `SELECT FROM;` produces a PostgreSQL syntax error.
- Raw SQL parsing accepts a malformed dollar-quoted function body.
- The separate PL/pgSQL parser rejects a body containing `BROKEN BODY`.

Raw parsing therefore establishes only the declared SQL grammar scope.
Function bodies, extension syntax, schema correctness, and migration execution need distinct evidence.
Unsupported coverage must remain visible and must not prevent an advisory or skipped patch.

These single-process observations are qualification evidence, not service latency guarantees:

| Measurement                              | Observed value |
| ---------------------------------------- | -------------- |
| Cold import and first small parse        | 12.68 ms       |
| Warm small-query median across 100 calls | 0.0017 ms      |
| Warm small-query 95th percentile         | 0.147 ms       |
| 65,540-byte repeated-statement parse     | 83.83 ms       |
| 524,290-byte repeated-statement parse    | 46.62 ms       |
| Process RSS after the largest sample     | About 141 MB   |

The samples are small, ordered, and affected by warmup.
Do not infer monotonic scaling or production throughput from them.
Pause validation watchers during repeatable performance measurements.

## Adapter requirements

Isolate synchronous parsing behind a bounded worker.
A Promise timeout cannot terminate blocked synchronous parsing.
Bound input bytes, concurrent workers, queue length, execution time, and output diagnostics.
Lazy initialization must avoid startup cost when assistance is not requested.
Use one end-to-end deadline for queueing, lazy initialization, parsing, and result handling; do not restart the budget when work reaches the worker.
After cancellation or deadline, bound the wait for worker retirement separately. Keep its concurrency slot and request capacity reserved until termination is confirmed.
Terminate workers on cancellation, deadline, and unexpected failure.
Do not return an unbounded PostgreSQL AST across worker boundaries.

Preserve shipped WASM and loader assets in production packages.
Never fetch parser code or assets during an ordinary tool call.
Verify real package archives offline and on supported runtime/platform layouts.
Keep optional adapter qualification outside the core patch-fix dependency path.

An adapter registry can support other dialects without treating every SQL file as PostgreSQL.
MySQL, SQL Server, Oracle, unsupported PostgreSQL versions, and extensions need their own declared coverage.
A PostgreSQL validator is not an ast-grep grammar.
Do not advertise dialect-specific structural rewrites merely because validation is available.

## Sources

- [Issue 53](https://github.com/mwillbanks/ast-mcp/issues/53)
- [libpg-query source and API](https://github.com/constructive-io/libpg-query-node)
- [libpg_query parser extraction](https://github.com/pganalyze/libpg_query)
- [WASM loading requirements](https://github.com/constructive-io/libpg-query-node/blob/main/LOADING_WASM.md)

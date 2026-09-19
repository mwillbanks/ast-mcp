# Intelligence engine qualification

This document records the native intelligence qualification baseline and packaged-runtime delivery evidence.

## Pinned dependency baseline

| Package                     | Version | License    | Qualified role                                                                         |
| --------------------------- | ------: | ---------- | -------------------------------------------------------------------------------------- |
| `@lancedb/lancedb`          |  0.39.0 | Apache-2.0 | All persistent records, vectors, full-text indexes, versions, and publication metadata |
| `apache-arrow`              |  18.1.0 | Apache-2.0 | Highest Arrow release accepted by LanceDB 0.39.0                                       |
| `@ast-grep/napi`            |  0.45.3 | MIT        | Native JavaScript and TypeScript parsing and structural matching                       |
| `tree-sitter-wasm`          |   1.1.8 | MIT        | Pinned grammar manifest and grammar WASM assets for worker-backed languages            |
| `web-tree-sitter`           |  0.27.0 | MIT        | Portable tree-sitter runtime used by packaged parser workers                           |
| `@huggingface/transformers` |   4.3.0 | Apache-2.0 | Optional local embedding inference                                                     |

LanceDB 0.39.0 optionally installs Transformers 3.0.2, which constrains its nested Sharp dependency to 0.33.x. ast-mcp does not use that legacy image pipeline. It uses the direct Transformers 4.3.0 dependency and Sharp 0.35.4. OSV exceptions for the unreachable nested Sharp path expire on 2026-10-18 and require review before renewal.

The package CI and release validation matrices run on Linux, macOS, and Windows with Bun 1.4.2. Each release target qualifies native dependencies and completes a real MCP stdio initialize, tool-list, and workspace-root handshake. LanceDB declares Node 22 or newer. Bun compatibility therefore remains an application qualification, not an upstream support promise. Transformers.js model execution works under Bun, but compiled Bun binaries remain gated by upstream static native-module and WASM-path issues.

The default embedding model is `onnx-community/granite-embedding-30m-english-ONNX`. Set `AST_MCP_EMBEDDING_MODEL` to override it. Ordinary tests do not load or download models. Run `AST_MCP_QUALIFY_EMBEDDINGS=1 bun run intelligence:qualify` for an explicit model qualification.

JSON and JSONC configuration parsing uses Bun support. The runtime does not add a JSON or JSONC parser dependency.

## LanceDB decision

LanceDB is the sole persistence engine for the planned implementation. SQLite is excluded. Every application table must declare an Arrow schema. Store heterogeneous metadata as canonical JSON text or as explicit nullable fields.

Independent append writers succeeded during qualification. Concurrent index replacement produced retryable commit conflicts. LanceDB versions and tags provide table snapshots, but LanceDB has no cross-table transaction. The implementation must use one on-demand coordinator per storage directory. The coordinator serializes schema changes, index changes, and generation publication. Workers may parse and embed concurrently.

Readers must pin a published generation manifest before reading tables. A generation becomes visible only after every referenced table version exists. Recovery must ignore or remove unpublished generations. Qualification must cover interrupted publication and bounded retries for commit conflicts.

LadybugDB is the only fallback candidate. It becomes eligible only if LanceDB cannot meet a required correctness or supported-platform gate after remediation. LadybugDB also needs coordination because separate concurrent writers contend for its single writer.

## Graphify parity inventory

Parity is pinned to Graphify revision `3f82bf7f837a07fb0f7668fbdbd5662801906942`.

Code coverage includes Python, JavaScript, TypeScript, Go, Rust, Java, Groovy, C, C++, Ruby, Swift, Kotlin, C#, Scala, PHP, Lua, Zig, PowerShell, Elixir, Objective-C, OCaml, Julia, Vue, Svelte, Astro, Dart, Verilog, SQL, R, Fortran, Pascal, Delphi and Lazarus forms, Bash, JSON, Terraform and HCL, BYOND, .NET project files, XAML, Razor, Apex, Common Lisp, Robot Framework, and solution formats.

Document coverage includes Markdown, MDX, QMD, SKILL, TXT, RST, HTML, YAML, and YML. Media classification includes PDF, images, Office documents, audio, and video. Discovery also covers package manifests, compound extensions such as `.blade.php`, extensionless shebang scripts, and sensitive-file patterns.

Extraction parity includes symbols, declarations, imports, calls, inheritance, implementations, references, source ranges, deterministic relationship evidence, confidence, incremental manifests, cross-repository references, lexical and semantic search, and optional document or media ingestion.

The pinned tree contains 959 paths, 400 test paths, 133 fixture paths, and 47 `tests/fixtures/sample.*` language fixtures. Acceptance must parse every pinned sample fixture and compare symbol, relationship, reference, and source-range counts with pinned Graphify output.

Graphify stores a global JSON graph at `~/.graphify` and repository-local output at `graphify-out`. Native publication must replace these file-replacement stores with generation-pinned LanceDB records.

## Qualification and benchmark gates

Run `bun run intelligence:qualify` for explicit-schema CRUD, full-text search, vector search, version tags, historical reads, and native AST matching. The output is machine-readable JSON.

Run `bun run intelligence:measure` for the fixed-task corpus of exported symbols, `main` callees, and `wrapper` callees. Native MCP requests use a ten-result limit and a 2,000-byte output cap. The report checks normalized symbols and call edges against independently declared expected answers. It records native cold and warm query latency and returned bytes separately. Native cold and warm correctness and guarded-workspace isolation determine the command's exit status.

The separate manual `Intelligence measurement` workflow provisions Graphify 0.9.53 and uploads the JSON report. Set `AST_MCP_RUN_GRAPHIFY=1` for an optional local comparison. Graphify and ast-mcp answer the same corpus, but Graphify uses token budgets while native MCP uses byte and item limits. The report names those units and the host, and records Graphify indexing time, cold and warm query latency, and output sizes separately. Do not infer a fair speed or size ratio from unlike limits. Comparator results do not gate CI, release, or publication. Local runs without Graphify report its unavailable status without invented measurements.

The benchmark opens a real Git fixture through the public MCP lifecycle, builds its index, reads `index_status`, and retrieves lexical evidence. The report records the returned generation, actual persisted table counts, scan coverage, and retrieved-item count. It never substitutes fixed publication or lifecycle counts.

The measurement runs native requests twice, records cold and warm latency, and verifies identical normalized results. It also runs the production `ParserWorkerPool` twice over identical TypeScript requests in one bounded pool. The report records each pass's latency, hit and miss decisions, evictions, entries, bytes, result reuse, and reuse percentage. Cold counters must show two misses and no hits. Warm counters must show two hits and no misses, with unchanged occupancy and no eviction. The indexing phase uses the production `EmbeddingWorkerPool`, a deterministic injected `EmbeddingProvider`, `LanceIntelligenceStore`, and the production chunk and embedding publication functions. It publishes two generations, records real provider cache hits and misses, measures LanceDB growth, and performs a vector query. It also verifies guarded writes across two Git worktrees and rejects sibling-worktree and out-of-scope reads. When requested, Graphify indexes once, then executes and exactly scores every fixed task in cold and warm passes under its own 2,000-token query budget.

The distribution build emits explicit dynamic, infrastructure, JVM, legacy, and systems parser-worker bundles. It copies the pinned tree-sitter manifest, runtime WASM, and available grammar WASMs into `dist/workers`. An extracted-package smoke test exercises parse, index build, index status, retrieval, and guarded writes through stdio and Streamable HTTP.

The full test suite covers indexing, branch changes, detached worktrees, renames, deletions, publication, concurrent readers, lexical search, vector search, graph traversal, and recovery. Fixtures must cover repository-local, parent, global, and explicit storage scopes. They must also cover sensitive-file exclusions and PDF, archive, and Office resource limits of 50 MiB raw, 512 MiB decompressed, and a 200:1 compression ratio.

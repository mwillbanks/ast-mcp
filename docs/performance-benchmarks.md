# File-operation benchmark decisions

## Purpose and evidence scope

Use this record to reproduce performance experiments and reassess algorithm choices.
Results describe the workloads and source phases below; they are not universal latency guarantees.
The benchmark entry point is `scripts/benchmark/benchmark-file-operations.ts`.
This record summarizes existing measurements; its creation did not run new experiments.
Detailed investigation evidence and original raw observations are preserved in the [benchmark evidence record](https://github.com/mwillbanks/ast-mcp/issues/50#issuecomment-6500321010).

## Runtime, workload, and method

The measured host used Bun 1.4.4, macOS 27.0.0, arm64, Apple M5 Max, and 128 GiB physical memory.
Final refreshed measurements followed main revision d79d64e and frozen dependency installation.
Dependencies included @types/bun 1.4.4 and posthog-node 5.56.4.
The manifest below identifies the measured source and dependency files.

Each normal sample starts a fresh Bun subprocess.
Dense fixtures repeat a 1 MiB block containing `index % 251`; sparse fixtures contain zero bytes.
Text fixtures contain deterministic ASCII lines.
An independent Node crypto stream hashes each fixture before timing, warming the filesystem cache.
Fixture generation, independent validation, and cleanup are outside the timed operation.
Recovery journal preparation is also outside its timed interval.
Process lifetime peak RSS includes startup and those preparation allocations.
It uses `process.resourceUsage().maxRSS`, converted from KiB to bytes.
It is not an allocation delta or a retained-memory measurement.

Three-sample summaries report the median and maximum observed latency.
The harness labels that maximum p95; three samples cannot establish a stable production p95.
Run experiments serially without competing tests or benchmarks.
Keep observers, fixture bytes, cache conditions, runtime, and source phase identical for causal comparisons.

Configured hash exercises the registered handler and configured execution.
It checks digest, size, path, and JSON serialization, without an MCP transport round trip.
The callback-only hash case bypasses configured execution and must remain a separate comparison.
Pagination metadata and transport latency are outside this experiment.
Durable cases check terminal journal state and zero staged snapshot directories.
Delete checks absence; rename and recovery check independently hashed output bytes.

## Algorithm decisions

| Decision              | Selected approach                                                  | Evidence and reason                                                                                |
| --------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Snapshot capture      | Stream a reusable 1 MiB buffer into private durable blobs          | Bounds memory while retaining digest and identity checks; synchronization adds latency.            |
| Journal source plans  | Serialize blob identifier, digest, size, and metadata              | Avoids file-sized Base64 strings and JSON copies. Serializer timing is not database throughput.    |
| Recovery              | Verify material and stream through guarded temporary files         | Avoids whole-file materialization; preserves durable rollback ownership and output verification.   |
| Hashing               | Node SHA-256 with 1 MiB chunks                                     | Faster than measured Bun CryptoHasher candidates; bounded capacity balances throughput and memory. |
| Bounded text reads    | Collect the requested range during the full digest stream          | Avoids a second complete read while preserving the full-file SHA-256 contract.                     |
| Newline scans         | Native Buffer.indexOf                                              | Identical counts with substantially lower scan time than JavaScript byte iteration.                |
| Reference matching    | Alias index with importer-level deduplication                      | Preserves equivalent target sets and avoids target-by-base nested scanning.                        |
| Mutation verification | One authoritative full digest after durable begin, before mutation | Avoids redundant hashing without trusting an unverified digest cache.                              |
| Directory durability  | Track changed directories, including all-new batches               | Avoids unchanged ancestors while retaining mandatory synchronization.                              |

### Rejected or bounded candidates

Seven warm-cache samples used a separate dense 128 MiB pattern, `(index * 131 + 17) & 255`.
All hashing candidates returned SHA-256 `4d441c649a6813e4076efa43c64d53866013599cdf187a1bcc865decd4bb2a7a`.

| Input and hasher                | 64 KiB median ms | 256 KiB median ms | 1 MiB median ms | 4 MiB median ms |
| ------------------------------- | ---------------: | ----------------: | --------------: | --------------: |
| Node stream                     |            97.36 |             85.24 |           81.40 |           79.44 |
| Bun CryptoHasher stream         |           104.71 |             96.49 |           94.09 |           93.75 |
| Node reusable descriptor buffer |           144.57 |             95.81 |           91.44 |           90.83 |

Reject Bun CryptoHasher for this measured workload because every candidate was slower.
Keep 1 MiB descriptor buffers: 4 MiB improved latency by less than 1% while quadrupling capacity.
The candidate current-process RSS readings do not establish comparable peak-memory measurements.

Native newline scans used 1 MiB buffers, seven samples, and 30 repetitions per sample.
Median scan times changed from 5.5088 to 0.01577 ms for one long line.
They changed from 9.7691 to 0.02497 ms for 1,000 lines.
They changed from 11.0974 to 0.17744 ms for 13,108 lines.
All counts matched.

## Historical five-pass evidence

These controlled comparisons precede later portability, durability, cleanup, and dependency refinements.
They explain selection decisions and must not be presented as current-source timings.
The original baseline revision was `834671b6e511687cf00fd4a8808f1f888919621b`.

| Pass                    | Workload                            | Historical result                                                       | Interpretation                                                                    |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1: durable snapshots    | Dense 128 MiB, three samples        | Legacy 55.793 ms / 188.44 MiB peak; blob 76.978 ms / 94.53 MiB          | 49.83% lower peak RSS, with 37.97% higher latency and stronger durability.        |
| 2: compact source plans | Dense 128 MiB, three samples        | Legacy 38.184 ms / 531.34 MiB; blob 0.099 ms / 98.66 MiB                | Removes payload serialization; no file-throughput claim.                          |
| 3: streamed recovery    | Dense 128 MiB, three samples        | Repaired legacy 1835.468 ms / 3698.60 MiB; blob 288.933 ms / 118.55 MiB | 84.26% lower latency and 96.79% lower lifetime peak RSS in this phase.            |
| 4: hashing and reads    | Dense 16 MiB, three samples         | Hash 32.063 to 14.949 ms; bounded read 40.349 to 17.427 ms              | Historical 53.38% and 56.81% reductions with matching observers.                  |
| 5: indexed matching     | 50 targets, 200 importers, 12 bases | Initial nested control 7.885708 ms; initial index 0.085250 ms           | Initial index result is historical; later corrected-index evidence follows below. |

Legacy recovery used a repaired linear Base64 validator.
The original validator rejected valid 16 MiB Base64 before recovery; failed setup has no throughput.
Memory-only legacy snapshots provide less durability than synchronized blobs.
Later directory-sync and hashing refinements changed recovery latency; preserve source-phase distinctions.

End-to-end mutation timing was mixed and sensitive to host variation.
Unchanged final source produced substantially different timings across repeated measurement windows.
Do not infer a universal mutation latency gain from the alias microbenchmark.

### Corrected reference-index evidence

The corrected index remains unchanged in the final refreshed manifest.
Seven samples compared it against a semantically equivalent nested control with hoisted per-target extension calculations.
This is not a timing of the literal previous implementation.
Each indexed timing included index construction.
All results matched sorted JSON sets containing 1,600 importer-target pairs.

| Algorithm       | Median ms | Maximum ms | Seven latency samples ms                                             |
| --------------- | --------: | ---------: | -------------------------------------------------------------------- |
| Nested control  |  8.184750 |   8.638709 | 8.507500, 8.086708, 8.092000, 8.014666, 8.557708, 8.638709, 8.184750 |
| Corrected index |  0.390167 |   1.808458 | 1.808458, 0.493084, 0.847708, 0.390167, 0.370167, 0.379750, 0.370583 |

Median matching latency was 95.23% lower against this control.
The 50-target workload fits the public batch limit.
It includes duplicate and missing bases, full paths, extensionless paths, and index-directory aliases.
It excludes parsing, traversal, journal work, and complete deletion latency.
Synthetic 1,000-target experiments exceed the public batch limit and are not production batch claims.

## Measurements before publication compatibility changes

These measurements include the changed-directory ledger, bounded cleanup fixes, snapshot identity guards, and cooperative hash deadlines.
They precede the subsequent exclusive-copy publication change; the follow-up below remeasures affected recovery paths.
All commands ran serially with production deadlines and no deadline override.

```sh
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=134217728 --iterations=3 --dataset=dense --operations=snapshot,journal,recovery --representation=blob
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=2321660787 --iterations=1 --dataset=dense --operations=hash-configured,durable-delete,durable-rename,recovery --representation=blob --allow-large=true
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=2321660787 --iterations=1 --dataset=sparse --operations=hash-configured,durable-delete,durable-rename,recovery,durable-batch-delete --representation=blob --allow-large=true
```

### Dense 128 MiB distributions

All nine samples passed; recovery journals reached recovered with zero staged snapshot directories.

| Operation                 | Raw latency samples ms             |  Median ms | Raw lifetime peak RSS samples bytes |
| ------------------------- | ---------------------------------- | ---------: | ----------------------------------- |
| Snapshot                  | 67.144250, 67.366209, 67.509833    |  67.366209 | 93996032, 94487552, 95552512        |
| Source-plan serialization | 0.052458, 0.075084, 0.064250       |   0.064250 | 97960960, 93225984, 119325696       |
| Recovery                  | 221.912750, 224.944417, 224.988375 | 224.944417 | 142492672, 138773504, 133415936     |

Snapshot throughput was 1900.06 MiB/s; recovery throughput was 569.03 MiB/s.
Compact serialization has no file-throughput result.

### Large-file correctness and latency

Each file contains 2,321,660,787 bytes.
The sparse batch contains three independently verified files, totalling 6,964,982,361 logical bytes.
All nine cases passed.
All durable journals were terminal with zero staged snapshot directories before harness cleanup.

| Dataset | Operation            |  Latency ms | Lifetime peak RSS bytes |
| ------- | -------------------- | ----------: | ----------------------: |
| Dense   | Configured hash      |  764.659542 |               130827264 |
| Dense   | Durable delete       | 2814.852416 |               174932992 |
| Dense   | Durable rename       | 5138.463000 |               182141952 |
| Dense   | Recovery             | 3274.881125 |               141968384 |
| Sparse  | Configured hash      |  765.180542 |               113198080 |
| Sparse  | Durable delete       | 2799.667959 |               209470464 |
| Sparse  | Durable rename       | 4986.989583 |               204178432 |
| Sparse  | Recovery             | 3304.040875 |               131400704 |
| Sparse  | Durable batch delete | 7709.422833 |               181355520 |

These single samples establish execution success on this host, not stable median or tail latency.
Sparse logical size does not imply equivalent physical allocation or disk throughput.
Configured hashing did not reproduce a maximum-string-size failure.

### Measured source manifest

```json
[
  {
    "path": "src/runtime/hash.ts",
    "sha256": "8ef8219ddf1fcacdc9f5f5a85bf2318ea436200718345254f392c335e272409c"
  },
  {
    "path": "src/runtime/file-read.ts",
    "sha256": "1a26c69ad409f201f4e40742bfc47f8b2d6650fed76fc8fee33762c5ea3b9949"
  },
  {
    "path": "src/runtime/file-delete.ts",
    "sha256": "d6d8a225825489f1bd6661cbc1f8ca876a27fa51bb234ebd9bf1aa134e4da7df"
  },
  {
    "path": "src/runtime/file-rename.ts",
    "sha256": "986e2a9a1d26dfd85a3c1614f8f1751d144972e4494e0525f9cbbe21ca54be6e"
  },
  {
    "path": "src/runtime/reference-target-index.ts",
    "sha256": "61bb0fcbe807cf7e47b248e8c8157e9c0657f1fa83327510ad6d75435d43a282"
  },
  {
    "path": "src/intelligence/mutation/service.ts",
    "sha256": "5052199616172e2ef64bc28bf8c9b6844ac981cbef4c5f7e16682932343ed8b1"
  },
  {
    "path": "src/runtime/snapshot-blob.ts",
    "sha256": "8d0a1442bc428c993aa16de218b6647757659da2708875433d2583f7073164d1"
  },
  {
    "path": "src/runtime/attributes.ts",
    "sha256": "176864b56f18bc47187b604c0ab1247886427ecc20cdfa65313d069366478145"
  },
  {
    "path": "src/patch/engine.ts",
    "sha256": "18fed5adfae3aaee9dcbfdfd2bf5340efaf3de5dc490580c7c3f554e7e39b0cc"
  },
  {
    "path": "scripts/benchmark/benchmark-file-operations.ts",
    "sha256": "bbeeec407269656f8829991b4ca4bd5e1bc4696bb7972d22f4727d94194a0a7a"
  },
  {
    "path": "package.json",
    "sha256": "2d0455c68e7edaa48d681e6a881fb6646f6139cb021fbc80895ab8c4c873e3c7"
  },
  {
    "path": "bun.lock",
    "sha256": "3a92ac404d60a10ef5a2925b7fd4ead204267fa2e5641be8da298cc79ebf5125"
  }
]
```

## Recovery publication compatibility follow-up

After adding exclusive-copy publication fallback, rerun only the affected recovery paths.
The runtime, dependency set, fixtures, cache protocol, observers, and production deadlines match the preceding measurements.
The normal hard-link publication path was exercised; fallback latency was not benchmarked.
Targeted fault tests separately verify fallback bytes, metadata, ownership, and cleanup.

```sh
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=134217728 --iterations=3 --dataset=dense --operations=recovery --representation=blob
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=2321660787 --iterations=1 --dataset=dense --operations=recovery --representation=blob --allow-large=true
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=2321660787 --iterations=1 --dataset=sparse --operations=recovery --representation=blob --allow-large=true
```

| Workload                   | Raw latency samples ms             |   Median ms | Raw lifetime peak RSS samples bytes |
| -------------------------- | ---------------------------------- | ----------: | ----------------------------------- |
| Dense 128 MiB              | 220.547000, 217.999208, 223.545167 |  220.547000 | 142410752, 131138560, 126174208     |
| Dense 2,321,660,787 bytes  | 3221.114625                        | 3221.114625 | 149849088                           |
| Sparse 2,321,660,787 bytes | 3209.513041                        | 3209.513041 | 154895360                           |

All five samples passed independent digest verification and reached recovered journals with zero staged snapshot directories.
The 128 MiB median corresponds to 580.38 MiB/s in this warm-cache workload.
Single large-file samples do not establish stable tail latency or a causal improvement over the preceding phase.
The earlier snapshot, serialization, deletion, rename, and retention observations remain phase-specific evidence.

Changed measured source hashes are:

```json
[
  {
    "path": "src/runtime/snapshot-blob.ts",
    "sha256": "3492f1f50b31d6f2e49a415802ec3d2b5bf4a78a0214d3206b329adfaa29c275"
  },
  {
    "path": "src/intelligence/mutation/service.ts",
    "sha256": "e17a9957849e75ae0911acee7fd6d5f068ab08ea95ab81bf8eaf988430b22179"
  }
]
```

Other measured source and dependency hashes remain as listed in the preceding manifest.

## Safety costs and limits

Snapshots synchronize blob contents and, on supported POSIX filesystems, changed directories, adding I/O compared with memory-only capture.
Recovery retains full digest verification and guarded target checks.
Clean readonly Windows recovery and rename preserve verified identity, digest, and mode.
Modified targets still require file synchronization.
The Windows directory-sync helper currently performs no flush: the portable runtime path does not provide the POSIX directory-fsync operation.
A terminal journal state therefore does not establish Windows directory-entry persistence across power loss.
This is an explicit platform limitation, not a verified durable-publication guarantee.
Microsoft documents separate requirements for [directory handles](https://learn.microsoft.com/en-us/windows/win32/fileio/obtaining-a-handle-to-a-directory) and [buffer flushing](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).
Windows behavior requires regression validation; these latency results were measured on macOS.

Hash deadlines are cooperative between reads and cannot forcibly cancel an operating-system read already in progress.
Temporary cleanup checks pathname identity before unlinking.
A concurrent directory writer can replace the pathname between lstat and unlink; this is not atomic compare-and-unlink.
Inaccessible mode-000 recovery targets can fail closed and retain material until permissions permit repair.
Authorization checks remain enforced.

Restore publication prefers atomic hard links.
If publication returns a recognized unsupported-link error or EPERM, recovery can stream into an exclusively created mode-0600 destination.
This fallback never overwrites an existing entry, but the partial pathname is visible while copying; permissions broaden only after complete bytes are verified.
Failure cleanup checks owned inode identity and retains the original recovery material.
The adjacent mutation-lock protocol still requires hard-link support; an entirely linkless target filesystem fails closed before guarded deletion.
The publication fallback does not establish general support for such filesystems.

The harness reports cleanup failures as failures and preserves all disposer diagnostics.
A failed sample must not contribute successful throughput.
Peak RSS includes allocations outside timing and cannot establish long-lived retention.
No cold-cache, concurrent-client, transport, or Windows throughput claim follows from these experiments.

## Retention evidence and future experiments

A historical pre-portability experiment ran 100 mixed 16 MiB requests in one process, followed by 35 seconds idle and GC.
All requests succeeded with zero staged snapshot directories.
The timed workload lasted 13.348 seconds; idle time was excluded.
Lifetime peak RSS was 122.33 MiB.
Heap-used and external counters still rose late in the run, then decreased after idle.
Counter ownership and allocator behavior remain uncertain.
This is not proof of a permanent plateau or leak-free execution.

Reproduce the retention workload separately from isolated latency samples:

```sh
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=16777216 --iterations=1 --dataset=dense --operations=soak --soak-requests=100 --settle-ms=35000 --representation=blob
```

Test the following hypotheses before changing retained algorithms:

- Larger chunks may help other storage devices; compare equal digests, latency distributions, and subprocess peak RSS.
- Database overhead may dominate small durable mutations; separate journal preparation, commit, and refresh costs.
- Native caches or timeout ownership may contribute retained counters; use longer runs and repeated idle/GC observations.
- Concurrency may change throughput and memory bounds; test bounded client counts with corruption and rollback checks.
- Cold-cache behavior may differ; record an explicit cache protocol and avoid mixing it with warm-cache samples.

Rerun after runtime, native dependency, hashing, snapshot, recovery, journal, or filesystem changes affect measured paths.
Also rerun when fixture distributions, concurrency, storage devices, or observation boundaries change.
Record source hashes, exact commands, runtime, host, cache conditions, sample order, and failures.
Keep production deadlines and independent digest, absence, journal, and cleanup checks.
Compare equivalent safety guarantees; disclose synchronization or observer differences.
Require repeatable distributions and correctness before retaining a performance change.
Reject gains that weaken safety or create unbounded memory growth.

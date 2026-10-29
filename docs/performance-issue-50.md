# File-operation performance and issue 50

## Method

Measurements use Bun 1.4.4 on macOS 27.0.0, arm64, Apple M5 Max, with 128 GiB physical memory.
Each sample starts a fresh Bun subprocess.
Fixtures use deterministic dense bytes, or sparse zero bytes when explicitly requested.
The dense pattern repeats a 1 MiB block containing `index % 251`.
Text-read fixtures use deterministic ASCII lines.
An independent Node crypto SHA-256 stream validates each fixture before timing.
This warms the filesystem cache; these results describe warm-cache operations.
Generation, independent validation, and cleanup are outside the timed operation.
Peak RSS uses `process.resourceUsage().maxRSS`, converted from KiB to bytes.
It includes process startup, fixture setup, and recovery journal setup.
It is a process lifetime peak, not an allocation delta.
Three samples provide a median and the maximum observed latency, labelled p95.
Three samples do not establish a statistically stable production p95.

Run the main baseline:

```sh
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=16777216 --iterations=3 --dataset=dense --operations=hash,hash-tool,read,snapshot,journal,delete,rename
```

The `hash-tool` case calls the registered `file_hash` handler and serializes its normal result.
It validates the returned digest, size, and path.
This tests the registration and result wrapper; it does not measure an MCP transport round trip.
The initial delete and rename measurements call their guarded runtime functions without a selected workspace.
They include authorization, locks, snapshots, and verification, but exclude durable Lance journal writes.
The recovery case uses the real Lance journal and lifecycle.

## Baseline

| Dense 16 MiB operation        | Median ms | Observed p95 ms |   MiB/s | Peak RSS MiB |
| ----------------------------- | --------: | --------------: | ------: | -----------: |
| Hash batch                    |    32.063 |          35.443 |  499.01 |        75.74 |
| Registered hash tool          |    36.865 |          38.240 |  434.01 |        77.30 |
| Bounded text read             |    40.349 |          45.290 |  396.54 |        77.00 |
| Buffered snapshot             |    13.400 |          14.766 | 1194.06 |        77.14 |
| Base64 and JSON serialization |     8.473 |           9.082 |       — |       118.36 |
| Guarded delete                |   107.959 |         120.140 |  148.20 |       115.19 |
| Guarded rename                |   180.381 |         181.162 |   88.70 |       137.59 |

The old recovery setup fails before mutation for a 16 MiB dense snapshot.
The journal rejects the valid Base64 string through its validation regular expression.
This is separate from the reported maximum-string-size failure at multi-gigabyte sizes.
The failed setup has no recovery throughput result.

The large hash case uses:

```sh
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=2321660787 --iterations=1 --dataset=dense --operations=hash-tool --allow-large=true
```

The unchanged registered hash path successfully hashed 2,321,660,787 dense bytes.
Its result matched an independent streaming SHA-256.
Measured latency was 1,786.501 ms, throughput was 1,239.35 MiB/s, and peak RSS was 118.16 MiB.
This single sample does not reproduce `ERR_STRING_TOO_LONG` in `file_hash`.
It supports the source finding that the live hash helper and result wrapper stream file content.

## Initial-phase optimization measurements

The five passes in this section describe the initial implementation phase.
Later source-phase measurements follow below; final-review results appear in the final frozen-source section.

The initial baseline used unchanged source at revision `834671b6e511687cf00fd4a8808f1f888919621b`.
Subsequent comparisons use the supported legacy and blob representations in the same frozen post-core source.
Legacy recovery uses the repaired linear Base64 validator.
It does not represent the original validator failure.

### Pass 1: bounded durable snapshots

The legacy path retains the entire file buffer.
The new path streams one reusable 1 MiB buffer into a private, digest-verified, durable snapshot.
It also synchronizes the blob and its directories before publication.
At 128 MiB, peak RSS fell 49.83%, from 188.44 MiB to 94.53 MiB.
Median latency increased 37.97%, from 55.793 ms to 76.978 ms.
Retain this change for bounded memory and durable recovery.
The memory-only baseline performs less I/O and does not provide equivalent durability.

### Pass 2: compact journal source plans

The new source plan carries a blob identifier, digest, size, and metadata.
It avoids Base64 encoding and serializing source bytes.
At 128 MiB, serialization latency fell 99.74%, from 38.184 ms to 0.099 ms.
Process peak RSS fell 81.43%, from 531.34 MiB to 98.66 MiB.
Retain the compact source plan.
This case measures source-plan construction and JSON serialization, not journal database throughput.
The serializer case omits file-throughput results because compact plans do not process source bytes.

### Pass 3: streamed durable recovery

Both representations exercise the real Lance journal and recovery lifecycle.
The blob path verifies recovery material and streams restoration through guarded temporary files.
At 128 MiB, median recovery latency fell 84.26%, from 1,835.468 ms to 288.933 ms.
Throughput increased from 69.74 MiB/s to 443.01 MiB/s.
Process peak RSS fell 96.79%, from 3,698.60 MiB to 118.55 MiB.
Retain streamed recovery.
The memory figures include journal preparation outside the timed recovery interval.

Run each representation sequentially:

```sh
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=134217728 --iterations=3 --dataset=dense --operations=snapshot,journal,recovery --representation=legacy
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=134217728 --iterations=3 --dataset=dense --operations=snapshot,journal,recovery --representation=blob
```

| Pass                        | Representation                 | Median ms | Observed p95 ms | Peak RSS MiB | Successful samples |
| --------------------------- | ------------------------------ | --------: | --------------: | -----------: | -----------------: |
| 1 snapshot                  | Legacy                         |    55.793 |          56.614 |       188.44 |                3/3 |
| 1 snapshot                  | Blob                           |    76.978 |          77.774 |        94.53 |                3/3 |
| 2 source-plan serialization | Legacy                         |    38.184 |          38.317 |       531.34 |                3/3 |
| 2 source-plan serialization | Blob                           |     0.099 |           0.104 |        98.66 |                3/3 |
| 3 recovery                  | Legacy with repaired validator | 1,835.468 |       1,838.647 |     3,698.60 |                3/3 |
| 3 recovery                  | Blob                           |   288.933 |         290.827 |       118.55 |                3/3 |

Raw sample distributions preserve collection order:

| Operation and representation | Latency samples ms                    | Peak RSS samples bytes             |
| ---------------------------- | ------------------------------------- | ---------------------------------- |
| Snapshot legacy              | 55.793459, 56.614208, 55.159334       | 197329920, 197510144, 197592064    |
| Snapshot blob                | 76.978166, 75.790542, 77.773667       | 92259328, 94290944, 99124224       |
| Serialization legacy         | 38.184000, 37.474125, 38.316667       | 557155328, 554812416, 555844608    |
| Serialization blob           | 0.097125, 0.103750, 0.099000          | 103449600, 98862080, 95749120      |
| Recovery legacy              | 1838.646875, 1775.446292, 1835.467625 | 3570095104, 3878260736, 3648263168 |
| Recovery blob                | 287.171875, 288.933250, 290.826709    | 124306432, 118195200, 104989696    |

### Pass 4: bounded hash and read tuning

The runtime uses 1 MiB SHA-256 chunks and collects bounded text during the full digest stream.
Native Buffer.indexOf scans replace JavaScript byte loops for newline counting.
All 12 dense 16 MiB samples succeeded.

| Operation               | Median ms | Observed p95 ms |   MiB/s | Peak RSS MiB | Median latency reduction from original |
| ----------------------- | --------: | --------------: | ------: | -----------: | -------------------------------------: |
| Hash batch              |    14.949 |          15.225 | 1070.34 |        78.17 |                                 53.38% |
| Registered callback     |    16.792 |          19.162 |  952.81 |        77.78 |                                 54.45% |
| Configured hash handler |    62.277 |          63.186 |  256.92 |        80.59 |                   No matching baseline |
| Bounded text read       |    17.427 |          18.503 |  918.10 |        77.64 |                                 56.81% |

The configured case exercises actual configuredExecution, workspace selection, configuration, and approval handling.
Its minimal server advertises no client capabilities.
It validates structured digest, size, path, and JSON serialization.
It does not exercise an MCP transport.
The earlier callback case supplies an execution override and bypasses configuredExecution.

```sh
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=16777216 --iterations=3 --dataset=dense --operations=hash,hash-tool,hash-configured,read
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=134217728 --iterations=3 --dataset=dense --operations=recovery --representation=blob
```

After recovery directory synchronization fixes and hash tuning, dense 128 MiB recovery succeeded in all three samples.
Median latency was 256.680 ms, observed p95 was 261.810 ms, and throughput was 498.68 MiB/s.
Peak RSS was 121.97 MiB.
This durability-corrected result supersedes the provisional pass-3 blob result.
Compared with repaired legacy recovery, latency fell 86.02%.

| Operation              | Latency samples ms                 | Peak RSS samples bytes          |
| ---------------------- | ---------------------------------- | ------------------------------- |
| Hash                   | 14.383917, 15.225375, 14.948583    | 79660032, 81970176, 79135744    |
| Callback               | 16.049500, 19.162458, 16.792417    | 80544768, 81560576, 81216512    |
| Configured hash        | 63.185625, 61.942917, 62.276875    | 84444160, 84509696, 84296704    |
| Read                   | 17.427292, 18.502541, 17.252208    | 80331776, 81413120, 79774720    |
| Final durable recovery | 256.679917, 255.908375, 261.809667 | 118342656, 110494720, 127894528 |

#### Candidate selection

A separate same-host experiment used dense 128 MiB files and seven warm-cache samples per candidate.
Its byte pattern was (index * 131 + 17) & 255.
Each candidate returned SHA-256 4d441c649a6813e4076efa43c64d53866013599cdf187a1bcc865decd4bb2a7a.
The p95 column is the maximum of seven samples.

| Hasher and input                | Chunk KiB | Median ms | Observed p95 ms |
| ------------------------------- | --------: | --------: | --------------: |
| Node stream                     |        64 |     97.36 |          103.53 |
| Node stream                     |       256 |     85.24 |          105.74 |
| Node stream                     |      1024 |     81.40 |           83.60 |
| Node stream                     |      4096 |     79.44 |           81.72 |
| Bun CryptoHasher stream         |        64 |    104.71 |          109.83 |
| Bun CryptoHasher stream         |       256 |     96.49 |          101.74 |
| Bun CryptoHasher stream         |      1024 |     94.09 |          100.73 |
| Bun CryptoHasher stream         |      4096 |     93.75 |          100.02 |
| Node reusable descriptor buffer |        64 |    144.57 |          164.75 |
| Node reusable descriptor buffer |       256 |     95.81 |           96.90 |
| Node reusable descriptor buffer |      1024 |     91.44 |           93.80 |
| Node reusable descriptor buffer |      4096 |     90.83 |           91.74 |

Retain Node SHA-256 with a bounded 1 MiB buffer.
Bun CryptoHasher was slower on this host.
The 4 MiB descriptor buffer added less than 1% speed while quadrupling buffer capacity.
Candidate current-process RSS does not establish comparable memory peaks.

Native newline scans used 1 MiB buffers, seven samples, and 30 repetitions per sample.
Median single-long-line scan time fell from 5.5088 ms to 0.01577 ms.
For 1,000 lines, it fell from 9.7691 ms to 0.02497 ms.
For 13,108 lines, it fell from 11.0974 ms to 0.17744 ms.
All line counts matched.

### Pass 5: mutation baseline before final tuning

The following dense 128 MiB samples precede pass-5 source changes.
All 12 samples succeeded.

```sh
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=134217728 --iterations=3 --dataset=dense --operations=delete,rename,durable-delete,durable-rename --representation=blob
```

| Operation      | Median ms | Observed p95 ms |  MiB/s | Peak RSS MiB |
| -------------- | --------: | --------------: | -----: | -----------: |
| Guarded delete |   197.125 |         198.111 | 649.33 |        95.56 |
| Guarded rename |   347.279 |         352.174 | 368.58 |       128.67 |
| Durable delete |   729.228 |         732.541 | 175.53 |       142.20 |
| Durable rename |  1221.547 |        1719.690 | 104.79 |       145.45 |

| Operation      | Latency samples ms                    | Peak RSS samples bytes          |
| -------------- | ------------------------------------- | ------------------------------- |
| Delete         | 197.030208, 197.125083, 198.111125    | 93701120, 99959808, 100205568   |
| Rename         | 352.173875, 347.278583, 347.002875    | 132072448, 134923264, 131531776 |
| Durable delete | 720.737917, 729.227625, 732.540791    | 130712576, 139363328, 149111808 |
| Durable rename | 1060.155666, 1719.690292, 1221.547084 | 142033920, 143688704, 152519680 |

Earlier durable measurements supplied a 120-second benchmark deadline.
The current harness omits that override and uses production defaults.
Final large-file validation used the current harness.

### Pass 5 initial implementation: indexed references and one authoritative verification

The reference index replaces target-by-base scans with alias lookups and per-importer deduplication.
It preserves full paths, extensionless paths, and index-directory aliases.
Snapshot producers retain one complete verification after journal ownership begins and before target mutation.
The lifecycle checks blob structure and private-path metadata when it begins.
No trusted digest cache bypasses verification.

The realistic alias experiment used 50 targets, 200 importers, and 12 bases per importer.
It includes valid duplicate imports, missing paths, extensionless index files, and repeated missing aliases.
This target count fits the 50-file tool batch limit.
The inventory and source counts remain below the 100,000-entry and 16 MiB reference budgets.
Each timed indexed run includes index construction.
Every importer result is sorted and compared with a semantically equivalent nested control.
The control hoists per-target extension calculations and compares pre-existing aliases algebraically.
The literal previous implementation also constructs base-plus-extension and index paths inside bases.some.
This experiment does not measure that literal previous implementation.
All runs returned the same 1,600 importer-target pairs.

| Targets | Algorithm | Median ms | Observed p95 ms | Seven latency samples ms                                                           |
| ------- | --------- | --------: | --------------: | ---------------------------------------------------------------------------------- |
| 50      | nested    |     7.886 |           8.029 | 7.894541, 7.885708, 7.541416, 7.650166, 8.011542, 8.029209, 7.650167               |
| 50      | indexed   |     0.085 |           0.653 | 0.653125, 0.411250, 0.091333, 0.084708, 0.085250, 0.078458, 0.084625               |
| 1000    | nested    |   165.668 |         171.324 | 167.118125, 163.367875, 168.328834, 164.887667, 164.079166, 171.324000, 165.667917 |
| 1000    | indexed   |     0.281 |           0.996 | 0.996209, 0.653250, 0.765416, 0.267667, 0.281292, 0.264083, 0.272250               |

In the initial phase, median matching time at 50 targets fell 98.92% against the documented nested control, from 7.886 ms to 0.085 ms.
Retain the indexed algorithm.
The 1,000-target result is synthetic scaling evidence beyond the public tool batch limit.
Neither experiment measures parsing, filesystem traversal, database work, or complete deletion latency.

Reproduce the realistic case:

```sh
bun -e 'import path from "node:path"; import { createReferenceTargetIndex, referencedTargets } from "./src/runtime/reference-target-index.ts";
const targets = Array.from({length:50},(_,i)=>i%4===0?`/repo/p${i}/index.ts`:i%4===1?`/repo/p${i}/entry.js`:i%4===2?`/repo/p${i}/index`:`/repo/p${i}/plain`);
const importers=Array.from({length:200},(_,i)=>Array.from({length:12},(_,j)=>{const t=targets[(i*13+j*17)%targets.length];const ext=path.extname(t);return j===11?targets[(i*13+17)%targets.length]:j%5===0?"/repo/missing":j%5===1?t:j%5===2&&ext?t.slice(0,-ext.length):j%5===3&&path.basename(t)===`index${ext}`?path.dirname(t):t;}));
const legacy=()=>importers.map(bases=>{const found=new Set();for(const target of targets){const ext=path.extname(target);if(bases.some(base=>base===target||(ext!==""&&base===target.slice(0,-ext.length))||(path.basename(target)===`index${ext}`&&base===path.dirname(target))))found.add(target);}return [...found].sort();});
const indexed=()=>{const index=createReferenceTargetIndex(targets);return importers.map(bases=>[...referencedTargets(index,bases)].sort());};
const expected=JSON.stringify(legacy());if(JSON.stringify(indexed())!==expected)throw new Error("alias_mismatch");
for(const [kind,run] of [["nested",legacy],["indexed",indexed]]){const times=[];for(let n=0;n<7;n++){const start=performance.now();const result=run();times.push(performance.now()-start);if(JSON.stringify(result)!==expected)throw new Error("alias_mismatch");}const sorted=[...times].sort((a,b)=>a-b);console.log(JSON.stringify({kind,targets:targets.length,importers:importers.length,basesPerImporter:12,samplesMs:times,medianMs:sorted[3],observedP95Ms:sorted[6],matchedPairs:JSON.parse(expected).reduce((sum,values)=>sum+values.length,0)}));}'
```

Change length:50 to length:1000 to reproduce the synthetic case.

#### End-to-end mutation variability

Initial-phase final-source measurements use production deadlines and the same timed SHA-256 verifier as the earlier mutation baseline.
Independent destination or restored-file hashing runs after timing.
Terminal journal and snapshot-directory checks also run after timing.
Those additional checks contribute to lifetime peak RSS, so memory comparisons are not identical observers.

All 24 initial-phase final-source mutation samples succeeded.
The second set followed a 60-second idle interval.
The source and benchmark code did not change between sets.
Load averages were 3.68/4.45/4.60 before the first set and 2.41/3.62/4.20 before the repeat.
The large timing variation prevents attributing the complete before/after difference to source changes.
These measurements do not establish a broad end-to-end throughput improvement.

| Final 128 MiB operation   | Median ms | Observed p95 ms |  MiB/s | Peak RSS MiB |
| ------------------------- | --------: | --------------: | -----: | -----------: |
| First delete              |   396.785 |         405.153 | 322.59 |        90.47 |
| First rename              |   679.181 |         725.662 | 188.46 |       120.81 |
| First durable-delete      |  1558.423 |        1610.991 |  82.13 |       135.53 |
| First durable-rename      |  1880.079 |        2015.478 |  68.08 |       149.83 |
| After idle delete         |   179.017 |         179.149 | 715.02 |        93.28 |
| After idle rename         |   316.567 |         316.928 | 404.34 |       133.33 |
| After idle durable-delete |   463.595 |         474.472 | 276.10 |       143.55 |
| After idle durable-rename |   609.263 |         614.680 | 210.09 |       166.25 |

| Final operation           | Latency samples ms                    | Peak RSS samples bytes          |
| ------------------------- | ------------------------------------- | ------------------------------- |
| First delete              | 396.785375, 405.153000, 375.240917    | 94864384, 93045760, 91964416    |
| First rename              | 725.662292, 679.180584, 662.188292    | 126682112, 114246656, 125928448 |
| First durable-delete      | 1464.099958, 1558.423041, 1610.991291 | 133972992, 140100608, 142115840 |
| First durable-rename      | 2015.477917, 1880.079500, 1870.464125 | 157107200, 147178496, 155141120 |
| After idle delete         | 179.016625, 177.889375, 179.149333    | 94471168, 97813504, 95011840    |
| After idle rename         | 316.927750, 316.434125, 316.566917    | 132383744, 139805696, 108938240 |
| After idle durable-delete | 454.171000, 463.594708, 474.472292    | 150520832, 127501312, 147620864 |
| After idle durable-rename | 614.680083, 601.707750, 609.263083    | 174326784, 165839872, 167068672 |

The after-idle mutation run uses the same command shown in the pass-5 baseline.
A discarded preliminary run used a different timed verification chunk size.
It is excluded from these comparisons.

## Initial-phase large-file validation

Each single-file fixture contains exactly 2,321,660,787 bytes.
The batch contains three files of that size, totalling 6,964,982,361 logical bytes.
Dense fixtures write deterministic data across every byte.
Sparse fixtures initially contain holes; snapshot copying can allocate their zero-filled contents.
Sparse results do not represent equivalent physical-device I/O.

All nine initial-phase large-file samples succeeded with production deadlines.
Each delete verifies source absence.
Each rename verifies source absence and an independently computed destination digest.
Recovery verifies the independently computed restored digest.
Durable validation requires terminal journal records and zero snapshot directories before harness cleanup.
The three-file batch independently hashes and guards every source.
Its journal completed successfully, all three files were absent, and no staged blobs remained.

```sh
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=2321660787 --iterations=1 --dataset=dense --operations=hash-configured,durable-delete,durable-rename,recovery --representation=blob --allow-large=true
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=2321660787 --iterations=1 --dataset=sparse --operations=hash-configured,durable-delete,durable-rename,recovery,durable-batch-delete --representation=blob --allow-large=true
```

| Fixture and operation       | Single latency ms | Logical MiB/s | Lifetime peak RSS MiB | Validation     |
| --------------------------- | ----------------: | ------------: | --------------------: | -------------- |
| dense hash-configured       |          1742.684 |       1270.52 |                127.17 | digest matched |
| dense durable-delete        |          6374.976 |        347.31 |                194.59 | succeeded      |
| dense durable-rename        |         11357.240 |        194.95 |                174.97 | succeeded      |
| dense recovery              |          6888.375 |        321.43 |                176.61 | recovered      |
| sparse hash-configured      |          1504.605 |       1471.55 |                124.86 | digest matched |
| sparse durable-delete       |          6372.552 |        347.44 |                194.27 | succeeded      |
| sparse durable-rename       |         10882.051 |        203.46 |                217.50 | succeeded      |
| sparse recovery             |          3385.847 |        653.93 |                124.70 | recovered      |
| sparse durable-batch-delete |          8129.536 |        817.06 |                204.49 | succeeded      |

Raw initial-phase large-file observations:

```json
[
  {
    "dataset": "dense",
    "operation": "hash-configured",
    "bytesPerFile": 2321660787,
    "fileCount": 1,
    "durationMs": 1742.683709,
    "peakRssBytes": 133350400
  },
  {
    "dataset": "dense",
    "operation": "durable-delete",
    "bytesPerFile": 2321660787,
    "fileCount": 1,
    "durationMs": 6374.975542,
    "peakRssBytes": 204047360,
    "journalStates": ["succeeded"],
    "snapshotDirectories": 0
  },
  {
    "dataset": "dense",
    "operation": "durable-rename",
    "bytesPerFile": 2321660787,
    "fileCount": 1,
    "durationMs": 11357.240375,
    "peakRssBytes": 183469056,
    "journalStates": ["succeeded"],
    "snapshotDirectories": 0
  },
  {
    "dataset": "dense",
    "operation": "recovery",
    "bytesPerFile": 2321660787,
    "fileCount": 1,
    "durationMs": 6888.374750000001,
    "peakRssBytes": 185189376,
    "journalStates": ["recovered"],
    "snapshotDirectories": 0
  },
  {
    "dataset": "sparse",
    "operation": "hash-configured",
    "bytesPerFile": 2321660787,
    "fileCount": 1,
    "durationMs": 1504.6051249999998,
    "peakRssBytes": 130925568
  },
  {
    "dataset": "sparse",
    "operation": "durable-delete",
    "bytesPerFile": 2321660787,
    "fileCount": 1,
    "durationMs": 6372.55225,
    "peakRssBytes": 203703296,
    "journalStates": ["succeeded"],
    "snapshotDirectories": 0
  },
  {
    "dataset": "sparse",
    "operation": "durable-rename",
    "bytesPerFile": 2321660787,
    "fileCount": 1,
    "durationMs": 10882.050959,
    "peakRssBytes": 228066304,
    "journalStates": ["succeeded"],
    "snapshotDirectories": 0
  },
  {
    "dataset": "sparse",
    "operation": "recovery",
    "bytesPerFile": 2321660787,
    "fileCount": 1,
    "durationMs": 3385.8465839999994,
    "peakRssBytes": 130761728,
    "journalStates": ["recovered"],
    "snapshotDirectories": 0
  },
  {
    "dataset": "sparse",
    "operation": "durable-batch-delete",
    "bytesPerFile": 2321660787,
    "fileCount": 3,
    "durationMs": 8129.535541000001,
    "peakRssBytes": 214418432,
    "journalStates": ["succeeded"],
    "snapshotDirectories": 0
  }
]
```

Single samples establish successful execution on this host; they do not establish median or tail latency.
Configured hash exercises the registered handler and actual configured execution, without an MCP transport round trip.
No final configured hash case reproduced ERR_STRING_TOO_LONG.

## Initial-phase sustained retention

The pre-portability soak performs 100 requests in one process: 34 deletes, 33 renames, and 33 recoveries.
Each request uses a 16 MiB dense fixture and forces GC before recording memory counters.
Every request verifies its result and records zero staged snapshot directories.
The timed duration includes repeated fixture generation, operation verification, and per-request GC.
It excludes the initial fixture and subsequent idle interval.

```sh
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=16777216 --iterations=1 --dataset=dense --operations=soak --soak-requests=100 --settle-ms=35000 --representation=blob
```

All 100 requests succeeded in 13348.307 ms.
The aggregate rate was 119.87 logical MiB/s.
This mixed-workload rate is not physical disk throughput.
Lifetime peak RSS was 122.33 MiB.
The separate idle observation followed 35015.073 ms and another GC.

| Observation | RSS MiB | Heap-used counter MiB | External counter MiB |
| ----------- | ------: | --------------------: | -------------------: |
| Request 1   |   91.22 |                 16.69 |                 6.72 |
| Request 30  |   91.80 |                 20.55 |                10.38 |
| Request 50  |   94.19 |                 21.22 |                11.02 |
| Request 75  |   95.31 |                 21.47 |                11.26 |
| Request 100 |   92.74 |                 21.77 |                11.54 |
| After idle  |   91.55 |                 18.53 |                 8.83 |

Heap-used and external counters rose together, then declined during idle.
These counters do not identify allocation ownership or prove that their categories are disjoint.
The arithmetic heap-used-minus-external increased from 10,456,736 to 10,726,064 bytes across requests.
This is a diagnostic calculation, not a measured JavaScript-only allocation total.
Linear regression over requests 51–100 gives approximately 9,377 heap-counter bytes per request.
The corresponding external-counter slope is approximately 8,837 bytes per request.
Both slopes remain positive, so these observations do not prove a permanent plateau or absence of leaks.
RSS declined over that late window.

Read-only ownership tracing found explicit cleanup in journal updates, coordinator shutdown, lifecycle completion, and snapshot disposal.
Hash and capture operations create 30-second timeout signals.
Their expiry is one testable explanation for idle reductions.
Native allocator or LanceDB warmup is another candidate; this run does not assign causality.
The finite run shows bounded observed RSS and complete blob cleanup, with residual uncertainty about longer-lived retention.

Raw retention observations use columns request, RSS bytes, heap-used bytes, external bytes, snapshot-directory count:

```json
[
  [1, 95651232, 17501146, 7044410, 0],
  [2, 93930912, 18299621, 7777381, 0],
  [3, 93685152, 18637947, 8084763, 0],
  [4, 94766496, 18976625, 8413281, 0],
  [5, 92718520, 19322647, 8748695, 0],
  [6, 93160888, 19628541, 9048253, 0],
  [7, 93357496, 19865424, 9284272, 0],
  [8, 94176744, 20145671, 9551415, 0],
  [9, 94356968, 20223277, 9624733, 0],
  [10, 94209512, 20290206, 9682542, 0],
  [11, 94488040, 20514869, 9903301, 0],
  [12, 94488040, 20578384, 9964176, 0],
  [13, 94537192, 20641308, 10016428, 0],
  [14, 94782952, 20758330, 10130730, 0],
  [15, 94979560, 20810744, 10180408, 0],
  [16, 95356392, 20882779, 10249467, 0],
  [17, 95831528, 21118631, 10484135, 0],
  [18, 95471080, 21174965, 10536677, 0],
  [19, 95798760, 21213900, 10567468, 0],
  [20, 95864296, 21293587, 10642387, 0],
  [21, 95815144, 21314809, 10662841, 0],
  [22, 95815144, 21340477, 10685565, 0],
  [23, 95962600, 21363371, 10706395, 0],
  [24, 95897064, 21369743, 10713311, 0],
  [25, 96044520, 21420579, 10758707, 0],
  [26, 96175592, 21457508, 10794996, 0],
  [27, 96011752, 21472432, 10808704, 0],
  [28, 96126440, 21499182, 10831422, 0],
  [29, 96257512, 21535811, 10865267, 0],
  [30, 96257512, 21550956, 10882780, 0],
  [31, 96290280, 21567906, 10897250, 0],
  [32, 96454120, 21674290, 11000322, 0],
  [33, 96339432, 21740342, 11065334, 0],
  [34, 96830952, 21922595, 11245459, 0],
  [35, 97371648, 21971498, 11290202, 0],
  [36, 97371648, 21992783, 11307535, 0],
  [37, 97519104, 22062130, 11380130, 0],
  [38, 97601024, 22074106, 11389050, 0],
  [39, 97666560, 22082889, 11398889, 0],
  [40, 97732096, 22084141, 11399933, 0],
  [41, 97945088, 22077284, 11392964, 0],
  [42, 98108928, 22042161, 11357073, 0],
  [43, 98207232, 22070452, 11381908, 0],
  [44, 98027008, 22107681, 11416209, 0],
  [45, 98059776, 22106048, 11415488, 0],
  [46, 98567680, 22127276, 11436076, 0],
  [47, 98633216, 22159323, 11465627, 0],
  [48, 98698752, 22148923, 11457499, 0],
  [49, 98665984, 22169161, 11475913, 0],
  [50, 98764288, 22248124, 11550284, 0],
  [51, 98813440, 22273852, 11576492, 0],
  [52, 98878976, 22312832, 11613056, 0],
  [53, 98911744, 22316506, 11617194, 0],
  [54, 98829824, 22311631, 11611663, 0],
  [55, 98878976, 22370884, 11666996, 0],
  [56, 98911744, 22369422, 11668254, 0],
  [57, 98977280, 22386424, 11681944, 0],
  [58, 99010048, 22382309, 11679637, 0],
  [59, 99255808, 22437022, 11731694, 0],
  [60, 99304960, 22433718, 11730246, 0],
  [61, 99255808, 22446212, 11739700, 0],
  [62, 99304960, 22455430, 11750870, 0],
  [63, 99321344, 22474091, 11768523, 0],
  [64, 99321344, 22439125, 11731525, 0],
  [65, 99501568, 22449408, 11742640, 0],
  [66, 99501568, 22451732, 11744180, 0],
  [67, 99517952, 22456619, 11747835, 0],
  [68, 99665408, 22460143, 11750815, 0],
  [69, 99730944, 22462383, 11754639, 0],
  [70, 99780096, 22469555, 11760179, 0],
  [71, 99780096, 22477524, 11766660, 0],
  [72, 99796480, 22490955, 11778907, 0],
  [73, 99862016, 22509145, 11797337, 0],
  [74, 99927552, 22507448, 11795096, 0],
  [75, 99943936, 22515557, 11804741, 0],
  [76, 99943936, 22537697, 11822225, 0],
  [77, 99960320, 22529715, 11819827, 0],
  [78, 100025856, 22534961, 11821857, 0],
  [79, 100124160, 22534371, 11819747, 0],
  [80, 100206080, 22564571, 11837451, 0],
  [81, 100222464, 22549010, 11833970, 0],
  [82, 96634368, 22555125, 11838149, 0],
  [83, 96667136, 22571633, 11856097, 0],
  [84, 96683520, 22582891, 11862315, 0],
  [85, 96732672, 22594472, 11871960, 0],
  [86, 96814592, 22621473, 11903953, 0],
  [87, 96814592, 22631324, 11911100, 0],
  [88, 96814592, 22637171, 11915011, 0],
  [89, 96896512, 22656534, 11937830, 0],
  [90, 96814592, 22661958, 11940646, 0],
  [91, 96880128, 22714104, 11990856, 0],
  [92, 96962048, 22709095, 11989751, 0],
  [93, 96978432, 22725333, 12003381, 0],
  [94, 96978432, 22728232, 12004568, 0],
  [95, 97125888, 22747491, 12027507, 0],
  [96, 97125888, 22753273, 12029513, 0],
  [97, 97125888, 22766887, 12042359, 0],
  [98, 97191424, 22767954, 12047106, 0],
  [99, 97191424, 22774350, 12050446, 0],
  [100, 97240576, 22829536, 12103472, 0]
]
```

## Historical post-portability measurements: before final review

Windows CI exposed portability defects after the initial measurement phase.
The blob path now adds common lstat and descriptor-identity guards.
Recovery synchronization also handles Windows descriptors correctly.
The reference index now uses two lookups and a native path join per base.
These changes affect measured binary and alias paths.
The initial five-pass timings therefore remain historical evidence, not current-source timing claims.

Fresh measurements below use Bun 1.4.4 on the same macOS arm64 host.
Cache, fixture generation, independent SHA-256 verification, and lifetime-RSS rules remain as described above.
The bounded blob and alias measurements ran after those portability changes.
The subsequent attribute compatibility refinement does not participate in these benchmark operations.
The post-portability large-file validation ran after that phase was frozen, before subsequent review refinements.

### Historical post-portability bounded blob paths

```sh
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=134217728 --iterations=3 --dataset=dense --operations=snapshot,journal,recovery --representation=blob
```

All nine dense 128 MiB samples succeeded with production defaults.
All recovery journals reached recovered, with zero staged snapshot directories.

| Operation |  Median ms | Observed p95 ms |   MiB/s | Lifetime peak RSS MiB |
| --------- | ---------: | --------------: | ------: | --------------------: |
| snapshot  |  71.201708 |       71.506500 | 1797.71 |                 90.66 |
| journal   |   0.077083 |        0.111250 |       — |                 91.20 |
| recovery  | 225.389333 |      226.270417 |  567.91 |                139.59 |

| Operation | Raw latency samples ms             | Raw peak RSS samples bytes      |
| --------- | ---------------------------------- | ------------------------------- |
| snapshot  | 70.600083, 71.201708, 71.506500    | 92537856, 95060992, 93996032    |
| journal   | 0.065584, 0.111250, 0.077083       | 95323136, 95634432, 94209024    |
| recovery  | 226.270417, 225.389333, 223.930792 | 119800832, 146375680, 135447552 |

Journal serialization still has no file-throughput result.
These are historical post-portability observations, without attributing differences from earlier phases solely to code.

### Current reference-index measurement

The same documented reproduction command uses 50 targets, 200 importers, and 12 bases per importer.
It includes index construction, duplicate bases, and sorted JSON-equivalence checks against the documented nested control.
All 14 runs returned identical sets containing 1,600 importer-target pairs.

| Algorithm | Median ms | Observed p95 ms | Seven raw latency samples ms                                         |
| --------- | --------: | --------------: | -------------------------------------------------------------------- |
| nested    |  8.184750 |        8.638709 | 8.507500, 8.086708, 8.092000, 8.014666, 8.557708, 8.638709, 8.184750 |
| indexed   |  0.390167 |        1.808458 | 1.808458, 0.493084, 0.847708, 0.390167, 0.370167, 0.379750, 0.370583 |

Current median matching latency is 95.23% lower than the documented control: 8.184750 ms versus 0.390167 ms.
The earlier 98.92% result describes the initial index implementation and is not the current-source claim.
This remains an in-memory matching experiment within the public 50-target batch limit.
It does not measure parsing, traversal, complete deletion, Windows performance, or an MCP transport.

### Historical post-portability large-file validation

All nine cases below ran against the pre-review portability-corrected source with production deadlines.
Each fixture contains 2,321,660,787 bytes.
The sparse batch contains three independently hashed and guarded files, totalling 6,964,982,361 logical bytes.
Delete verifies every source is absent.
Rename and recovery verify independent destination or restored-file digests.
Each durable operation requires terminal journal records and zero staged snapshot directories before harness cleanup.
All checks passed.
Sparse allocation and single-sample limitations from the initial-phase validation also apply here.

```sh
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=2321660787 --iterations=1 --dataset=dense --operations=hash-configured,durable-delete,durable-rename,recovery --representation=blob --allow-large=true
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=2321660787 --iterations=1 --dataset=sparse --operations=hash-configured,durable-delete,durable-rename,recovery,durable-batch-delete --representation=blob --allow-large=true
```

| Fixture | Operation            | Raw latency ms | Raw lifetime peak RSS bytes | Journal state  | Snapshot directories |
| ------- | -------------------- | -------------: | --------------------------: | -------------- | -------------------: |
| dense   | hash-configured      |     786.162417 |                   125977600 | digest matched |                    — |
| dense   | durable-delete       |    2910.644625 |                   203293696 | succeeded      |                    0 |
| dense   | durable-rename       |    5099.062875 |                   212403200 | succeeded      |                    0 |
| dense   | recovery             |    3493.039250 |                   193889280 | recovered      |                    0 |
| sparse  | hash-configured      |     778.861250 |                   128746496 | digest matched |                    — |
| sparse  | durable-delete       |    2863.454750 |                   188040192 | succeeded      |                    0 |
| sparse  | durable-rename       |    5044.450333 |                   185533440 | succeeded      |                    0 |
| sparse  | recovery             |    3320.820375 |                   158663680 | recovered      |                    0 |
| sparse  | durable-batch-delete |    7970.978667 |                   180175872 | succeeded      |                    0 |

Raw historical post-portability large-file observations:

```json
[
  {
    "bytes": 2321660787,
    "dataset": "dense",
    "operation": "hash-configured",
    "representation": "blob",
    "durationMs": 786.162417,
    "rssBeforeBytes": 58688832,
    "peakRssBytes": 125977600,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "dense",
    "operation": "durable-delete",
    "representation": "blob",
    "durationMs": 2910.644625,
    "durableValidation": {
      "journalStates": ["succeeded"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 70387032,
    "peakRssBytes": 203293696,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "dense",
    "operation": "durable-rename",
    "representation": "blob",
    "durationMs": 5099.062875,
    "durableValidation": {
      "journalStates": ["succeeded"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 65242408,
    "peakRssBytes": 212403200,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "dense",
    "operation": "recovery",
    "representation": "blob",
    "durationMs": 3493.0392500000003,
    "durableValidation": {
      "journalStates": ["recovered"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 79758752,
    "peakRssBytes": 193889280,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "sparse",
    "operation": "hash-configured",
    "representation": "blob",
    "durationMs": 778.86125,
    "rssBeforeBytes": 60179824,
    "peakRssBytes": 128746496,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "sparse",
    "operation": "durable-delete",
    "representation": "blob",
    "durationMs": 2863.45475,
    "durableValidation": {
      "journalStates": ["succeeded"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 67306768,
    "peakRssBytes": 188040192,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "sparse",
    "operation": "durable-rename",
    "representation": "blob",
    "durationMs": 5044.450333,
    "durableValidation": {
      "journalStates": ["succeeded"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 65865000,
    "peakRssBytes": 185533440,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "sparse",
    "operation": "recovery",
    "representation": "blob",
    "durationMs": 3320.820375,
    "durableValidation": {
      "journalStates": ["recovered"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 79791544,
    "peakRssBytes": 158663680,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "sparse",
    "operation": "durable-batch-delete",
    "representation": "blob",
    "durationMs": 7970.978666999999,
    "durableValidation": {
      "journalStates": ["succeeded"],
      "snapshotDirectories": 0
    },
    "fileCount": 3,
    "processedBytes": 6964982361,
    "rssBeforeBytes": 65799512,
    "peakRssBytes": 180175872,
    "success": true,
    "phase": "operation"
  }
]
```

The current configured hash cases use the registered handler and actual configured execution.
They validate digest, size, path, and result serialization without an MCP transport round trip.
Neither configured hash case reproduced ERR_STRING_TOO_LONG.
The 100-request retention experiment remains a pre-portability run; it was not repeated for this source phase.
Its raw observations and limitations remain historical evidence, without a new leak-free or permanent-plateau claim.

## Source phases and validation

### Historical pre-portability manifest

Initial-phase final measurements ran after descriptor-close cleanup remediation.
After those measurements, a setup-only harness fix guarded configuration writing and restored environment values on failure.
A text-write cleanup refinement independently closes descriptors, removes temporary files, and cleans created parents.
Those two refinements did not change the initial timed binary operation paths.
Later common blob and index portability changes did change measured paths, as described above.

The measured initial harness hash was 8eaae930fadbaa56835fe36319edea412d9101e1bc4e16bfb10bf7351c2b48c2.
The measured initial engine hash was fc43686cb6b3a771ae8aa254e581d14af57ce182bf4e78b783f59fe0e21770d8.
The following historical manifest includes the subsequent setup and text-cleanup refinements, before portability remediation:

```json
[
  {
    "path": "src/runtime/hash.ts",
    "sha256": "8bc5488848f426f5af9e7dca5106a32dab5d6e6c43fe818d82326232b87ee30a"
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
    "sha256": "07c3d81f1786cdb7289b557c33e3eba971adfbf85f5f3988c10f971bdda7a9ca"
  },
  {
    "path": "src/intelligence/mutation/service.ts",
    "sha256": "6bf9a7f901145840a9f85627f999a060790fe2aa45cfefd3d51fd755d8dde946"
  },
  {
    "path": "src/runtime/snapshot-blob.ts",
    "sha256": "3651ba1d84e228e098e2114a5a645978077e7a9c495ea78288e3e4cc0c7c4ffa"
  },
  {
    "path": "scripts/benchmark/benchmark-file-operations.ts",
    "sha256": "d4ecc4302a52d850b29fe1aa1a103805cf56366c4d4240f534e76005648d40c8"
  },
  {
    "path": "src/patch/engine.ts",
    "sha256": "18fed5adfae3aaee9dcbfdfd2bf5340efaf3de5dc490580c7c3f554e7e39b0cc"
  }
]
```

### Historical post-portability manifest

The preceding post-portability blob, recovery, index, and large-file measurements correspond to these hashes.
The attribute hash identifies the final compatibility refinement; attributes are outside these benchmark paths.

```json
[
  {
    "path": "src/runtime/hash.ts",
    "sha256": "8bc5488848f426f5af9e7dca5106a32dab5d6e6c43fe818d82326232b87ee30a"
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
    "sha256": "152adfd233951f6504d36699b469a48a385653a036dde883bcaa5b4ee84a6acc"
  },
  {
    "path": "src/runtime/snapshot-blob.ts",
    "sha256": "0750b428582e92256bd5912432cb4dd6ce43fc175e65c225d58f948fb654f7d9"
  },
  {
    "path": "src/runtime/attributes.ts",
    "sha256": "aa50a7e3708a3e05f6475806c3aa00f0243a6ef163588cbc2bf3f7764612f8d7"
  },
  {
    "path": "src/patch/engine.ts",
    "sha256": "18fed5adfae3aaee9dcbfdfd2bf5340efaf3de5dc490580c7c3f554e7e39b0cc"
  },
  {
    "path": "scripts/benchmark/benchmark-file-operations.ts",
    "sha256": "d4ecc4302a52d850b29fe1aa1a103805cf56366c4d4240f534e76005648d40c8"
  }
]
```

The final local complete coverage gate exited zero: 1,847 tests passed, four skipped, zero failed, with 17,180 assertions.
It covered 215 test files in 266.37 seconds.
Aggregate coverage was 99.66% functions and 98.96% lines.
Every measured source file met the unchanged 95% per-file coverage thresholds.
Build validation passed.
Skill evaluation passed 143 cases across 41 surfaces.
Windows CI remains pending; these local measurements do not establish a Windows CI pass.

The five initial passes retain historical evidence for bounded snapshot memory, compact serialization, streamed recovery, hash/read work, and indexed matching.
The final frozen-source checks below validate the subsequent review-corrected source.
Durable snapshots perform additional synchronization compared with memory-only capture.
End-to-end latency remains sensitive to host conditions and database overhead.
These measurements do not promise universal latency or leak-free execution.
Recovery after a crash can still fail closed for an inaccessible mode-000 target.
It retains recovery material and can require permission repair before retrying; authorization checks remain enforced.

## Final frozen-source measurements after review

This phase follows the historical post-portability measurements above.
Hashing now checks cooperative deadlines, and snapshot copying adds descriptor-identity guards.
The harness independently attempts every disposer and temporary-root removal, preserves cleanup diagnostics, and fails unsuccessful cleanup.
Dense read validation also checks the deterministic prefix; no read timing was repeated in this final phase.
These changes prevent treating the earlier runtime and harness manifests as final-source measurements.
The reference index hash is unchanged; its documented 95.23% matching result remains applicable.
The initial five passes and 100-request soak remain historical, with their stated limitations.
No new retention or leak-free claim follows from this phase.

The following commands ran serially on the same Bun 1.4.4 macOS arm64 host.
An inadvertently overlapping preliminary large run was discarded and rerun serially.
Only the serial rerun observations appear below.
Warm-cache, lifetime-RSS, fixture, and independent validation rules remain unchanged.
All operations used production deadlines, with no deadline override.

```sh
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=134217728 --iterations=3 --dataset=dense --operations=snapshot,journal,recovery --representation=blob
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=2321660787 --iterations=1 --dataset=dense --operations=hash-configured,durable-delete,durable-rename,recovery --representation=blob --allow-large=true
bun run scripts/benchmark/benchmark-file-operations.ts --bytes=2321660787 --iterations=1 --dataset=sparse --operations=hash-configured,durable-delete,durable-rename,recovery,durable-batch-delete --representation=blob --allow-large=true
```

### Final bounded results

| Operation |  Median ms | Observed p95 ms |   MiB/s | Lifetime peak RSS bytes |
| --------- | ---------: | --------------: | ------: | ----------------------: |
| snapshot  |  69.962791 |       70.059209 | 1829.54 |                95421440 |
| journal   |   0.093917 |        0.098125 |       — |                98862080 |
| recovery  | 226.866417 |      233.519917 |  564.21 |               140362752 |

All nine samples succeeded. Each recovery journal reached recovered, with zero staged snapshot directories.
Journal serialization has no file-throughput result.
Raw observations preserve the three-sample distributions:

```json
[
  {
    "bytes": 134217728,
    "dataset": "dense",
    "operation": "snapshot",
    "representation": "blob",
    "durationMs": 69.96279099999998,
    "rssBeforeBytes": 64832832,
    "peakRssBytes": 93979648,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 134217728,
    "dataset": "dense",
    "operation": "snapshot",
    "representation": "blob",
    "durationMs": 69.873875,
    "rssBeforeBytes": 64980264,
    "peakRssBytes": 95421440,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 134217728,
    "dataset": "dense",
    "operation": "snapshot",
    "representation": "blob",
    "durationMs": 70.05920900000001,
    "rssBeforeBytes": 63751488,
    "peakRssBytes": 93783040,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 134217728,
    "dataset": "dense",
    "operation": "journal",
    "representation": "blob",
    "durationMs": 0.07474999999999454,
    "rssBeforeBytes": 67454296,
    "peakRssBytes": 98862080,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 134217728,
    "dataset": "dense",
    "operation": "journal",
    "representation": "blob",
    "durationMs": 0.09812499999998181,
    "rssBeforeBytes": 67224896,
    "peakRssBytes": 94258176,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 134217728,
    "dataset": "dense",
    "operation": "journal",
    "representation": "blob",
    "durationMs": 0.09391700000000469,
    "rssBeforeBytes": 67011928,
    "peakRssBytes": 94946304,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 134217728,
    "dataset": "dense",
    "operation": "recovery",
    "representation": "blob",
    "durationMs": 225.35895899999997,
    "durableValidation": {
      "journalStates": ["recovered"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 87557488,
    "peakRssBytes": 140362752,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 134217728,
    "dataset": "dense",
    "operation": "recovery",
    "representation": "blob",
    "durationMs": 233.51991699999996,
    "durableValidation": {
      "journalStates": ["recovered"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 86558136,
    "peakRssBytes": 131957760,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 134217728,
    "dataset": "dense",
    "operation": "recovery",
    "representation": "blob",
    "durationMs": 226.866417,
    "durableValidation": {
      "journalStates": ["recovered"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 87623048,
    "peakRssBytes": 127370240,
    "success": true,
    "phase": "operation"
  }
]
```

### Final large-file results

Every fixture contains 2,321,660,787 bytes.
The sparse batch contains three files and processes 6,964,982,361 logical bytes.
All nine cases succeeded, including configured handler digest, size, path, and serialization checks.
Delete verified every source absent; rename and recovery verified independent output digests.
Every durable operation had terminal journal state and zero staged snapshot directories before harness cleanup.
These are single samples, not stable production tail estimates or Windows performance measurements.

| Fixture | Operation            | Raw latency ms | Lifetime peak RSS bytes | Journal state  | Snapshot directories |
| ------- | -------------------- | -------------: | ----------------------: | -------------- | -------------------: |
| dense   | hash-configured      |     776.695000 |               133202944 | digest matched |                    — |
| dense   | durable-delete       |    2892.514209 |               175539200 | succeeded      |                    0 |
| dense   | durable-rename       |    5104.393000 |               217023488 | succeeded      |                    0 |
| dense   | recovery             |    3357.615208 |               179487744 | recovered      |                    0 |
| sparse  | hash-configured      |     781.912791 |               132957184 | digest matched |                    — |
| sparse  | durable-delete       |    2878.769459 |               209748992 | succeeded      |                    0 |
| sparse  | durable-rename       |    5077.693625 |               197149696 | succeeded      |                    0 |
| sparse  | recovery             |    3350.233125 |               132760576 | recovered      |                    0 |
| sparse  | durable-batch-delete |    7856.826375 |               149439488 | succeeded      |                    0 |

```json
[
  {
    "bytes": 2321660787,
    "dataset": "dense",
    "operation": "hash-configured",
    "representation": "blob",
    "durationMs": 776.6950000000002,
    "rssBeforeBytes": 60491048,
    "peakRssBytes": 133202944,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "dense",
    "operation": "durable-delete",
    "representation": "blob",
    "durationMs": 2892.514209,
    "durableValidation": {
      "journalStates": ["succeeded"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 63931688,
    "peakRssBytes": 175539200,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "dense",
    "operation": "durable-rename",
    "representation": "blob",
    "durationMs": 5104.393,
    "durableValidation": {
      "journalStates": ["succeeded"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 65520960,
    "peakRssBytes": 217023488,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "dense",
    "operation": "recovery",
    "representation": "blob",
    "durationMs": 3357.6152079999997,
    "durableValidation": {
      "journalStates": ["recovered"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 83084704,
    "peakRssBytes": 179487744,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "sparse",
    "operation": "hash-configured",
    "representation": "blob",
    "durationMs": 781.912791,
    "rssBeforeBytes": 60982544,
    "peakRssBytes": 132957184,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "sparse",
    "operation": "durable-delete",
    "representation": "blob",
    "durationMs": 2878.769459,
    "durableValidation": {
      "journalStates": ["succeeded"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 68846960,
    "peakRssBytes": 209748992,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "sparse",
    "operation": "durable-rename",
    "representation": "blob",
    "durationMs": 5077.693625,
    "durableValidation": {
      "journalStates": ["succeeded"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 64865624,
    "peakRssBytes": 197149696,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "sparse",
    "operation": "recovery",
    "representation": "blob",
    "durationMs": 3350.233125,
    "durableValidation": {
      "journalStates": ["recovered"],
      "snapshotDirectories": 0
    },
    "rssBeforeBytes": 78333344,
    "peakRssBytes": 132760576,
    "success": true,
    "phase": "operation"
  },
  {
    "bytes": 2321660787,
    "dataset": "sparse",
    "operation": "durable-batch-delete",
    "representation": "blob",
    "durationMs": 7856.826375,
    "durableValidation": {
      "journalStates": ["succeeded"],
      "snapshotDirectories": 0
    },
    "fileCount": 3,
    "processedBytes": 6964982361,
    "rssBeforeBytes": 62227776,
    "peakRssBytes": 149439488,
    "success": true,
    "phase": "operation"
  }
]
```

### Final measured-source manifest

This manifest identifies the final bounded and large-file runs above.
The unchanged index also identifies the applicable 95.23% experiment.
Attributes remain outside these measured operation paths.

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
    "sha256": "8c655cfab67569fffdf457d25b8adb30f6069e030a7594b6eaca029a0bbe003b"
  },
  {
    "path": "src/runtime/snapshot-blob.ts",
    "sha256": "7f0b2b7a74f1c3f015fadfd22ee43b7257e28205d42a5d1a22adcdb18750570e"
  },
  {
    "path": "src/runtime/attributes.ts",
    "sha256": "aa50a7e3708a3e05f6475806c3aa00f0243a6ef163588cbc2bf3f7764612f8d7"
  },
  {
    "path": "src/patch/engine.ts",
    "sha256": "18fed5adfae3aaee9dcbfdfd2bf5340efaf3de5dc490580c7c3f554e7e39b0cc"
  },
  {
    "path": "scripts/benchmark/benchmark-file-operations.ts",
    "sha256": "bbeeec407269656f8829991b4ca4bd5e1bc4696bb7972d22f4727d94194a0a7a"
  }
]
```

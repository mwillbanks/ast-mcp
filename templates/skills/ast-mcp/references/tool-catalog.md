# Tool catalog

Call tools directly by name. There is no intelligence proxy.
The table lists every accepted top-level input. A question mark marks an optional schema property.
Conditional runtime requirements follow the table.
Do not transfer options between tools.

## Callable tools

| Tool                | Inputs                                                                                                                                                                                                         | Purpose                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `diagnostics`       | None                                                                                                                                                                                                           | Inspect loaded state and check the latest stable package version. |
| `approval_probe`    | None                                                                                                                                                                                                           | Explicitly test approval interaction without filesystem grants.   |
| `workspace_open`    | `directory`, `revision?`, `storage?`                                                                                                                                                                           | Open an exact checkout and revision.                              |
| `workspace_status`  | `workspaceId?`                                                                                                                                                                                                 | Inspect selected or known workspaces.                             |
| `map`               | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `detail?`, `max_members?`                                    | Inspect source structure.                                         |
| `digest`            | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `detail?`, `max_members?`                                    | Summarize a bounded project.                                      |
| `show`              | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `symbols?`, `target?`, `detail?`                             | Read exact symbols.                                               |
| `implements`        | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `target?`                                                    | Find implementations.                                             |
| `surface`           | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`                                                               | Inspect exported APIs.                                            |
| `deps`              | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `hide_ambiguous?`, `hide_external?`                          | Inspect outgoing imports.                                         |
| `reverse_deps`      | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `hide_ambiguous?`, `hide_external?`                          | Inspect importing modules.                                        |
| `cycles`            | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `hide_ambiguous?`, `hide_external?`                          | Find import cycles.                                               |
| `graph`             | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `hide_ambiguous?`, `hide_external?`                          | Inspect module relationships.                                     |
| `search`            | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `query?`, `target?`                                          | Find symbols or source text.                                      |
| `find_related`      | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `query?`, `target?`                                          | Find related source.                                              |
| `callers`           | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `target?`, `depth?`, `direct?`, `detail?`                    | Find incoming calls.                                              |
| `callees`           | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `target?`, `depth?`, `direct?`, `detail?`                    | Find outgoing calls.                                              |
| `trace`             | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `target?`, `depth?`, `direct?`, `detail?`                    | Trace calls from a target.                                        |
| `impact`            | `paths?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `target?`, `depth?`, `direct?`, `detail?`, `hide_ambiguous?`, `hide_external?` | Inspect shared-symbol impact.                                     |
| `context`           | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `target?`, `depth?`, `direct?`, `detail?`                    | Read a symbol and nearby calls.                                   |
| `run`               | `paths?`, `file?`, `path?`, `root?`, `glob?`, `lang?`, `languages?`, `scan_limit?`, `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `pattern?`, `rewrite?`, `write?`, `json?`                    | Search AST patterns and preview rewrites.                         |
| `squeeze`           | `budget?`, `limit?`, `top_k?`, `timeout_ms?`, `workspaceId?`, `text?`, `query?`                                                                                                                                | Condense supplied text.                                           |
| `config_status`     | `revision?`, `workspaceId?`                                                                                                                                                                                    | Inspect effective configuration.                                  |
| `policy_check`      | `checks`, `revision?`, `workspaceId?`                                                                                                                                                                          | Check local file policy without writes.                           |
| `document_query`    | `filePath`, `revision?`, `selectors`, `workspaceId?`                                                                                                                                                           | Read selected structured-document values.                         |
| `config_core`       | `cli?`, `dependencies?`, `files?`, `formatting?`, `intelligence?`, `http?`, `mcp?`, `safety?`, `telemetry?`, `target?`, `workspace?`                                                                           | Edit grouped core configuration.                                  |
| `config_paths`      | `operations`, `target?`                                                                                                                                                                                        | Edit ordered path rules.                                          |
| `file_read`         | `files`, `revision?`, `workspaceId?`                                                                                                                                                                           | Read bounded text or AST values.                                  |
| `file_capabilities` | `filePaths`, `revision?`, `workspaceId?`                                                                                                                                                                       | Inspect supported and effective methods.                          |
| `file_hash`         | `filePaths`, `revision?`, `workspaceId?`                                                                                                                                                                       | Hash whole-file bytes.                                            |
| `file_write`        | `files`, `revision?`, `workspaceId?`                                                                                                                                                                           | Create or replace permitted files.                                |
| `file_patch`        | `files`, `revision?`, `workspaceId?`                                                                                                                                                                           | Commit guarded patches.                                           |
| `file_chattr`       | `files`, `revision?`, `workspaceId?`                                                                                                                                                                           | Change file metadata.                                             |
| `file_delete`       | `files`, `revision?`, `workspaceId?`                                                                                                                                                                           | Delete guarded files.                                             |
| `file_rename`       | `files`, `revision?`, `workspaceId?`                                                                                                                                                                           | Move guarded files without replacement.                           |
| `graph_query`       | `workspaceId`, `budget?`, `cursor?`, `direction?`, `edgeKinds?`, `operation?`, `resolutionStatuses?`, `startNodeIds`                                                                                           | Traverse or inspect indexed graphs.                               |
| `graph_path`        | `workspaceId`, `budget?`, `direction?`, `edgeKinds?`, `resolutionStatuses?`, `sourceNodeId`, `targetNodeId`                                                                                                    | Find an indexed path.                                             |
| `graph_explain`     | `workspaceId`, `budget?`, `cursor?`, `nodeId`, `pageSize?`                                                                                                                                                     | Explain an indexed entity.                                        |
| `graph_diff`        | `base`, `budget?`, `cursor?`, `federation?`, `pageSize?`, `target`                                                                                                                                             | Compare published generations.                                    |
| `retrieve`          | `workspaceId`, `budget?`, `deniedPaths?`, `exactSymbols?`, `includedPaths?`, `intent?`, `languages?`, `query`, `semantic?`                                                                                     | Retrieve scoped evidence.                                         |
| `generate`          | `workspaceId`, `allowedCorpusArtifactIds`, `budget?`, `evidence`, `prompt`                                                                                                                                     | Generate an answer from explicit evidence.                        |
| `index`             | `workspaceId`, `action?`, `collection?`                                                                                                                                                                        | Maintain the workspace index.                                     |
| `index_status`      | `workspaceId`, `maxRowsPerTable?`, `timeoutMs?`                                                                                                                                                                | Read index status.                                                |

## File inputs and limits

Use absolute paths when workspace selection or the working directory could be unclear.
File inspection batches accept 1–50 paths or read targets.
Mutation `files` objects contain 1–50 path-keyed entries. Rename destinations can have authorized missing parents; marker files are unnecessary.
File tools accept optional `workspaceId` and `revision`.

A read target accepts `filePath`, `mode`, `language`, `lines`, `range`, `maxBytes`, `selectors`, and `symbols`.
Only `filePath` is required.
Modes are `auto`, `ast`, and `text`.
`lines: [0, 100]` and `range: { start: 0, end: 100 }` are zero-based, end-exclusive alternatives.
Do not supply both forms.
Text defaults to 100 lines, with limits of 1,000 lines and 1 MiB.
`maxBytes` must be positive and cannot exceed 1 MiB.
Use up to 100 source `symbols` or structured-document RFC 6901 `selectors`, never both.
Structured documents include JSON, JSONC, TOML, and YAML.

| Tool          | Each keyed file entry                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `file_write`  | Required `content`; optional `expectedSha256`, `chattr`.                                             |
| `file_patch`  | `expectedSha256`, `patchStrategy`, `astRules`, `aiderBlocks`, `chattr`, `preview`, `previewReceipt`. |
| `file_rename` | Required `destination`; optional `expectedSha256`.                                                   |
| `file_chattr` | Required `chattr`; optional `expectedSha256`.                                                        |
| `file_delete` | Optional `expectedSha256`, `forceReferences`.                                                        |

Existing files require fresh SHA-256 values by default.
A supplied hash always remains enforced, even when configuration makes hashes optional.
Patch entries require `patchStrategy` unless they commit a `previewReceipt`.
Strategies are `ast` and `aider_block`.
Each AST rule has `pattern`, `fix`, and optional positive `expectedMatches`.
Each Aider block has `search` and `replace`.
Each operation array accepts at most 50 entries.
Receipt commits cannot include operations, a strategy, or preview mode.
The shared `chattr` object accepts optional numeric `chmod` (0–511) and `chown: { uid, gid }`.
Ownership IDs must be nonnegative integers.
Load [patch-state-machine.md](patch-state-machine.md) before mutation.

## Native intelligence inputs

Bound each request to one project root.
Use `paths` for up to 50 targets, or `file`/`path` for a single target when supported.
Use `root`, `glob`, `lang`, `languages`, and `scan_limit` to narrow discovery.
`languages` accepts at most 64 entries; `scan_limit` cannot exceed 10,000.
Output bounds are `budget` ≤1,000,000 bytes, `limit` ≤10,000, and `top_k` ≤1,000.
`timeout_ms` cannot exceed 300,000.
All these numeric bounds require positive integers.
`detail` accepts `names`, `signatures`, or `full`.
`max_members` accepts 0–10,000. `depth` accepts 1–32.
`symbols` accepts at most 100 entries.
`direct`, `hide_external`, and `hide_ambiguous` are booleans.

`callers`, `callees`, `trace`, `impact`, `context`, and `implements` require `target`.
`deps` and `reverse_deps` require `file` or `path`.
`search` and `find_related` require `query`, `target`, or `path`.
`run` requires `pattern`; `rewrite` previews a replacement.
`run.write: true` fails with `use_file_patch`; commit through `file_patch`.
Bulk source-size, aggregate source-byte, and parsed-data omissions return partial results with bounded reason counts and paths.
Inspect incomplete coverage, `exhaustive`, and `truncated` before treating absent matches or edges as complete evidence.
Oversized exact-file requests retain typed errors. Mutation verification remains strict.
`squeeze` requires supplied `text` or `query`. It does not read a file path.
`impact` accepts `paths`, but rejects singular `file` and `path`.

## Workspaces and revisions

`workspace_open.directory` identifies the exact checkout or linked worktree.
Keep its returned `workspaceId`.
`workspace_status({})` lists known workspaces; supply `workspaceId` for one workspace.

Revision selectors are:

- `{ kind: "working" }`
- `{ kind: "index" }`
- `{ kind: "commit", oid: "<40- or 64-character lowercase hex>" }`
- `{ kind: "branch", name: "<branch>" }`
- `{ kind: "tag", name: "<tag>" }`

Only working revisions permit mutation.
A hash does not authorize writes to immutable revisions.
Storage selectors are `{ kind: "global" }`, `{ kind: "local" }`, or `{ kind: "parent", levels: 1 }`.
Explicit storage uses `{ kind: "explicit", path: "<absolute path>" }`.
Parent levels range from 1 to 32. Global storage is the default.

## Indexed tools

Every indexed request needs a workspace ID.
`graph_diff` supplies IDs inside `base` and `target`.
Build or refresh the index when no suitable published generation exists.

`index.action` accepts `build`, `refresh`, `verify`, `collect`, or `status`; status is the default.
Optional collection fields are `keepFailedJobsForDays`, `keepPublishedGenerations`, `maxDeletesPerTable`, `pinGraceSeconds`, and `unreachableArtifactDays`.
Day fields accept 0–3,650; generation count accepts 1–10,000.
Deletion count accepts 1–100,000; grace accepts 0–86,400 seconds.
`index_status.maxRowsPerTable` accepts 1–100,000; `timeoutMs` accepts 1–120,000.

`retrieve.query` is required and accepts 1–1,000,000 characters.
Optional filters are `deniedPaths`, `includedPaths`, `exactSymbols`, and `languages`.
Paths are repository-relative.
`intent` accepts `implementation`, `behavior`, or `documentation`.
`semantic` defaults to false and requires configured embedding support when enabled.

| Retrieval budget field | Default   | Maximum     |
| ---------------------- | --------- | ----------- |
| `maxBytes`             | 128,000   | 100,000,000 |
| `maxCandidates`        | 500       | 100,000     |
| `maxDepth`             | 2         | 32          |
| `maxGraphBytes`        | 2,000,000 | 100,000,000 |
| `maxItems`             | 50        | 10,000      |
| `maxNodes`             | 500       | 100,000     |
| `maxVectorCandidates`  | 200       | 100,000     |
| `maxVectorScan`        | 5,000     | 1,000,000   |
| `timeoutMs`            | 5,000     | 120,000     |

Budget fields require positive integers, except `maxDepth`, which permits zero.

`generate` requires configured optional generation, `prompt`, `allowedCorpusArtifactIds`, and explicit `evidence`.
Each evidence entry contains `artifactId`, `entityId`, `path`, `range`, and `text`.
Ranges contain `startByte`, `endByte`, and zero-based `start`/`end` line and column objects.
Preserve retrieved artifact IDs, text, and ranges.
Artifact and entity IDs accept 1–1,024 characters; paths accept 1–4,096.
Evidence text permits 10,000,000 characters; prompts accept 1–1,000,000.
Do not add a `scope` property to tool evidence.

| Generation budget field | Default | Maximum    |
| ----------------------- | ------- | ---------- |
| `maxEvidenceBytes`      | 128,000 | 10,000,000 |
| `maxEvidenceItems`      | 50      | 1,000      |
| `maxOutputBytes`        | 32,000  | 10,000,000 |
| `maxOutputTokens`       | 2,048   | 100,000    |
| `timeoutMs`             | 10,000  | 120,000    |

## Indexed graphs

Graph budgets contain positive integer limits, except `maxDepth`, which permits zero.

| Graph budget field | Default   | Maximum    |
| ------------------ | --------- | ---------- |
| `maxBytes`         | 1,000,000 | 67,108,864 |
| `maxDepth`         | 8         | 1,000      |
| `maxEdges`         | 10,000    | 1,000,000  |
| `maxMilliseconds`  | 5,000     | 120,000    |
| `maxNodes`         | 5,000     | 1,000,000  |
| `pageSize`         | 100       | 10,000     |

`graph_query.startNodeIds` accepts 1–1,000 node IDs.
Its `operation` accepts `traverse`, `impact`, or `components`; traversal is the default.
`graph_path` requires `sourceNodeId` and `targetNodeId`.
Both tools accept `direction: "forward" | "reverse"`, `edgeKinds` (up to 32), and `resolutionStatuses` (up to eight).
Forward is the default direction.
Edge kinds are `contains`, `declares`, `references`, `imports`, `exports`, `calls`, `inherits`, `implements`, `overrides`, `reads`, `writes`, `documents`, `links`, and `depends-on`.
Resolution statuses are `explicit`, `resolved`, `inferred`, `ambiguous`, and `unresolved`.

`graph_explain` requires `nodeId`. Its integer `cursor` defaults to zero.
Its `pageSize` accepts 1–1,000 and defaults to 50.
`graph_diff.base` and `target` each contain `workspaceId` and `generationId`.
Set `federation: true` explicitly for cross-repository comparisons.
Its `pageSize` accepts 1–10,000 and defaults to 100.
Query and diff cursors are opaque strings of 1–8,192 characters.
Use returned cursors unchanged and inspect coverage metadata.

## Configuration inputs

`policy_check.checks` accepts 1–50 objects with `path` and `operation: "read" | "write" | "delete"`.
`document_query.selectors` accepts 1–100 RFC 6901 pointers.
Its structured result cannot exceed 256 KiB.
`config_status` reports effective configuration, policies, and formatter selection.

`config_core` edits only supplied groups. `target` accepts `project` (default) or `global`.
Groups include `cli`, `dependencies`, `files`, `formatting`, `intelligence`, `http`, `mcp`, `safety`, `telemetry`, and `workspace`.
Load [configuration.md](configuration.md) for supported settings and approval rules.

`config_paths.operations` accepts 1–50 ordered operations:

- Add: `{ op: "add", rule: { id, path, policies, includes?, excludes?, follow_symlinks? } }`.
- Update: `{ op: "update", id, rule: { path?, policies?, includes?, excludes?, follow_symlinks? } }`.
- Remove: `{ op: "remove", id }`.

Add policies require `read` and `write`; `delete` is optional.
Update policies contain only changed fields.
Policy values are `allow`, `deny`, or `request`.
Rule IDs accept 1–128 characters.

## Diagnostic tools

`diagnostics({})` accepts no arguments and attempts a fresh latest stable package check.
It reports sanitized server, client, configuration, version, and session approval state.
The latest check has a five-second deadline and a 16 KiB response limit.
Registry failure produces an unavailable result without preventing local diagnostics.
It does not read arbitrary files or change authorization.

`approval_probe({})` also accepts no arguments.
Invoke it only for an explicitly requested approval interaction test.
Its outcomes are `accepted`, `declined`, `denied`, `cancelled`, `malformed`, `unsupported`, and `timeout`.
It checks release currency and never grants filesystem access or persists approval rules.
Both tools are available before filesystem approval.
Load [diagnostics.md](diagnostics.md) for version status, deadlines, and host recovery.

## MCP protocol methods

These methods are not callable tools.

| Method                      | Role                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| `initialize`                | Negotiate legacy protocol and client capabilities.                     |
| `notifications/initialized` | Complete legacy client initialization.                                 |
| `server/discover`           | Discover modern server capabilities.                                   |
| `tools/list`                | Discover actual tool schemas.                                          |
| `tools/call`                | Invoke a tool with its discovered arguments.                           |
| `ping`                      | Check connection responsiveness.                                       |
| `roots/list`                | Let the server request declared roots from a capable client.           |
| `elicitation/create`        | Let the server request approval input from a capable legacy client.    |
| `sampling/createMessage`    | Let the server request generation through a configured capable client. |
| `skills/list`               | List negotiated skills.                                                |
| `skills/get`                | Retrieve the selected skill manifest.                                  |
| `resources/list`            | Enumerate packaged resources with pagination.                          |
| `resources/read`            | Read an exact manifest resource URI.                                   |
| `resources/templates/list`  | List resource templates; ast-mcp currently returns none.               |

Native input-required results carry correlated input requests and responses through the negotiated protocol.
Do not invent `skills/list` or `resources/read` tools.
Supporting hosts negotiate `io.modelcontextprotocol/skills`.
Use `skills/list`, then `skills/get` for `skill://ast-mcp/SKILL.md`.
Use `resources/read` with exact resource URIs from the returned manifest.
Honor pagination, `ttlMs`, `cacheScope`, advertised byte sizes, and SHA-256 digests.
Do not infer resource paths or use directory reads.
Protocol 2026-07-28 clients supply required protocol-version and client-capabilities request metadata.
Legacy clients retain ordinary tools.

The host activates the returned skill. Resource retrieval alone does not activate it.
Load [installation.md](installation.md) when the host needs manual skill delivery or reconnection.

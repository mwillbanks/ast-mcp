# Configuration and controls

Inspect effective settings with `config_status`.
Use `policy_check` before uncertain file access.
Global and project configuration combine through existing precedence.

## Edit configuration

Change `ast-mcp.toml` only through grouped `config_core` and batched `config_paths`.
Do not rewrite the file through ordinary mutation tools.
Both tools accept `target: "project" | "global"`; project is the default.
Version 1 configuration requires migration first.

Host approval is required by default.
Changing `mcp.configuration` always requires approval, including disabling the surface.
Disabled configuration tools fail closed.
Successful changes reload the in-process snapshot.
Changed configuration can invalidate workspace bindings; reopen the workspace when required.

`config_core` accepts these groups and fields:

| Group          | Fields                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `cli`          | `output.interactive`, `output.non_interactive`.                                                                                      |
| `dependencies` | `dprint_binary` for explicit external compatibility.                                                                                 |
| `files`        | `read.modes`, `patch.strategies`, `patch.aider_matchers`, `patch.sql`.                                                               |
| `formatting`   | `enabled`, `fallback`, `dprint_config`, `formatters`.                                                                                |
| `intelligence` | `federation.enabled`, `generation.enabled`, `generation.provider`, `retrieval.semantic`, `retrieval.embedding`, `storage.placement`. |
| `http`         | `host`, `port`, `session_sweep_interval_ms`, `session_timeout_ms`.                                                                   |
| `mcp`          | `configuration.enabled`, `configuration.require_approval`.                                                                           |
| `safety`       | `filesystem`, `require_hash`, `hook.enabled`, `hook.allow_tools`, `hook.block_tools`.                                                |
| `telemetry`    | `enabled`.                                                                                                                           |
| `workspace`    | `roots`, `worktrees`.                                                                                                                |

Use the discovered schema for nested provider, embedding, storage, and formatter fields.
Do not invent settings or transfer fields from tool requests into configuration.
Load [installation.md](installation.md) for migration and invalid-configuration recovery.

## Optional SQL defaults

`config_core.files.patch.sql` accepts optional `policy`, `dialect`, `version`, and `variant` fields. Policies are `advisory`, `required`, and `skip`. Set only dialect/version/variant to describe a default selection; that alone does not request a parser. The default advisory policy with no per-file SQL options makes no validator call. Setting `required` opts in and requires a compatible selected dialect for each SQL patch.

A per-file `file_patch.sql` object uses the same fields and overrides defaults for that operation. Use `policy: "skip"` when a particular dialect or extension is unsupported. This override does not change persistent configuration or claim syntax validity. Choose `target: "project"` or `target: "global"` on `config_core`; project is the default and edits require normal configuration approval.

The PostgreSQL adapter currently supports PostgreSQL 18 core SQL (`variant: "sql"`). It does not validate procedural `DO` or function bodies, PL/pgSQL, extensions, catalog semantics, or execution. It accepts up to 512 KiB per source and 2 MiB outstanding. Eight requests including the active request is the total capacity; one worker runs at a time and up to seven requests wait. Each worker has a five-second timeout. Other dialects or variants remain patchable under advisory policy or explicit skip.

## Filesystem safety

`[safety] filesystem = "restricted"` is the default.
Restricted access follows host boundaries and ordered `[[paths]]` policies.
Version 2 grants no implicit OS-temporary access.
Add only narrow, authorized rules through `config_paths`.
Policies are `allow`, `deny`, and `request`.

Restricted symlink access requires authorization for the link and resolved target.
The winning rule must permit symlinks through `follow_symlinks`.
Approved external rules remain separate from intelligence roots.

`filesystem = "unrestricted"` bypasses path boundaries and symlink policies.
It preserves OS permissions, hashes, atomic operations, and immutable revisions.
Project activation requires session-scoped host approval tied to effective configuration.
It does not change indexing, intelligence roots, storage, or workspace selection.
Modern HTTP has no stable transport session.
Requested approvals fail closed with `approval_required`; model arguments cannot bypass them.

Linked worktrees follow `workspace.worktrees: "include" | "request" | "ignore"`.
The default is `include`.
Use absolute paths and preserve the selected checkout identity.

## Formatting

Formatting defaults to disabled.
`[formatting] enabled = false` is the master switch.
Enable formatting only when authorized.
Configure an installed external formatter, selected extensions, and `stdout` or `in_place` mode.
Supported executables include dprint, Prettier, oxfmt, Biome, and other configured commands.
File operations never download formatters.

Each formatter requires `id` and `command`, plus at least one `extensions` or `globs` selector.
Optional fields are `args`, `enabled`, `mode`, and `timeout_ms`.
Extensions start with a dot. Selector and argument arrays accept at most 64 entries.
Timeouts accept 1–120,000 milliseconds.
Respect project configuration discovery and formatter arguments.
A `preserve` fallback keeps unmatched or failed formatter content unchanged.
A `reject` fallback stops the guarded commit on formatter failure.
A `dprint` fallback tries dprint after a matching formatter fails.
Staging cleanup failures always stop the guarded commit.
Preview does not format; normal commits and receipt commits do.

## Telemetry

Telemetry defaults to enabled.
Set `[telemetry] enabled = false` globally to prevent initialization and network activity.
Set it in a project to suppress project events.

Collection includes tool names, durations, outcomes, error codes, versions, build identifiers, anonymous session IDs, and sanitized package stacks.
Collection excludes source, filesystem paths, arguments, responses, agent intent, and identifying client metadata.
Do not send these excluded fields through custom diagnostics.

## CLI output

`[cli.output]` supports `interactive` and `non_interactive`.
Interactive stdout defaults to `human`; redirected stdout defaults to `json`.
Both settings accept `human`, `json`, `yaml`, and `toml`.
User-facing commands accept `--output <format>` or `--output=<format>`.
The flag overrides configuration.
MCP and hook protocol commands reject this flag and preserve protocol output.
TOML omits absent object fields; unsupported array values produce an actionable error.

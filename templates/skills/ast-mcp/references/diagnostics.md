# Diagnostics and recovery

Use this reference for connection failures, rejected approvals, stale commands, and unexpected runtime behavior.
Check release currency at the start of every diagnostic workflow.
Ordinary file and intelligence calls do not require release checks.

## Check the running package

Call MCP `diagnostics` for the connected server.
Run `ast-mcp doctor --output json` for the executing CLI package.
Both attempt a fresh public npm `latest` check for `@mwillbanks/ast-mcp`.
The request has a five-second deadline and sends no project contents or registry credentials.

Record the running version, latest stable version, check time, and comparison result.
Distinguish current, outdated, newer development or prerelease, and unavailable results.
A failed registry request does not prove currency.
Continue local diagnosis and report the unavailable check explicitly.
Do not discard a reproducible issue because an upgrade remains unverified.

The project package, global executable, connected MCP server, shell Codex CLI, and Desktop backend can differ.
Never use one version as proof of another.
Upgrade only with authorization, using the existing package manager and scope.
An installed upgrade does not restart an existing server.
Load [installation.md](installation.md) for host refresh, reconnection, and selected manual skill updates.

## Inspect the correct layer

Diagnostics report available protocol, transport, client, capability, configuration, and approval state.
Unknown host facts remain unknown.
The server cannot infer the active Desktop backend version or session policy from an unrelated shell executable.
Load [host-context.md](host-context.md) when Full access or worktree inference differs from expectations.

Runtime diagnostics inspect loaded state before filesystem approval.
They do not authorize arbitrary file reads.
Reports omit credentials, source contents, unrelated paths, and replayable approval identifiers.
Keep diagnostic evidence sanitized before sharing it.

Use `doctor --scope local` for project configuration or `--scope global` for user configuration.
Use `--target auto` for automatic host selection, or select `codex`, `claude`, or `copilot`.
Host selection changes inspection, not runtime authorization.
The default target is `auto`.
Use `--root <absolute-project-path>` when inspecting another checkout.
Use `--profile <name>` to inspect a Codex disk profile.
Use the existing `--output human|json|yaml|toml` formats.
Doctor returns exit 0 after reporting unavailable facts; invalid arguments return exit 1.

## Approval failures

| Outcome                     | Action                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `approval_required`         | Inspect negotiated form capability and policy. Use an authorized host or narrow global rule.    |
| `approval_denied`           | Preserve denial. Inspect whether the client declined or returned an explicit deny decision.     |
| `approval_cancelled`        | Inspect cancellation and retry only when appropriate. The next attempt needs a fresh challenge. |
| `approval_response_invalid` | Preserve access restrictions. Inspect the host response and protocol compatibility.             |
| Timeout                     | Preserve access restrictions. Check host responsiveness before a bounded retry.                 |

A client response does not establish that a human saw or rejected a prompt.
Keep actor attribution unknown unless the host provides evidence.
Do not repeatedly retry identical automatic denials.
Session grants remain bound to the approved decision, connection, and configuration.
Expired, stale, or replayed challenge responses do not authorize access.

Call `approval_probe` only when the user explicitly wants to test the approval interaction.
The probe has a bounded deadline.
A silent timeout can return an SDK error instead of a probe outcome; inspect diagnostics' sanitized last outcome for timeout.
It does not grant filesystem access or persist approval rules.
Probe success proves that interaction only; it does not authorize a subsequent file operation.

## Codex-specific recovery

Apply these checks only to Codex.
Other MCP hosts keep their own capability and approval behavior.

Distinguish disk configuration from effective session policy.
Codex global configuration can use `CODEX_HOME`.
Project configuration, selected profiles, CLI overrides, and Desktop permission profiles can change the effective policy.
Modern named profiles reside at `$CODEX_HOME/NAME.config.toml`, below trusted project configuration.
Modern Codex ignores project `profile` and `profiles` declarations.
Older inline-profile behavior can differ; treat conflicting interpretations as host-version-dependent.
Unavailable layers and runtime facts must remain unknown.

Codex Desktop Full access can select `approval_policy = "never"` despite granular settings on disk.
CLI flags and selected profiles can also override disk configuration.
The granular `mcp_elicitations = true` setting permits approval prompts.
Per-tool `approval_mode` and `default_tools_approval_mode` govern tool execution, not ast-mcp's separate filesystem challenge.
The ast-mcp `mcp.configuration.require_approval` setting governs configuration writes, not filesystem approval.

Use an effective session policy that permits elicitation, then answer the real approval form.
Reconnect or start a new session when the host requires it.
Reconnection alone cannot fix a profile that continues to reject prompts.
Do not remove the decision schema, fabricate acceptance, or turn filesystem access into an automatic confirmation.

## Follow-up

Reinspect touched and pending files after reconnection.
Compare discovered tools and schemas with [tool-catalog.md](tool-catalog.md).
For unexplained behavior, load [issue-reporting.md](issue-reporting.md).

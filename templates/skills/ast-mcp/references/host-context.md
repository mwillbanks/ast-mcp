# Host permissions and project context

Use this reference when Full access does not authorize AST-MCP, or tools select the wrong checkout.
Start with [diagnostics.md](diagnostics.md), including its fresh release check.
Keep unavailable host policy and workspace facts unknown.

## Separate host mode from server authorization

A host's Full access label can express the user's intended host permissions.
AST-MCP cannot reliably discover that active mode through standard MCP.
Client names, advertised capabilities, empty form schemas, and project-root hints do not grant filesystem access.
The server's `safety.filesystem` mode, path rules, and approved session grants remain separate authorization controls.
A declined or malformed response never becomes acceptance.

Codex documents `approval_policy.granular.mcp_elicitations` as the setting that allows elicitation prompts to surface.
It does not document a server-readable active-mode field that authorizes AST-MCP.
Follow the separate Desktop and CLI recovery checks in the diagnostics reference.
Do not infer authorization from a Full access label or permissive disk configuration.
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#approval_policygranularmcp_elicitations).

## Select the actual checkout

Verify the active worktree path supplied by the host or user.
A parent repository, server launch directory, and linked worktree can be different directories.
Use absolute file paths and explicit workspace selection where supported.
Call `workspace_open` with `directory` set to the actual absolute worktree path.
Its process-local handle needs no persistent configuration; pass the returned `workspaceId` to subsequent supported calls.
The selected workspace directory takes priority over launch hints within the authorized roots.
Selection still requires read authorization and does not grant filesystem access.
Explicit file-tool paths also help select the relevant project configuration.
Check the returned workspace identity before indexing or changing files.
Do not persist broader configuration merely to compensate for an uncertain launch directory.

Root selection uses supplied client roots, then `AST_MCP_PROJECT_ROOT`, then `AST_MCP_ROOTS`.
An explicitly selected working directory takes priority over the Claude launch hint.
Without an explicit directory, a valid absolute existing-directory `CLAUDE_PROJECT_DIR` precedes the process working directory.
The Claude fallback selects context only; it does not grant access or replace explicit roots or checkout selection.
The legacy MCP adapter requests `roots/list` when the client advertises support, with a five-second bound.
It caches results and clears that cache on `notifications/roots/list_changed`.
The modern request-envelope path does not perform this legacy roots exchange.
An advertised roots capability alone does not prove that the active worktree was selected.

The older MCP roots protocol is optional and requires client support.
The July 2026 specification announcement deprecates roots in favor of explicit tool arguments, resource URIs, or configuration.
Do not add a deprecated roots exchange as an assumed repair.
[Older roots specification](https://modelcontextprotocol.io/specification/2025-11-25/client/roots),
[MCP specification announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/).

## Host-specific evidence

### Codex

Codex issue reports describe plugin servers without a project-root signal and Desktop servers launched with an unrelated working directory.
These reports concern particular versions and launch paths; they do not establish universal current Codex behavior.
Inspect the actual session before applying a workaround.
Keep Desktop backend versions unknown when unavailable.
[Plugin context report](https://github.com/openai/codex/issues/37903),
[Desktop working-directory report](https://github.com/openai/codex/issues/16390).

### Claude Code and Claude Desktop

Claude Code documents `CLAUDE_PROJECT_DIR` in spawned stdio servers as a stable project root.
Its documented roots responses include the launch directory and additional granted directories, with change notifications.
Whether AST-MCP queries roots depends on its negotiated protocol path.
Verify the selected checkout, especially after adding directories.
Do not assume Claude Desktop provides Claude Code's environment or launch behavior.
[Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

### Grok and other clients

The xAI remote MCP API documents HTTP/SSE server URLs, tool selection, and authentication headers.
Its OpenAI-compatible `require_approval` parameter is unsupported.
That API documentation provides no workstation-root or Full access signal for AST-MCP.
Do not generalize these API constraints to every third-party Grok client.
No verified Grok issue report supports a broader claim here.
Use explicit supported workspace or path arguments and inspect the connected client's capabilities.
Apply the same evidence-based approach to Copilot and unidentified clients.
[xAI remote MCP documentation](https://docs.x.ai/developers/tools/remote-mcp).

## Preserve evidence

Record the host, connected server version, transport, observed root, requested worktree, and unavailable facts.
Report observed outcomes without claiming a human rejected an unseen prompt.
Search existing reports before proposing a new issue.
Follow [issue-reporting.md](issue-reporting.md); external reporting requires authorization.

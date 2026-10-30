# Report unexpected behavior

Use this workflow for reproducible ast-mcp failures.
The upstream repository is `mwillbanks/ast-mcp`.
Diagnosis does not authorize a GitHub issue or comment.

## Check versions first

Run MCP `diagnostics` for the connected server before investigating a report.
Use `ast-mcp doctor --output json` when MCP is unavailable.
Always attempt a fresh latest stable version check.
Record registry failures explicitly; never describe an unavailable check as current.

Compare the actual failing server version, not only the package installed on disk.
Check project and global executable differences when relevant.
Recommend an authorized upgrade and reconnection when outdated.
Do not silently install packages.
Preserve useful reproduction evidence when an upgrade cannot be verified.
Load [diagnostics.md](diagnostics.md) for status interpretation.

## Search before drafting

Search both open and closed issues in `mwillbanks/ast-mcp`.
Use the error code, failing tool or command, symptom, host, and transport.
Read likely matches and their comments before deciding whether the behavior is new.
Search results alone do not establish duplication or resolution.

Use a GitHub connector when available.
With an authenticated GitHub CLI, examples are:

`gh issue list --repo mwillbanks/ast-mcp --state all --search "approval_denied" --limit 30`

`gh issue view 57 --repo mwillbanks/ast-mcp --comments`

Adapt terms to the actual failure.
Narrow broad results with additional queries.
Record search terms, relevant links, and any unavailable search or authentication step.
Do not claim that no duplicate exists when search failed.

Prefer an existing issue when its reproduction and affected behavior match.
Treat a recurrence after a documented fix as possible regression evidence.
Explain why related issues do not cover a proposed new report.
Do not create a duplicate merely because the host name differs.

## Collect a minimal report

Include these facts:

- Expected behavior and observed behavior.
- Minimal reproduction and the failing tool or CLI arguments.
- Sanitized error code, response outcome, and policy provenance.
- Running ast-mcp version, latest stable version, and version-check time or failure.
- Host identity and version when known, plus transport, protocol, and relevant negotiated capabilities.
- Local versus global package selection and configuration layers when relevant.
- Reproduction frequency, verification performed, and unverified assumptions.
- Related issue links and duplicate-search results.

Separate observed facts from hypotheses.
Include only configuration fields needed to reproduce the behavior.
Redact secrets, credentials, source content, private paths, account identifiers, and replayable challenge keys.
Do not attach complete environment dumps, databases, or session transcripts.
Do not weaken authorization to obtain a reproduction.

## Submit only with authorization

Prepare the draft before asking for missing reporting authorization.
Check existing user instructions before asking again.
Recheck latest stable version immediately before submission.
Record an unavailable recheck explicitly.
An unavailable upgrade or registry must not erase valid failure evidence.

When authorized, add evidence to the matching issue or create one issue for distinct behavior.
Use the connector's structured body argument.
With GitHub CLI, use a body file created through the authorized local file workflow.
Do not interpolate report text into shell commands.
Do not post credentials or unsanitized diagnostic output.

Return the issue or comment link after a successful authorized submission.
If GitHub access is unavailable, preserve a sanitized draft and state the missing prerequisite.
Do not claim that a draft was submitted.

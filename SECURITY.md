# Security Policy

The security of **ast-mcp** is taken seriously. Responsible reports help protect users and improve the project.

> [!IMPORTANT]
> **Do not report suspected security vulnerabilities through public GitHub issues, pull requests, discussions, or other public channels.**
>
> Use the private [GitHub vulnerability reporting form](https://github.com/mwillbanks/ast-mcp/security/advisories/new).

## Supported Versions

Security updates are provided for:

- the current major version; and
- the immediately preceding major version for **six months after the current major version is released**.

| Version                                                     |  Supported  |
| ----------------------------------------------------------- | :---------: |
| Current major version                                       |     ✅      |
| Previous major version, within its six-month support window |     ✅      |
| Previous major version, after its six-month support window  |     ❌      |
| Older major versions                                        |     ❌      |
| Pre-release and development versions                        | Best effort |

For example, after `2.x` is released:

- `2.x` is supported;
- `1.x` remains supported for security updates for six months following the initial `2.x` release; and
- `0.x` is no longer supported.

After the six-month transition period expires, only `2.x` remains supported.

Users should upgrade to a supported release before requesting or expecting a security fix. A vulnerability may still affect an unsupported release even when the corresponding fix is only published for supported versions.

## Reporting a Vulnerability

Report suspected vulnerabilities privately through GitHub:

- [Report a vulnerability](https://github.com/mwillbanks/ast-mcp/security/advisories/new)
- [View published security advisories](https://github.com/mwillbanks/ast-mcp/security/advisories)
- [GitHub documentation for privately reporting a security vulnerability](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/privately-reporting-a-security-vulnerability)

GitHub Security Advisories are the **only supported reporting channel** for security vulnerabilities in ast-mcp.

Do not submit a public GitHub issue, pull request, discussion, or other public report containing vulnerability details.

### Information to Include

Provide as much of the following information as possible:

- a clear description of the vulnerability;
- the affected ast-mcp version or commit;
- the affected component, command, tool, or execution path;
- the environment in which the vulnerability was reproduced;
- prerequisites or configuration required to trigger the vulnerability;
- detailed reproduction steps;
- a minimal proof of concept, when practical;
- the expected behavior and actual behavior;
- the potential security impact;
- whether exploitation requires untrusted input, filesystem access, network access, authentication, or user interaction;
- relevant logs, traces, stack output, or screenshots with secrets removed;
- any known workarounds or suggested mitigations; and
- whether the vulnerability has already been disclosed to another party or publicly discussed.

Do not include real credentials, access tokens, private keys, personal information, proprietary source code, or other unnecessary sensitive data in the report.

## What to Expect

After a report is submitted, the maintainers will generally:

1. Review the report and request additional information when necessary.
2. Attempt to reproduce and validate the reported behavior.
3. Determine the affected versions and practical impact.
4. Assess severity using the available technical evidence.
5. Develop and test a correction or mitigation.
6. Prepare fixes for supported versions where appropriate.
7. Coordinate disclosure with the reporter.
8. Publish patched releases and a GitHub Security Advisory when appropriate.

The time required to investigate and resolve a report depends on its severity, complexity, reproducibility, and the availability of an appropriate fix.

Submitting a report does not guarantee that the behavior will be classified as a vulnerability, assigned a CVE, or addressed in an unsupported release.

## Responsible Disclosure

Allow the maintainers a reasonable opportunity to investigate and address a reported vulnerability before publicly disclosing it.

Do not publicly disclose:

- reproduction instructions;
- proof-of-concept exploit code;
- affected code paths;
- patches that reveal an unresolved vulnerability;
- unpublished advisory details; or
- other information that would materially increase exploitation risk.

The maintainers will coordinate publication with the reporter where practical. Disclosure may occur after supported releases and reasonable mitigations are available, or earlier when disclosure is necessary to protect users.

## Scope

This policy covers security vulnerabilities introduced or materially affected by the following official ast-mcp components:

- source code maintained in this repository;
- published ast-mcp packages;
- official release artifacts;
- repository-owned build and release automation;
- file-reading, file-writing, and patching behavior;
- path validation and filesystem-boundary enforcement;
- AST parsing, transformation, and code-intelligence operations;
- MCP protocol handling implemented by ast-mcp;
- command execution or process invocation implemented by ast-mcp; and
- security-sensitive default configuration maintained by the project.

Examples of potentially in-scope vulnerabilities include:

- arbitrary file access outside an intended workspace;
- path traversal or symlink-based boundary bypasses;
- unintended command execution;
- command, argument, or environment-variable injection;
- unsafe handling of untrusted patch or AST input;
- privilege escalation;
- authentication or authorization bypass where such controls exist;
- exposure of secrets or sensitive file contents;
- denial of service caused by reasonably bounded, untrusted input;
- unsafe temporary-file handling;
- release artifact or dependency-chain compromise; and
- vulnerabilities in dependencies that are reachable through ast-mcp.

The following are generally outside the scope of this policy:

- unsupported versions;
- vulnerabilities that exist solely in unrelated third-party software;
- vulnerabilities that are not reachable through ast-mcp;
- issues requiring a deliberately compromised host or trusted administrator;
- social engineering;
- denial-of-service reports that require unrealistic or unbounded local resource access;
- reports based only on scanner output without evidence of applicability;
- speculative findings without a reproducible security impact;
- general hardening suggestions without an exploitable condition; and
- vulnerabilities in unofficial forks, integrations, packages, or distributions.

Third-party dependency vulnerabilities should normally be reported to the upstream project unless ast-mcp exposes the vulnerable behavior, prevents an available mitigation, or otherwise materially contributes to the vulnerability.

When uncertain whether a finding is in scope, report it privately rather than discussing it publicly.

## Dependency and Supply-Chain Security

ast-mcp uses automated dependency vulnerability scanning, including [OSV-Scanner](https://google.github.io/osv-scanner/).

Scanner findings may be temporarily ignored only when there is a documented technical justification, such as:

- the affected dependency is development-only;
- the vulnerable code path is not imported, invoked, or exposed by ast-mcp;
- the advisory does not apply to the project's runtime or configuration;
- the result is a false positive; or
- an upstream correction is pending and a verified mitigation is in place.

Ignored findings are recorded in [`osv-scanner.toml`](./osv-scanner.toml) with:

- the advisory identifier;
- an expiration date; and
- the reason the finding is not currently applicable.

Suppressions are not intended to conceal exploitable vulnerabilities. Expiration dates ensure ignored findings are reconsidered rather than suppressed indefinitely.

### Current OSV-Scanner Exception

The project currently ignores [`GHSA-frvp-7c67-39w9`](https://github.com/advisories/GHSA-frvp-7c67-39w9) until **January 22, 2027**.

The affected `@hono/node-server` package is present only through the development-only MCP Inspector dependency. ast-mcp does not import that package or expose the affected Hono server request path.

The authoritative suppression and its expiration date are maintained in [`osv-scanner.toml`](./osv-scanner.toml). If the dependency becomes reachable in production, the affected path is introduced, or the applicability assessment otherwise changes, the exception must be removed or revised.

A scanner suppression does not change the supported-version policy and does not prevent private reports containing evidence that a suppressed advisory is exploitable through ast-mcp.

## Security Principles

ast-mcp is maintained with the following security objectives:

- **Least privilege:** Require only the filesystem and process access necessary for the requested operation.
- **Explicit boundaries:** Keep file operations within the intended workspace or configured scope.
- **Safe mutation:** Validate targets and inputs before writing or patching files.
- **Deterministic behavior:** Prefer predictable, reviewable transformations over implicit side effects.
- **Minimal exposure:** Avoid exposing unnecessary services, commands, files, or runtime capabilities.
- **Dependency hygiene:** Monitor dependencies and document any temporary vulnerability exceptions.
- **Coordinated disclosure:** Investigate reports privately and publish actionable remediation information.
- **Supported releases:** Concentrate security fixes on versions covered by the published support policy.

These objectives guide maintenance decisions but do not constitute a guarantee that the software is free from vulnerabilities.

## Deployment and Usage Guidance

ast-mcp can read, inspect, modify, and create source files. Treat access to an ast-mcp server as security-sensitive.

When deploying or configuring ast-mcp:

- use the latest supported release;
- run the process as a dedicated, unprivileged user;
- grant access only to the repositories and directories required for the task;
- do not grant access to home directories, credential stores, SSH keys, cloud configuration, production secrets, or unrelated workspaces;
- use container, sandbox, filesystem, or operating-system isolation where appropriate;
- avoid running ast-mcp as `root` or with administrator privileges;
- do not expose the MCP server directly to untrusted networks;
- authenticate and restrict access at the transport or host boundary when remote access is required;
- treat MCP clients, prompts, patches, paths, and repository contents as potentially untrusted input;
- review generated patches before applying or deploying them;
- protect CI/CD credentials using least-privilege and short-lived credentials;
- avoid making production credentials available to development tooling;
- keep ast-mcp, its runtime, and its dependencies current;
- inspect dependency vulnerability exceptions before deployment; and
- monitor file modifications and process activity in sensitive environments.

A secure deployment depends on the surrounding MCP client, host, transport, filesystem permissions, sandbox, repository contents, and operating-system configuration. This policy cannot establish the security of those external components.

## Security Advisories and Releases

Confirmed vulnerabilities may be documented through [GitHub Security Advisories](https://github.com/mwillbanks/ast-mcp/security/advisories).

When appropriate, an advisory may include:

- affected versions;
- patched versions;
- severity and impact;
- required exploitation conditions;
- mitigation or upgrade instructions;
- acknowledgements; and
- a CVE identifier when one is requested and assigned.

Security fixes may be released as patch or minor releases within supported major versions. A breaking change may be used when preserving compatibility would leave users exposed or produce an incomplete mitigation.

## Additional Guidance

- [Report a vulnerability](https://github.com/mwillbanks/ast-mcp/security/advisories/new)
- [GitHub Security Advisories for ast-mcp](https://github.com/mwillbanks/ast-mcp/security/advisories)
- [About repository security advisories](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/about-repository-security-advisories)
- [Privately reporting a security vulnerability](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/privately-reporting-a-security-vulnerability)
- [GitHub guidance for coordinated disclosure](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/about-coordinated-disclosure-of-security-vulnerabilities)
- [OSV-Scanner configuration](https://google.github.io/osv-scanner/configuration/)
- [Open Source Vulnerability database](https://osv.dev/)

Thank you for helping keep ast-mcp and its users secure.

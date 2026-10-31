import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  type InputRequiredResult,
  inputRequired,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { globalConfigPath, type ResolvedConfig } from "../config";
import {
  assertConfigWriteTarget,
  canonicalConfigPath,
  withConfigTransaction,
} from "../config/transaction";
import { codexApprovalMetadata } from "./hosts/codex";
import type { PolicyDecision } from "./path-policy";
import { canonicalizePathSync } from "./path-utils";

interface ApprovalScope {
  context?: ServerContext;
  invocationGrants?: Set<string>;
  server?: McpServer;
  tool: string;
  requestScoped?: boolean;
}

const activeApproval = new AsyncLocalStorage<ApprovalScope>();
const sessionGrants = new Set<string>();
const serverIdentities = new WeakMap<McpServer, string>();
interface ApprovalChallenge {
  createdAt: number;
  expiresAt: number;
  responseKey: string;
  sessionId: string;
  serverId: string;
  server: McpServer;
  decision: PolicyDecision;
  tool: string;
}

export type ApprovalOutcome =
  | "accepted"
  | "declined"
  | "denied"
  | "cancelled"
  | "malformed"
  | "unsupported"
  | "timeout"
  | "transport_error";

export interface ApprovalObservation {
  at: string;
  outcome: ApprovalOutcome;
  actor: "unknown";
  operation: PolicyDecision["operation"];
  source: PolicyDecision["source"];
  rule: "filesystem" | "path" | "probe";
}

let observations = new WeakMap<McpServer, Map<string, ApprovalObservation>>();
const MAX_OBSERVED_SESSIONS = 256;

function serverId(server?: McpServer): string {
  if (!server) return "local";
  let identity = serverIdentities.get(server);
  if (!identity) {
    identity = randomUUID();
    serverIdentities.set(server, identity);
  }
  return identity;
}

function observe(
  scope: ApprovalScope,
  decision: PolicyDecision,
  outcome: ApprovalOutcome,
): void {
  if (!scope.server) return;
  let sessions = observations.get(scope.server);
  if (!sessions) {
    sessions = new Map();
    observations.set(scope.server, sessions);
  }
  const session = scope.context?.sessionId ?? "connection";
  sessions.delete(session);
  sessions.set(session, {
    at: new Date().toISOString(),
    outcome,
    actor: "unknown",
    operation: decision.operation,
    source: decision.source,
    rule:
      decision.approvalKind === "probe"
        ? "probe"
        : decision.approvalKind === "filesystem"
          ? "filesystem"
          : "path",
  });
  if (sessions.size > MAX_OBSERVED_SESSIONS)
    sessions.delete(sessions.keys().next().value!);
}

export function approvalClient(server?: McpServer, context?: ServerContext) {
  const envelope = context?.mcpReq?.envelope as
    | Record<string, unknown>
    | undefined;
  const capabilities = (envelope?.[
    "io.modelcontextprotocol/clientCapabilities"
  ] ?? server?.server.getClientCapabilities()) as
    | { elicitation?: unknown; roots?: unknown; sampling?: unknown }
    | undefined;
  const client = (envelope?.["io.modelcontextprotocol/clientInfo"] ??
    server?.server.getClientVersion?.()) as
    | { name?: unknown; version?: unknown }
    | undefined;
  const protocol =
    envelope?.["io.modelcontextprotocol/protocolVersion"] ??
    server?.server.getNegotiatedProtocolVersion?.();
  return {
    capabilities,
    client,
    protocol: typeof protocol === "string" ? protocol : "unknown",
  };
}

export function supportsApprovalForm(
  capabilities: { elicitation?: unknown } | undefined,
): boolean {
  const elicitation = capabilities?.elicitation;
  if (
    !elicitation ||
    typeof elicitation !== "object" ||
    Array.isArray(elicitation)
  )
    return false;
  // An empty capability is the legacy declaration of form support.
  return (
    Object.keys(elicitation).length === 0 ||
    (Object.hasOwn(elicitation, "form") &&
      typeof (elicitation as { form?: unknown }).form === "object" &&
      (elicitation as { form?: unknown }).form !== null &&
      !Array.isArray((elicitation as { form?: unknown }).form))
  );
}

export function approvalDiagnostics(
  server?: McpServer,
  context?: ServerContext,
) {
  pruneApprovalChallenges();
  const session = context?.sessionId ?? "connection";
  const identity = serverId(server);
  const pending = [...issuedChallenges.values()].filter(
    (challenge) =>
      challenge.sessionId === session && challenge.serverId === identity,
  );
  const prefix = `${session}\u0000${identity}\u0000`;
  return {
    pendingCount: pending.length,
    oldestPendingAgeMs: pending.length
      ? Math.max(
          0,
          Date.now() -
            Math.min(...pending.map((challenge) => challenge.createdAt)),
        )
      : null,
    sessionGrantPresent: [...sessionGrants].some((grant) =>
      grant.startsWith(prefix),
    ),
    lastOutcome: server
      ? (observations.get(server)?.get(session) ?? null)
      : null,
  };
}

const APPROVAL_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_APPROVAL_CHALLENGES = 1024;
const MAX_SESSION_APPROVAL_CHALLENGES = 64;
const issuedChallenges = new Map<string, ApprovalChallenge>();
let invalidateConfigRegistry: (() => void) | undefined;

export function setApprovalConfigInvalidator(invalidate: () => void): void {
  invalidateConfigRegistry = invalidate;
}

function persistentConfig(globalPath: string): string {
  mkdirSync(path.dirname(globalPath), { mode: 0o700, recursive: true });
  const existing = existsSync(globalPath)
    ? readFileSync(globalPath, "utf8")
    : "";
  if (!existing) return existing;
  const parsed = Bun.TOML.parse(existing) as { version?: unknown };
  if (parsed.version === 2) return existing;
  throw Object.assign(
    new Error(
      "Persistent approvals require a version 2 user-global ast-mcp.toml; migrate it explicitly first",
    ),
    {
      code: "approval_persistence_required",
      retryable: true,
      suggestedNextCall: "config_status",
    },
  );
}

interface StoredPersistentRule {
  id?: string;
  path?: string;
  follow_symlinks?: boolean;
  includes?: string[];
  excludes?: string[];
  policies?: Partial<
    Record<PolicyDecision["operation"], "allow" | "deny" | "request">
  >;
}

function persistenceConflict(): Error {
  return Object.assign(
    new Error(
      "Persistent approval conflicts with customized path rules; use allow once or session approval, or explicitly update the user-global rule",
    ),
    {
      code: "approval_persistence_conflict",
      retryable: true,
      suggestedNextCall: "config_status",
    },
  );
}

function ownedPersistentRule(
  rule: StoredPersistentRule,
  canonicalPath: string,
): boolean {
  const operations = ["read", "write", "delete"] as const;
  return (
    rule.path === canonicalPath &&
    Object.keys(rule).sort().join(",") ===
      "excludes,follow_symlinks,id,includes,path,policies" &&
    rule.follow_symlinks === false &&
    Array.isArray(rule.includes) &&
    rule.includes.length === 1 &&
    rule.includes[0] === "**/*" &&
    Array.isArray(rule.excludes) &&
    rule.excludes.length === 0 &&
    rule.policies !== undefined &&
    Object.keys(rule.policies).sort().join(",") === "delete,read,write" &&
    operations.every(
      (operation) =>
        rule.policies?.[operation] === "allow" ||
        rule.policies?.[operation] === "deny",
    ) &&
    operations.some(
      (operation) =>
        rule.id === persistentId({ canonicalPath, operation }) &&
        rule.policies?.[operation] === "allow",
    )
  );
}

function storedPersistentApprovals(
  existing: string,
  canonicalPath: string,
): StoredPersistentRule[] {
  if (!existing) return [];
  const parsed = Bun.TOML.parse(existing) as { paths?: StoredPersistentRule[] };
  const matching = (parsed.paths ?? []).filter(
    (rule) => rule.path === canonicalPath,
  );
  if (matching.some((rule) => !ownedPersistentRule(rule, canonicalPath)))
    throw persistenceConflict();
  return matching;
}

function persistentPolicy(
  operation: PolicyDecision["operation"],
  existing: StoredPersistentRule[] = [],
) {
  const allowed = new Set<PolicyDecision["operation"]>([operation]);
  for (const rule of existing)
    for (const candidate of ["read", "write", "delete"] as const)
      if (rule.policies?.[candidate] === "allow") allowed.add(candidate);
  return {
    delete: allowed.has("delete") ? "allow" : "deny",
    read: allowed.has("read") ? "allow" : "deny",
    write: allowed.has("write") ? "allow" : "deny",
  } as const;
}

function persistentPolicyLine(
  policy: ReturnType<typeof persistentPolicy>,
): string {
  return `policies = { read = ${JSON.stringify(policy.read)}, write = ${JSON.stringify(policy.write)}, delete = ${JSON.stringify(policy.delete)} }`;
}

function mergePersistentPolicies(
  source: string,
  rules: StoredPersistentRule[],
  policy: ReturnType<typeof persistentPolicy>,
): string {
  const ids = new Set(rules.flatMap((rule) => (rule.id ? [rule.id] : [])));
  const policyLine = persistentPolicyLine(policy);
  let merged = 0;
  const result = source
    .split(/(?=^\[\[paths\]\]\s*$)/m)
    .map((block) => {
      if (!block.startsWith("[[paths]]")) return block;
      let rule: StoredPersistentRule | undefined;
      try {
        rule = (Bun.TOML.parse(block) as { paths?: StoredPersistentRule[] })
          .paths?.[0];
      } catch {
        throw persistenceConflict();
      }
      if (
        !rule?.id ||
        !ids.has(rule.id) ||
        !rule.path ||
        !ownedPersistentRule(rule, rule.path)
      )
        return block;
      if (!/^policies = \{.*\}$/m.test(block)) throw persistenceConflict();
      merged++;
      return block.replace(/^policies = \{.*\}$/m, policyLine);
    })
    .join("");
  if (merged !== rules.length) throw persistenceConflict();
  return result;
}

function persistentId(
  decision: Pick<PolicyDecision, "operation" | "canonicalPath">,
): string {
  return `approval-${createHash("sha256")
    .update(`${decision.operation}\u0000${decision.canonicalPath}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function persistApproval(
  globalPath: string,
  update: (existing: string) => string | undefined,
): void {
  mkdirSync(path.dirname(globalPath), { mode: 0o700, recursive: true });
  const target = canonicalConfigPath(globalPath);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.approval-${randomUUID()}`,
  );
  try {
    withConfigTransaction(target, () => {
      try {
        assertConfigWriteTarget(globalPath, target);
        const existing = persistentConfig(target);
        const mode = existsSync(target)
          ? statSync(target).mode & 0o7777
          : 0o600;
        const next = update(existing);
        if (next === undefined) return;
        writeFileSync(temporary, next, {
          flag: "wx",
          mode,
        });
        chmodSync(temporary, mode);
        assertConfigWriteTarget(globalPath, target);
        if (persistentConfig(target) !== existing)
          throw Object.assign(
            new Error(
              "User-global configuration changed during approval; retry",
            ),
            { code: "approval_persistence_conflict", retryable: true },
          );
        assertConfigWriteTarget(globalPath, target);
        renameSync(temporary, target);
      } finally {
        try {
          unlinkSync(temporary);
        } catch {}
      }
    });
  } catch (error) {
    if ((error as { code?: string }).code === "configuration_busy")
      Object.assign(error as object, { code: "approval_persistence_busy" });
    throw error;
  }
}

function persistentRule(decision: PolicyDecision): string {
  const globalPath = globalConfigPath();
  const id = persistentId(decision);
  let changed = false;
  let created = false;
  persistApproval(globalPath, (existing) => {
    const matching = storedPersistentApprovals(
      existing,
      decision.canonicalPath,
    );
    const policy = persistentPolicy(decision.operation, matching);
    if (matching.length > 0) {
      const merged = mergePersistentPolicies(existing, matching, policy);
      if (merged === existing) return undefined;
      changed = true;
      return merged;
    }
    const rule = [
      "[[paths]]",
      `id = ${JSON.stringify(id)}`,
      `path = ${JSON.stringify(decision.canonicalPath)}`,
      persistentPolicyLine(policy),
      "follow_symlinks = false",
      'includes = ["**/*"]',
      "excludes = []",
    ].join("\n");
    const prefix = existing || "version = 2\n";
    changed = true;
    created = true;
    return `${prefix.trimEnd()}\n\n${rule}\n`;
  });
  if (changed) {
    invalidateConfigRegistry?.();
    console.error(
      `ast-mcp audit: ${created ? "created" : "updated"} persistent approval ${id}`,
    );
  }
  return id;
}

function key(
  decision: PolicyDecision,
  scope: ApprovalScope,
  generation: number,
): string {
  const serverIdentity = serverId(scope.server);
  const filesystem = decision.approvalKind === "filesystem";
  return [
    scope.context?.sessionId ?? "connection",
    serverIdentity,
    filesystem ? 0 : generation,
    filesystem ? "filesystem" : scope.tool,
    decision.ruleId ?? decision.source,
    decision.operation,
    decision.canonicalPath,
  ].join("\u0000");
}

function approvalResponseKey(): string {
  return `approval_${randomUUID().replaceAll("-", "")}`;
}

export class InputRequiredSignal extends Error {
  readonly result: InputRequiredResult;

  constructor(result: InputRequiredResult) {
    super("User approval is required");
    this.name = "InputRequiredSignal";
    this.result = result;
  }
}

export function withApprovalContext<T>(
  scope: ApprovalScope,
  operation: () => Promise<T>,
): Promise<T> {
  return activeApproval.run(
    { ...scope, invocationGrants: new Set<string>() },
    operation,
  );
}

type ApprovalResponse = {
  action?: string;
  content?: { decision?: string };
};

function acceptResponse(
  response: ApprovalResponse | undefined,
  decision: PolicyDecision,
  grantKey: string,
  invocationGrants: Set<string>,
): boolean | undefined {
  if (response?.action !== "accept") return undefined;
  if (decision.approvalKind === "probe")
    return response.content?.decision === "allow_once" ? true : undefined;
  if (decision.approvalKind === "filesystem") {
    if (response.content?.decision !== "allow_session") return undefined;
    sessionGrants.add(grantKey);
    return true;
  }
  switch (response.content?.decision) {
    case "allow_once":
      invocationGrants.add(grantKey);
      return true;
    case "allow_session":
      sessionGrants.add(grantKey);
      return true;
    case "always_allow":
      persistentRule(decision);
      invocationGrants.add(grantKey);
      return true;
    default:
      return undefined;
  }
}

function responseOutcome(
  response: ApprovalResponse | undefined,
): ApprovalOutcome {
  if (response?.action === "cancel") return "cancelled";
  if (response?.action === "decline") return "declined";
  if (response?.action === "accept" && response.content?.decision === "deny")
    return "denied";
  return "malformed";
}

function approvalRequired(decision: PolicyDecision): Error {
  return Object.assign(
    new Error(
      `Approval required for ${decision.operation}; this client cannot provide a stable form approval. Use diagnostics to inspect capabilities and policy. Add an authorized narrow user-global rule or use an elicitation-capable session.`,
    ),
    {
      code: "approval_required",
      details: {
        operation: decision.operation,
        source: decision.source,
        policy: decision.policy,
        reason: "A stable host form approval is required",
        rule: decision.approvalKind === "filesystem" ? "filesystem" : "path",
        outcome: "unsupported",
        actor: "unknown",
      },
      retryable: true,
      suggestedNextCall: "diagnostics",
    },
  );
}

function approvalResponseError(
  decision: PolicyDecision,
  outcome: ApprovalOutcome,
): Error {
  const code =
    outcome === "cancelled"
      ? "approval_cancelled"
      : outcome === "malformed"
        ? "approval_response_invalid"
        : "approval_denied";
  return Object.assign(
    new Error(
      `Client returned ${outcome} for ${decision.operation} approval; the actor is unknown. Inspect diagnostics before retrying. Host session policy may override disk settings.`,
    ),
    {
      code,
      details: {
        outcome,
        actor: "unknown",
        operation: decision.operation,
        source: decision.source,
        policy: decision.policy,
        reason:
          decision.approvalKind === "filesystem"
            ? "Project unrestricted filesystem access requires session approval"
            : "The selected path policy requires approval",
        rule:
          decision.approvalKind === "filesystem"
            ? "filesystem"
            : decision.approvalKind === "probe"
              ? "probe"
              : "path",
      },
      retryable: outcome === "cancelled" || outcome === "malformed",
      suggestedNextCall: "diagnostics",
    },
  );
}

function approvalMessage(tool: string, decision: PolicyDecision): string {
  return [
    `${tool} requests ${decision.operation} access.`,
    `Path: ${decision.canonicalPath}`,
    `Policy: ${decision.reason}`,
    "Choose the narrowest approval that is appropriate.",
  ].join("\n");
}

export function recordApprovalTransportFailure(
  server: McpServer,
  responseKey: unknown,
  error: unknown,
): void {
  if (typeof responseKey !== "string") return;
  const value = error as { name?: string; code?: unknown; message?: string };
  const outcome: ApprovalOutcome =
    value?.name === "TimeoutError" ||
    value?.code === -32001 ||
    /timeout|timed out/i.test(value?.message ?? "")
      ? "timeout"
      : value?.name === "AbortError"
        ? "cancelled"
        : "transport_error";
  for (const [grantKey, challenge] of issuedChallenges) {
    if (challenge.server !== server || challenge.responseKey !== responseKey)
      continue;
    observe(
      {
        server,
        tool: challenge.tool,
        context: { sessionId: challenge.sessionId } as ServerContext,
      },
      challenge.decision,
      outcome,
    );
    issuedChallenges.delete(grantKey);
  }
}

function requestApproval(
  scope: ApprovalScope,
  decision: PolicyDecision,
  responseKey: string,
): InputRequiredSignal {
  return new InputRequiredSignal(
    inputRequired({
      inputRequests: {
        [responseKey]: inputRequired.elicit({
          _meta: {
            ...codexApprovalMetadata(
              approvalClient(scope.server, scope.context).client,
              decision.approvalKind === "filesystem",
              decision.approvalKind === "probe",
            ),
            "io.ast-mcp/approvalChallenge": responseKey,
            "io.ast-mcp/probe": decision.approvalKind === "probe",
          },
          message: approvalMessage(scope.tool, decision),
          requestedSchema: z.object({
            decision:
              decision.approvalKind === "probe"
                ? z.enum(["deny", "allow_once"])
                : decision.approvalKind === "filesystem"
                  ? z.enum(["deny", "allow_session"])
                  : z.enum([
                      "deny",
                      "allow_once",
                      "allow_session",
                      "always_allow",
                    ]),
          }),
        }),
      },
    }),
  );
}

function pruneApprovalChallenges(now = Date.now()): void {
  for (const [grantKey, challenge] of issuedChallenges)
    if (challenge.expiresAt <= now) {
      observe(
        {
          server: challenge.server,
          tool: challenge.tool,
          context: { sessionId: challenge.sessionId } as ServerContext,
        },
        challenge.decision,
        "timeout",
      );
      issuedChallenges.delete(grantKey);
    }
}

function storeApprovalChallenge(
  grantKey: string,
  scope: ApprovalScope,
  responseKey: string,
  decision: PolicyDecision,
): void {
  pruneApprovalChallenges();
  const sessionId = scope.context?.sessionId ?? "connection";
  const sessionChallenges = [...issuedChallenges.values()].filter(
    (challenge) =>
      challenge.sessionId === sessionId &&
      challenge.serverId === serverId(scope.server),
  ).length;
  if (
    issuedChallenges.size >= MAX_APPROVAL_CHALLENGES ||
    sessionChallenges >= MAX_SESSION_APPROVAL_CHALLENGES
  )
    throw Object.assign(
      new Error(
        "Approval challenge limit reached; answer or allow existing requests to expire",
      ),
      { code: "approval_challenge_limit", retryable: true },
    );
  issuedChallenges.set(grantKey, {
    createdAt: Date.now(),
    expiresAt:
      Date.now() +
      (decision.approvalKind === "probe" ? 5000 : APPROVAL_CHALLENGE_TTL_MS),
    responseKey,
    sessionId,
    serverId: serverId(scope.server),
    server: scope.server!,
    decision,
    tool: scope.tool,
  });
}

export function authorizeRequestedDecision(
  decision: PolicyDecision,
  generation: number,
): boolean {
  const scope = activeApproval.getStore();
  if (!scope?.context || !scope.server) return false;
  if (scope.requestScoped) {
    observe(scope, decision, "unsupported");
    throw approvalRequired(decision);
  }
  pruneApprovalChallenges();
  const grantKey = key(decision, scope, generation);
  const invocationGrants = scope.invocationGrants ?? new Set<string>();
  if (invocationGrants.has(grantKey) || sessionGrants.has(grantKey))
    return true;
  const challenge = issuedChallenges.get(grantKey);
  const responseKey = challenge?.responseKey;
  const response = responseKey
    ? (scope.context.mcpReq.inputResponses?.[responseKey] as
        | ApprovalResponse
        | undefined)
    : undefined;
  const accepted = acceptResponse(
    response,
    decision,
    grantKey,
    invocationGrants,
  );
  if (accepted !== undefined) {
    issuedChallenges.delete(grantKey);
    observe(scope, decision, "accepted");
    return accepted;
  }
  if (response !== undefined) {
    const outcome = responseOutcome(response);
    issuedChallenges.delete(grantKey);
    observe(scope, decision, outcome);
    throw approvalResponseError(decision, outcome);
  }
  const { capabilities } = approvalClient(scope.server, scope.context);
  if (!supportsApprovalForm(capabilities)) {
    observe(scope, decision, "unsupported");
    throw approvalRequired(decision);
  }
  const nextResponseKey = responseKey ?? approvalResponseKey();
  if (!challenge)
    storeApprovalChallenge(grantKey, scope, nextResponseKey, decision);
  throw requestApproval(scope, decision, nextResponseKey);
}

function filesystemDecision(config: ResolvedConfig): PolicyDecision {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        project: canonicalizePathSync(config.projectRoot),
        safety: config.safety,
        paths: config.paths,
        provenance: config.provenance["safety.filesystem"],
      }),
    )
    .digest("hex");
  return {
    canonicalPath: canonicalizePathSync(config.projectRoot),
    operation: "read",
    policy: "request",
    reason:
      "Project configuration requests unrestricted access to the entire filesystem for this session",
    approvalKind: "filesystem",
    ruleId: `filesystem:${fingerprint}`,
    source: "project",
    specificity: Number.MAX_SAFE_INTEGER,
    symlinks: true,
  };
}

export function grantUnrestrictedFilesystem(config: ResolvedConfig): void {
  if (config.safety.filesystem !== "unrestricted") return;
  const scope = activeApproval.getStore();
  if (!scope?.context || !scope.server || scope.requestScoped) return;
  sessionGrants.add(key(filesystemDecision(config), scope, 0));
}

export function unrestrictedFilesystemAuthorized(
  config: ResolvedConfig,
): boolean {
  if (config.safety.filesystem !== "unrestricted") return false;
  if (config.provenance["safety.filesystem"] !== "project") return true;
  const scope = activeApproval.getStore();
  return Boolean(
    scope?.context &&
    scope.server &&
    !scope.requestScoped &&
    sessionGrants.has(key(filesystemDecision(config), scope, 0)),
  );
}

export function assertUnrestrictedFilesystem(config: ResolvedConfig): void {
  if (
    config.safety.filesystem !== "unrestricted" ||
    config.provenance["safety.filesystem"] !== "project"
  )
    return;
  const decision = filesystemDecision(config);
  if (!authorizeRequestedDecision(decision, 0))
    throw approvalRequired(decision);
}

export function approvalSessionId(): string {
  return activeApproval.getStore()?.context?.sessionId ?? "local";
}

export function clearSessionApprovals(
  sessionId?: string,
  server?: McpServer,
): void {
  const identity = server ? serverId(server) : undefined;
  if (!sessionId && !server) {
    sessionGrants.clear();
    issuedChallenges.clear();
    observations = new WeakMap();
    return;
  }
  for (const grantKey of sessionGrants) {
    const [session, instance] = grantKey.split("\u0000");
    if (
      (!sessionId || session === sessionId) &&
      (!identity || instance === identity)
    )
      sessionGrants.delete(grantKey);
  }
  for (const [grantKey, challenge] of issuedChallenges)
    if (
      (!sessionId || challenge.sessionId === sessionId) &&
      (!identity || challenge.serverId === identity)
    )
      issuedChallenges.delete(grantKey);
  if (server) {
    if (sessionId) observations.get(server)?.delete(sessionId);
    else observations.delete(server);
  }
}

export function runApprovalProbe(): { outcome: ApprovalOutcome } {
  const decision: PolicyDecision = {
    canonicalPath: "approval probe",
    operation: "read",
    policy: "request",
    reason: "Diagnostic confirmation only. Acceptance grants no file access.",
    approvalKind: "probe",
    ruleId: "diagnostic-probe",
    source: "baseline",
    specificity: 0,
    symlinks: false,
  };
  try {
    if (!authorizeRequestedDecision(decision, 0))
      return { outcome: "unsupported" };
    return { outcome: "accepted" };
  } catch (error) {
    if (error instanceof InputRequiredSignal) throw error;
    const details = (error as { details?: { outcome?: ApprovalOutcome } })
      .details;
    if (details?.outcome) return { outcome: details.outcome };
    throw error;
  }
}

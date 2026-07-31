import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
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
import { globalConfigPath } from "../config";
import type { PolicyDecision } from "./path-policy";

interface ApprovalScope {
  context?: ServerContext;
  invocationGrants?: Set<string>;
  server?: McpServer;
  tool: string;
}

const activeApproval = new AsyncLocalStorage<ApprovalScope>();
const sessionGrants = new Set<string>();
interface ApprovalChallenge {
  expiresAt: number;
  responseKey: string;
  sessionId: string;
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
  policies?: Partial<
    Record<PolicyDecision["operation"], "allow" | "deny" | "request">
  >;
}

function storedPersistentApprovals(
  existing: string,
  canonicalPath: string,
): StoredPersistentRule[] {
  if (!existing) return [];
  const parsed = Bun.TOML.parse(existing) as {
    paths?: StoredPersistentRule[];
  };
  return (parsed.paths ?? []).filter(
    (rule) => rule.id?.startsWith("approval-") && rule.path === canonicalPath,
  );
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
  return source
    .split(/(?=^\[\[paths\]\]\s*$)/m)
    .map((block) =>
      [...ids].some((id) => block.includes(`id = ${JSON.stringify(id)}`))
        ? block.replace(/^policies = \{.*\}$/m, policyLine)
        : block,
    )
    .join("");
}

function persistentId(decision: PolicyDecision): string {
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
  const lockPath = `${globalPath}.approval.lock`;
  const temporary = path.join(
    path.dirname(globalPath),
    `.${path.basename(globalPath)}.approval-${randomUUID()}`,
  );
  let lockOwned = false;
  try {
    try {
      writeFileSync(lockPath, "", { flag: "wx", mode: 0o600 });
      lockOwned = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw Object.assign(
          new Error("Another persistent approval update is in progress; retry"),
          { code: "approval_persistence_busy", retryable: true },
        );
      throw error;
    }
    const existing = persistentConfig(globalPath);
    const next = update(existing);
    if (next === undefined) return;
    writeFileSync(temporary, next, {
      flag: "wx",
      mode: existsSync(globalPath) ? statSync(globalPath).mode : 0o600,
    });
    if (persistentConfig(globalPath) !== existing)
      throw Object.assign(
        new Error("User-global configuration changed during approval; retry"),
        { code: "approval_persistence_conflict", retryable: true },
      );
    renameSync(temporary, globalPath);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
    if (lockOwned)
      try {
        unlinkSync(lockPath);
      } catch {}
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
  return [
    scope.context?.sessionId ?? "connection",
    generation,
    scope.tool,
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

function deniedResponse(response: ApprovalResponse | undefined): boolean {
  return (
    response?.action === "decline" ||
    response?.action === "cancel" ||
    response?.content?.decision === "deny"
  );
}

function approvalRequired(decision: PolicyDecision): Error {
  return Object.assign(
    new Error(
      `Approval required for ${decision.operation} ${decision.canonicalPath}; this client has no elicitation capability. Add a narrow user-global [[paths]] rule or use a capable client.`,
    ),
    {
      code: "approval_required",
      details: decision,
      retryable: true,
      suggestedNextCall: "policy_check",
    },
  );
}

function approvalDenied(decision: PolicyDecision): Error {
  return Object.assign(
    new Error(
      `User denied ${decision.operation} for ${decision.canonicalPath}`,
    ),
    { code: "approval_denied", retryable: false },
  );
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
            codex_approval_kind: "mcp_tool_call",
            persist: ["session", "always"],
          },
          message: [
            `${scope.tool} requests ${decision.operation} access.`,
            `Path: ${decision.canonicalPath}`,
            `Policy: ${decision.reason}`,
            "Choose the narrowest approval that is appropriate.",
          ].join("\n"),
          requestedSchema: z.object({
            decision: z.enum([
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
    if (challenge.expiresAt <= now) issuedChallenges.delete(grantKey);
}

function storeApprovalChallenge(
  grantKey: string,
  scope: ApprovalScope,
  responseKey: string,
): void {
  pruneApprovalChallenges();
  const sessionId = scope.context?.sessionId ?? "connection";
  const sessionChallenges = [...issuedChallenges.values()].filter(
    (challenge) => challenge.sessionId === sessionId,
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
    expiresAt: Date.now() + APPROVAL_CHALLENGE_TTL_MS,
    responseKey,
    sessionId,
  });
}

export function authorizeRequestedDecision(
  decision: PolicyDecision,
  generation: number,
): boolean {
  const scope = activeApproval.getStore();
  if (!scope?.context || !scope.server) return false;
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
    return accepted;
  }
  if (deniedResponse(response)) {
    issuedChallenges.delete(grantKey);
    throw approvalDenied(decision);
  }
  if (!scope.server.server.getClientCapabilities()?.elicitation)
    throw approvalRequired(decision);
  const nextResponseKey = responseKey ?? approvalResponseKey();
  if (!challenge) storeApprovalChallenge(grantKey, scope, nextResponseKey);
  throw requestApproval(scope, decision, nextResponseKey);
}

export function approvalSessionId(): string {
  return activeApproval.getStore()?.context?.sessionId ?? "local";
}

export function clearSessionApprovals(sessionId?: string): void {
  if (!sessionId) {
    sessionGrants.clear();
    issuedChallenges.clear();
    return;
  }
  const prefix = `${sessionId}\u0000`;
  for (const grantKey of sessionGrants)
    if (grantKey.startsWith(prefix)) sessionGrants.delete(grantKey);
  for (const [grantKey, challenge] of issuedChallenges)
    if (challenge.sessionId === sessionId) issuedChallenges.delete(grantKey);
}

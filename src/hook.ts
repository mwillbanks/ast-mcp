import { currentConfig } from "./config";
import {
  eventCommand,
  type HookPolicy,
  policyMatches,
  toolIdentity,
} from "./helpers/hook";
import {
  compactCallSyntax as compactCallSyntaxHelper,
  containsToolInvocation,
} from "./helpers/string";
import { embeddedShellMutates, shellMutates } from "./shell-policy";

const directTools = new Set([
  "apply_patch",
  "edit",
  "editfiles",
  "create",
  "createfile",
  "write",
  "writefile",
  "replace",
  "rename",
  "renamefile",
  "move",
  "movefile",
  "filerename",
  "str_replace",
  "multiedit",
  "notebookedit",
]);
function _compactCallSyntax(source: string) {
  return compactCallSyntaxHelper(source);
}

function nestedDirect(source: string) {
  return containsToolInvocation(_compactCallSyntax(source), directTools);
}
const shellTools = new Set([
  "bash",
  "shell",
  "terminal",
  "exec_command",
  "functions.exec_command",
  "powershell",
  "pwsh",
]);

const executorTools = new Set([
  "exec",
  "functions.exec",
  "mcp__functions__exec",
  "codex.exec",
]);

function nestedShellCall(source: string) {
  return containsToolInvocation(source, [
    "exec_command",
    "bash",
    "shell",
    "terminal",
    "powershell",
    "pwsh",
  ]);
}

export interface HookDecision {
  denied: boolean;
  reason?: string;
}
function policyDecision(
  policy: HookPolicy,
  identity: ReturnType<typeof toolIdentity>,
): HookDecision | undefined {
  if (!policy.enabled) return { denied: false };
  if (policyMatches(policy.blockTools, identity))
    return {
      denied: true,
      reason: `Tool ${identity.name || "<unknown>"} is blocked by ast-mcp hook policy.`,
    };
  if (policyMatches(policy.allowTools, identity)) return { denied: false };
  return undefined;
}
function isDirectTool(identity: ReturnType<typeof toolIdentity>) {
  return (
    directTools.has(identity.normalizedName) ||
    directTools.has(identity.shortName)
  );
}
const deniedMutation = (): HookDecision => ({
  denied: true,
  reason: "Route manual file mutation through ast-mcp.",
});

function executorDecision(
  executor: boolean,
  command: string | undefined,
  raw: unknown,
): HookDecision | undefined {
  const nestedMutation =
    command &&
    (nestedDirect(command) ||
      (nestedShellCall(command) && embeddedShellMutates(command)));
  if (executor && nestedMutation) return deniedMutation();
  if (executor && typeof raw === "string") return { denied: false };
  return undefined;
}

function shellDecision(command: string | undefined): HookDecision {
  return command && shellMutates(command)
    ? deniedMutation()
    : { denied: false };
}

function commandDecision(
  event: Record<string, unknown>,
  identity: ReturnType<typeof toolIdentity>,
): HookDecision {
  const { command, raw } = eventCommand(event);
  const executor = executorTools.has(identity.normalizedName);
  const executorResult = executorDecision(executor, command, raw);
  if (executorResult) return executorResult;
  const shell =
    shellTools.has(identity.normalizedName) ||
    shellTools.has(identity.shortName);
  if (!executor && !shell) return { denied: false };
  return shellDecision(command);
}
export function evaluateHook(
  event: Record<string, unknown>,
  policy: HookPolicy = { allowTools: [], blockTools: [], enabled: true },
): HookDecision {
  const identity = toolIdentity(event);
  const configured = policyDecision(policy, identity);
  if (configured) return configured;
  if (isDirectTool(identity))
    return {
      denied: true,
      reason: "Route direct file editing through ast-mcp.",
    };
  return commandDecision(event, identity);
}
export function decisionPayload(
  decision: HookDecision,
): Record<string, unknown> {
  if (!decision.denied) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
    permissionDecision: "deny",
    permissionDecisionReason: decision.reason,
  };
}
export async function runHook(
  input: Promise<Record<string, unknown>> = Bun.stdin.json(),
): Promise<number> {
  try {
    const event = await input;
    const policy = (await currentConfig()).safety.hook;
    process.stdout.write(
      `${JSON.stringify(decisionPayload(evaluateHook(event, policy)))}\n`,
    );
    return 0;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(decisionPayload({ denied: true, reason: `Invalid hook input: ${String(error)}` }))}\n`,
    );
    return 2;
  }
}
if (import.meta.main) process.exit(await runHook());

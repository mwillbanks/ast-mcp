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
function compactCallSyntax(source: string) {
  let value = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      value += character.toLowerCase();
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      value += character;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      )
        index++;
      index++;
      continue;
    }
    if (!/\s/.test(character)) value += character.toLowerCase();
  }
  return value.replaceAll("tools?.", "tools.");
}

function nestedDirect(source: string) {
  const value = compactCallSyntax(source);
  return [...directTools].some(
    (tool) =>
      value.includes(`tools.${tool}(`) ||
      value.includes(`tools.${tool}?.(`) ||
      value.includes(`tools["${tool}"](`) ||
      value.includes(`tools["${tool}"]?.(`) ||
      value.includes(`tools['${tool}'](`) ||
      value.includes(`tools['${tool}']?.(`),
  );
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
  const value = compactCallSyntax(source);
  return [
    "exec_command",
    "bash",
    "shell",
    "terminal",
    "powershell",
    "pwsh",
  ].some(
    (tool) =>
      value.includes(`tools.${tool}(`) ||
      value.includes(`tools.${tool}?.(`) ||
      value.includes(`tools["${tool}"](`) ||
      value.includes(`tools["${tool}"]?.(`) ||
      value.includes(`tools['${tool}'](`) ||
      value.includes(`tools['${tool}']?.(`),
  );
}

export interface HookDecision {
  denied: boolean;
  reason?: string;
}
export function evaluateHook(event: Record<string, unknown>): HookDecision {
  const name = String(event.tool_name ?? event.toolName ?? event.name ?? "");
  const normalizedName = name.toLowerCase();
  const shortName = normalizedName.split(".").at(-1) ?? normalizedName;
  if (directTools.has(normalizedName) || directTools.has(shortName))
    return {
      denied: true,
      reason: "Route direct file editing through ast-mcp.",
    };
  const raw =
    event.tool_input ??
    event.toolInput ??
    event.toolArgs ??
    event.input ??
    event.args;
  const input =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const command =
    typeof raw === "string"
      ? raw
      : String(
          input.cmd ??
            input.command ??
            input.script ??
            input.source ??
            input.code ??
            "",
        );
  if (executorTools.has(normalizedName)) {
    if (
      command &&
      (nestedDirect(command) ||
        (nestedShellCall(command) && embeddedShellMutates(command)))
    )
      return {
        denied: true,
        reason: "Route manual file mutation through ast-mcp.",
      };
    if (typeof raw === "string") return { denied: false };
  }
  if (
    !executorTools.has(normalizedName) &&
    !shellTools.has(normalizedName) &&
    !shellTools.has(shortName)
  )
    return { denied: false };
  return command && shellMutates(command)
    ? { denied: true, reason: "Route manual file mutation through ast-mcp." }
    : { denied: false };
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
    process.stdout.write(
      `${JSON.stringify(decisionPayload(evaluateHook(await input)))}\n`,
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

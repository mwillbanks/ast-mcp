const direct =
  /^(?:apply_patch|edit|editFiles|create|createFile|write|writeFile|replace|str_replace|MultiEdit|Edit|Write|NotebookEdit)$/;
const nestedDirect =
  /tools(?:\.(?:apply_patch|edit|editFiles|create|createFile|write|writeFile|replace|str_replace|MultiEdit|Edit|Write|NotebookEdit)|\s*\[\s*["'](?:apply_patch|edit|editFiles|create|createFile|write|writeFile|replace|str_replace|MultiEdit|Edit|Write|NotebookEdit)["']\s*\])\s*\(/;
const shell =
  /^(?:bash|shell|terminal|exec|functions\.exec|mcp__functions__exec|codex\.exec|exec_command|functions\.exec_command|Bash|powershell|PowerShell)$/;
const mutation =
  /(?:^|[;&|]\s*|["'`]\s*|:\s*["'`]\s*)(?:(?:env(?:\s+(?:--?[^\s"'`]+|[A-Za-z_][A-Za-z0-9_]*=[^\s"'`]+))*|command|sudo(?:\s+--?[^\s"'`]+)*|nice(?:\s+--?[^\s"'`]+)*|nohup|busybox)\s+)*(?:(?:\/[^\s/"'`]+)*\/)?(?:apply_patch|patch|tee|truncate|touch|rm|mv|cp|install|dd|ed|awk|mkdir|rmdir|chmod|chown|python\d*|node|ruby|perl|php|sed|ast-grep)(?=\s|["'`]|$)|(?:^|[;&|]\s*|["'`]\s*|:\s*["'`]\s*)(?:find\b[^\n]*\s-delete\b|xargs\s+(?:[^\n]*\s)?rm\b|git(?:\s+(?:-[A-Za-z]\s+[^\s"'`]+|--?[^\s"'`]+))*\s+(?:apply|checkout|restore|reset|clean)|dprint\s+fmt|bun\s+(?:-e|--eval)|(?:Set|Add)-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item)(?=\s|["'`]|$)|(?:^|[^<\d>])>{1,2}(?!=)|<<[-~]?\s*\w/i;

const nestedInterpreter =
  /(?:bash|sh|zsh|dash|ksh|fish|pwsh|powershell|node|python\d*|ruby|perl|php)(?:["']|\s)+(?:--?[A-Za-z][A-Za-z0-9-]*(?:=[^\s"']+)?(?:["']|\s)+)*(?:-c|--command|-Command|-e|--eval)(?=\s|["']|$)/i;
export interface HookDecision {
  denied: boolean;
  reason?: string;
}
export function evaluateHook(event: Record<string, unknown>): HookDecision {
  const name = String(event.tool_name ?? event.toolName ?? event.name ?? "");
  if (direct.test(name))
    return {
      denied: true,
      reason: "Direct file editing is blocked. Use ast-mcp.",
    };
  if (!shell.test(name)) return { denied: false };
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
  return command &&
    (nestedDirect.test(command) ||
      mutation.test(command) ||
      nestedInterpreter.test(command))
    ? { denied: true, reason: "Direct file mutation is blocked. Use ast-mcp." }
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

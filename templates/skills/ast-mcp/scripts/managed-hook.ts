import path from "node:path";

export type HookEvent = "PreToolUse" | "preToolUse";

export function managedAstMcpHookEntry(command: unknown) {
  if (typeof command !== "string") return undefined;
  const normalized = command.trim();
  if (!normalized.endsWith(" hook")) return undefined;
  let invocation = normalized.slice(0, -" hook".length).trim();
  if (invocation.startsWith("bun ")) {
    invocation = invocation.slice(4).trim();
    if (invocation.startsWith("run ")) invocation = invocation.slice(4).trim();
  }
  try {
    invocation = JSON.parse(invocation);
  } catch {}
  if (typeof invocation !== "string") return undefined;
  return [
    "ast-mcp",
    "ast-mcp.bat",
    "ast-mcp.cmd",
    "ast-mcp.com",
    "ast-mcp.exe",
    "ast-mcp.js",
    "ast-mcp.ts",
  ].includes(path.basename(invocation.replaceAll("\\", "/")).toLowerCase())
    ? invocation
    : undefined;
}

function commandMatches(actual: unknown, expected: string) {
  return actual === expected || managedAstMcpHookEntry(actual) !== undefined;
}

export function isManagedHook(
  item: unknown,
  event: HookEvent,
  command: string,
): boolean {
  if (!item || typeof item !== "object") return false;
  const value = item as Record<string, unknown>;
  if (event === "preToolUse")
    return commandMatches(value.command, command) && value.type === "command";
  return (
    Array.isArray(value.hooks) &&
    value.hooks.some(
      (child) =>
        child &&
        typeof child === "object" &&
        commandMatches((child as Record<string, unknown>).command, command) &&
        (child as Record<string, unknown>).type === "command",
    )
  );
}

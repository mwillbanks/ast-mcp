import path from "node:path";

export type HookEvent = "PreToolUse" | "preToolUse";

const legacyHookNames = [
  "ast-mcp",
  "ast-mcp.bat",
  "ast-mcp.cmd",
  "ast-mcp.com",
  "ast-mcp.exe",
  "ast-mcp.js",
  "ast-mcp.ts",
];
const packageHookNames = [
  "ast-mcp-bun",
  "ast-mcp-bun.cmd",
  "ast-mcp-bytecode",
  "ast-mcp-bytecode.exe",
];

function hookBasename(entry: string) {
  return path.basename(entry.replaceAll("\\", "/")).toLowerCase();
}

export function isPackageHookEntry(entry: string) {
  return packageHookNames.includes(hookBasename(entry));
}

export function managedAstMcpHookEntry(command: unknown) {
  if (typeof command !== "string") return undefined;
  const normalized = command.trim();
  if (!normalized.endsWith(" hook")) return undefined;
  let invocation = normalized.slice(0, -" hook".length).trim();
  const wrapped = invocation.match(
    /^("(?:[^"\\]|\\.)*"|\S+)\s+(?:run\s+)?(.+)$/u,
  );
  if (wrapped) {
    let executable = wrapped[1] ?? "";
    try {
      executable = JSON.parse(executable);
    } catch {}
    if (
      ["bun", "bun.exe"].includes(
        path.basename(executable.replaceAll("\\", "/")).toLowerCase(),
      )
    )
      invocation = wrapped[2] ?? "";
  }
  try {
    invocation = JSON.parse(invocation);
  } catch {}
  if (typeof invocation !== "string") return undefined;
  return legacyHookNames.includes(hookBasename(invocation)) ||
    isPackageHookEntry(invocation)
    ? invocation
    : undefined;
}

function commandMatches(
  actual: unknown,
  expected: string,
  ownsPackageHook?: (command: string) => boolean,
) {
  if (actual === expected) return true;
  const entry = managedAstMcpHookEntry(actual);
  return (
    entry !== undefined &&
    (legacyHookNames.includes(hookBasename(entry)) ||
      (typeof actual === "string" && ownsPackageHook?.(actual) === true))
  );
}

export function isManagedHook(
  item: unknown,
  event: HookEvent,
  command: string,
  ownsPackageHook?: (command: string) => boolean,
): boolean {
  if (!item || typeof item !== "object") return false;
  const value = item as Record<string, unknown>;
  if (event === "preToolUse")
    return (
      commandMatches(value.command, command, ownsPackageHook) &&
      value.type === "command"
    );
  return (
    Array.isArray(value.hooks) &&
    value.hooks.some(
      (child) =>
        child &&
        typeof child === "object" &&
        commandMatches(
          (child as Record<string, unknown>).command,
          command,
          ownsPackageHook,
        ) &&
        (child as Record<string, unknown>).type === "command",
    )
  );
}

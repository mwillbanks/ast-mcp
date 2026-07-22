export type HookEvent = "PreToolUse" | "preToolUse";

export function isManagedHook(
  item: unknown,
  event: HookEvent,
  command: string,
): boolean {
  if (!item || typeof item !== "object") return false;
  const value = item as Record<string, unknown>;
  if (event === "preToolUse")
    return value.command === command && value.type === "command";
  return (
    Array.isArray(value.hooks) &&
    value.hooks.some(
      (child) =>
        child &&
        typeof child === "object" &&
        (child as Record<string, unknown>).command === command &&
        (child as Record<string, unknown>).type === "command",
    )
  );
}

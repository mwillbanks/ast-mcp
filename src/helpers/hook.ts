export interface HookPolicy {
  allowTools: string[];
  blockTools: string[];
  enabled: boolean;
}

export interface ToolIdentity {
  name: string;
  normalizedName: string;
  shortName: string;
}

export function toolIdentity(event: Record<string, unknown>): ToolIdentity {
  const name = String(event.tool_name ?? event.toolName ?? event.name ?? "");
  const normalizedName = name.toLowerCase();
  return {
    name,
    normalizedName,
    shortName: normalizedName.split(".").at(-1) ?? normalizedName,
  };
}

export function policyMatches(
  candidates: string[],
  identity: ToolIdentity,
): boolean {
  return candidates.some((candidate) => {
    const normalized = candidate.toLowerCase();
    return (
      normalized === identity.normalizedName ||
      normalized === identity.shortName
    );
  });
}

export function eventCommand(event: Record<string, unknown>): {
  command: string;
  raw: unknown;
} {
  const raw =
    event.tool_input ??
    event.toolInput ??
    event.toolArgs ??
    event.input ??
    event.args;
  if (typeof raw === "string") return { command: raw, raw };
  const input =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    command: String(
      input.cmd ??
        input.command ??
        input.script ??
        input.source ??
        input.code ??
        "",
    ),
    raw,
  };
}

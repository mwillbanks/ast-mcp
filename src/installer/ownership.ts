import { isDeepStrictEqual } from "node:util";

export const launchFields = ["command", "args", "cwd", "url", "type"] as const;
type Entry = Record<string, unknown>;
export interface LaunchReceipt {
  before: Entry | null;
  installed: Entry;
}
export function launchSettings(entry: Entry): Entry {
  return Object.fromEntries(
    launchFields.filter((key) => key in entry).map((key) => [key, entry[key]]),
  );
}
export function launchReceipt(
  existing: Entry,
  installed: Entry,
  previous?: LaunchReceipt,
  ownsTools = false,
): LaunchReceipt {
  previous = parseLaunchReceipt(previous);
  const sameLaunch =
    previous &&
    isDeepStrictEqual(
      launchSettings(existing),
      launchSettings(previous.installed),
    );
  const toolsChanged =
    previous &&
    sameLaunch &&
    Object.hasOwn(previous.installed, "tools") &&
    !isDeepStrictEqual(existing.tools, previous.installed.tools);
  const existingOwned = {
    ...launchSettings(existing),
    ...(ownsTools && existing.tools !== undefined
      ? { tools: existing.tools }
      : {}),
  };
  let before =
    previous && sameLaunch
      ? previous.before === null
        ? null
        : { ...previous.before }
      : validLaunch(existingOwned)
        ? existingOwned
        : null;
  if (toolsChanged) {
    before ??= launchSettings(existing);
    delete before.tools;
    if (existing.tools !== undefined) before.tools = existing.tools;
  }
  return {
    before,
    installed: {
      ...launchSettings(installed),
      ...(ownsTools && installed.tools !== undefined
        ? { tools: installed.tools }
        : {}),
    },
  };
}
export function removeManagedEntry(
  existing: Entry,
  receipt?: LaunchReceipt,
): Entry | undefined {
  receipt = parseLaunchReceipt(receipt);
  if (
    !receipt ||
    !isDeepStrictEqual(
      launchSettings(existing),
      launchSettings(receipt.installed),
    )
  )
    return existing;
  const extras = { ...existing };
  for (const key of launchFields) delete extras[key];
  const before = receipt.before === null ? null : { ...receipt.before };
  const ownsTools = Object.hasOwn(receipt.installed, "tools");
  if (
    before &&
    ownsTools &&
    !isDeepStrictEqual(existing.tools, receipt.installed.tools)
  ) {
    delete before.tools;
    if (existing.tools !== undefined) before.tools = existing.tools;
  }
  if (
    ownsTools &&
    before?.tools === undefined &&
    isDeepStrictEqual(extras.tools, receipt.installed.tools)
  )
    delete extras.tools;
  if (before !== null) return { ...before, ...extras };
  return Object.keys(extras).length ? existing : undefined;
}

function validLaunch(value: unknown): value is Entry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Entry;
  if (
    !Object.keys(entry).every((key) => [...launchFields, "tools"].includes(key))
  )
    return false;
  for (const key of ["command", "cwd", "url", "type"])
    if (
      key in entry &&
      (typeof entry[key] !== "string" || !(entry[key] as string).trim())
    )
      return false;
  for (const key of ["args", "tools"])
    if (
      key in entry &&
      (!Array.isArray(entry[key]) ||
        !(entry[key] as unknown[]).every(
          (item: unknown) => typeof item === "string",
        ))
    )
      return false;
  const command = typeof entry.command === "string";
  const remote = typeof entry.url === "string";
  if (command === remote) return false;
  if (command)
    return (
      entry.type === undefined ||
      entry.type === "local" ||
      entry.type === "stdio"
    );
  if (
    "args" in entry ||
    "cwd" in entry ||
    (entry.type !== undefined && entry.type !== "http" && entry.type !== "sse")
  )
    return false;
  try {
    return ["http:", "https:"].includes(new URL(entry.url as string).protocol);
  } catch {
    return false;
  }
}

export function parseLaunchReceipt(value: unknown): LaunchReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const receipt = value as Record<string, unknown>;
  if (
    !Object.keys(receipt).every(
      (key) => key === "before" || key === "installed",
    )
  )
    return undefined;
  return (receipt.before === null || validLaunch(receipt.before)) &&
    validLaunch(receipt.installed)
    ? (receipt as unknown as LaunchReceipt)
    : undefined;
}

/** Apply the first-install default without overriding a recorded user deletion. */
export function managedToolSelection(
  existing: Entry,
  previous?: LaunchReceipt,
): Entry {
  if (Object.hasOwn(existing, "tools")) return { tools: existing.tools };
  return parseLaunchReceipt(previous) || Object.keys(existing).length
    ? {}
    : { tools: ["*"] };
}

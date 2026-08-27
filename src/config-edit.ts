import { lstat, readFile } from "node:fs/promises";
import { fileV2Schema } from "./config-v2-schema";
import { replaceFileAtomically } from "./runtime/atomic";

export type TomlValue =
  | boolean
  | number
  | string
  | TomlValue[]
  | { [key: string]: TomlValue };

const pathIdPattern =
  /(?:^|\n)[ \t]*id[ \t]*=[ \t]*("(?:[^"\\]|\\.)*"|'[^']*')/;
const policyPairPattern = () =>
  /([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)/g;

function encodeTomlValue(value: TomlValue): string {
  if (typeof value === "boolean" || typeof value === "number")
    return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => encodeTomlValue(item)).join(", ")}]`;
  const entries = Object.entries(value).map(
    ([key, item]) => `${key} = ${encodeTomlValue(item)}`,
  );
  return `{ ${entries.join(", ")} }`;
}

function nextTableHeader(source: string, start: number): number {
  const rest = source.slice(start);
  const match = /\n\[/.exec(rest);
  return match ? start + match.index + 1 : source.length;
}

function sectionRange(
  source: string,
  header: string,
): { bodyStart: number; end: number; start: number } | undefined {
  const pattern = new RegExp(
    `^[\\t ]*\\[${header.replaceAll(".", "\\.")}\\][\\t ]*(?:#.*)?$`,
    "m",
  );
  const match = pattern.exec(source);
  if (!match || match.index === undefined) return undefined;
  const start = match.index;
  const bodyStart = start + match[0].length;
  return { bodyStart, end: nextTableHeader(source, bodyStart), start };
}

function ensureSection(source: string, header: string): string {
  if (sectionRange(source, header)) return source;
  return `${source.trimEnd()}\n\n[${header}]\n`;
}

function replaceKeyInRange(
  source: string,
  rangeStart: number,
  rangeEnd: number,
  key: string,
  encoded: string,
): string {
  const body = source.slice(rangeStart, rangeEnd);
  const keyPattern = new RegExp(`^[\\t ]*${key}[\\t ]*=.*$`, "m");
  if (keyPattern.test(body)) {
    const updated = body.replace(keyPattern, `${key} = ${encoded}`);
    return `${source.slice(0, rangeStart)}${updated}${source.slice(rangeEnd)}`;
  }
  const insertion = body.endsWith("\n")
    ? `${body}${key} = ${encoded}\n`
    : `${body}\n${key} = ${encoded}\n`;
  return `${source.slice(0, rangeStart)}${insertion}${source.slice(rangeEnd)}`;
}

export function setTomlSectionKey(
  source: string,
  header: string,
  key: string,
  value: TomlValue,
): string {
  const withSection = ensureSection(source, header);
  const range = sectionRange(withSection, header);
  if (!range) return withSection;
  return replaceKeyInRange(
    withSection,
    range.bodyStart,
    range.end,
    key,
    encodeTomlValue(value),
  );
}

function pathBlocks(source: string): Array<{
  end: number;
  id?: string;
  start: number;
}> {
  const matches = [...source.matchAll(/^[ \t]*\[\[paths\]\][ \t]*(?:#.*)?$/gm)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const nextStart = matches[index + 1]?.index;
    const following = nextTableHeader(source, start + match[0].length);
    const end =
      nextStart === undefined ? following : Math.min(nextStart, following);
    const body = source.slice(start, end);
    const idMatch = pathIdPattern.exec(body);
    const raw = idMatch?.[1];
    const id = raw
      ? raw.startsWith("'")
        ? raw.slice(1, -1)
        : (JSON.parse(raw) as string)
      : undefined;
    return { end, id, start };
  });
}

function encodePathRule(rule: Record<string, TomlValue>): string {
  const lines = ["[[paths]]"];
  for (const key of [
    "id",
    "path",
    "policies",
    "follow_symlinks",
    "includes",
    "excludes",
  ]) {
    const value = rule[key];
    if (value !== undefined) lines.push(`${key} = ${encodeTomlValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function addPathTable(
  source: string,
  rule: Record<string, TomlValue>,
): string {
  return `${source.trimEnd()}\n\n${encodePathRule(rule)}`;
}

function requirePathBlock(source: string, id: string) {
  const block = pathBlocks(source).find((item) => item.id === id);
  if (!block)
    throw Object.assign(new Error(`No [[paths]] rule with id ${id}`), {
      code: "configuration_path_missing",
      retryable: true,
    });
  return block;
}

export function removePathTable(source: string, id: string): string {
  const block = requirePathBlock(source, id);
  return `${source.slice(0, block.start)}${source.slice(block.end)}`.replace(
    /\n{3,}/g,
    "\n\n",
  );
}

export function updatePathTable(
  source: string,
  id: string,
  patch: Record<string, TomlValue>,
): string {
  const block = requirePathBlock(source, id);
  let body = source.slice(block.start, block.end);
  for (const [key, value] of Object.entries(patch)) {
    const keyPattern = new RegExp(`^[\\t ]*${key}[\\t ]*=.*$`, "m");
    const line = `${key} = ${encodeTomlValue(value)}`;
    body = keyPattern.test(body)
      ? body.replace(keyPattern, line)
      : `${body.trimEnd()}\n${line}\n`;
  }
  return `${source.slice(0, block.start)}${body}${source.slice(block.end)}`;
}

export function pathTableIds(source: string): string[] {
  return pathBlocks(source)
    .map((block) => block.id)
    .filter((id): id is string => Boolean(id));
}

export function existingPathPolicies(
  source: string,
  id: string,
): Record<string, string> {
  const block = pathBlocks(source).find((item) => item.id === id);
  if (!block) return {};
  const body = source.slice(block.start, block.end);
  const match = /(?:^|\n)[ \t]*policies[ \t]*=[ \t]*\{([^}]*)\}/.exec(body);
  if (!match?.[1]) return {};
  const policies: Record<string, string> = {};
  for (const item of match[1].matchAll(policyPairPattern()))
    policies[item[1] ?? ""] = item[2]?.startsWith('"')
      ? (JSON.parse(item[2]) as string)
      : item[2]?.startsWith("'")
        ? item[2].slice(1, -1)
        : (item[2] ?? "");
  return policies;
}

export function validateConfigSource(source: string, filePath: string): void {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(source);
  } catch (error) {
    throw Object.assign(
      new Error(
        `${filePath}: invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
      ),
      { code: "configuration_invalid", retryable: true },
    );
  }
  const result = fileV2Schema.safeParse(parsed);
  if (!result.success)
    throw Object.assign(
      new Error(
        `${filePath}: invalid configuration: ${result.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
          )
          .join("; ")}`,
      ),
      { code: "configuration_invalid", retryable: true },
    );
}

export async function writeConfigSource(
  filePath: string,
  source: string,
): Promise<void> {
  validateConfigSource(source, filePath);
  const metadata = await lstat(filePath);
  await replaceFileAtomically(filePath, source, metadata.mode);
}

export async function readConfigSource(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

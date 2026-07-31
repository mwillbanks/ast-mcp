import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileV2Schema } from "./config-v2-schema";

export interface MigrationPreview {
  changed: boolean;
  fromVersion: number;
  source: string;
  toVersion: 2;
  warnings: string[];
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function insertIntoSection(
  source: string,
  section: string,
  line: string,
): string {
  const header = new RegExp(
    `^[\\t ]*\\[${section.replaceAll(".", "\\.")}\\][\\t ]*(?:#.*)?$`,
    "m",
  );
  const match = header.exec(source);
  if (!match) return `${source.trimEnd()}\n\n[${section}]\n${line}\n`;
  const index = match.index + match[0].length;
  return `${source.slice(0, index)}\n${line}${source.slice(index)}`;
}

function formatterDefaults(source: string): string {
  const headers = [
    ...source.matchAll(
      /^[\t ]*\[\[formatting\.formatters\]\][\t ]*(?:#.*)?$/gm,
    ),
  ];
  let migrated = source;
  for (let index = headers.length - 1; index >= 0; index -= 1) {
    const header = headers[index] as RegExpMatchArray;
    const start = (header.index ?? 0) + header[0].length;
    const next = migrated.slice(start).search(/^[\t ]*\[/m);
    const end = next < 0 ? migrated.length : start + next;
    const body = migrated.slice(start, end);
    const additions = [
      /^[\t ]*id\s*=/m.test(body) ? undefined : `id = "legacy-${index + 1}"`,
      /^[\t ]*enabled\s*=/m.test(body) ? undefined : "enabled = true",
      /^[\t ]*mode\s*=/m.test(body) ? undefined : 'mode = "stdout"',
    ].filter((item): item is string => Boolean(item));
    if (additions.length)
      migrated = `${migrated.slice(0, start)}\n${additions.join("\n")}${migrated.slice(start)}`;
  }
  return migrated;
}

function stripLegacySafety(source: string): string {
  return source.replace(
    /^\s*(allow_any_path|allow_external_roots|allow_temp_directory|follow_symlinks)\s*=.*(?:\r?\n|$)/gm,
    "",
  );
}

function rule(id: string, anchor: string, followSymlinks: boolean): string {
  return [
    "[[paths]]",
    `id = ${quote(id)}`,
    `path = ${quote(anchor)}`,
    'policies = { read = "allow", write = "allow", delete = "allow" }',
    `follow_symlinks = ${followSymlinks}`,
    'includes = ["**/*"]',
    'excludes = [".git/**"]',
  ].join("\n");
}

function parsedMigration(source: string) {
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(source) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const rawVersion = parsed.version;
  const fromVersion = rawVersion === undefined ? 1 : Number(rawVersion);
  if (!Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion > 2)
    throw new Error(`Unsupported ast-mcp.toml version: ${String(rawVersion)}`);
  return { fromVersion, parsed };
}

function currentPreview(
  parsed: Record<string, unknown>,
  source: string,
): MigrationPreview {
  const result = fileV2Schema.safeParse(parsed);
  if (!result.success)
    throw new Error(`Invalid version 2 configuration: ${result.error.message}`);
  return {
    changed: false,
    fromVersion: 2,
    source,
    toVersion: 2,
    warnings: [],
  };
}

function legacyRules(parsed: Record<string, unknown>, filePath: string) {
  const safety = (parsed.safety ?? {}) as Record<string, unknown>;
  const workspace = (parsed.workspace ?? {}) as { roots?: unknown };
  const roots = Array.isArray(workspace.roots)
    ? workspace.roots.filter((item): item is string => typeof item === "string")
    : [];
  const followSymlinks = safety.follow_symlinks === true;
  const warnings: string[] = [];
  const rules = roots.map((root, index) =>
    rule(
      `legacy-workspace-${index + 1}`,
      path.resolve(path.dirname(filePath), root),
      followSymlinks,
    ),
  );
  if (safety.allow_temp_directory !== false)
    rules.push(rule("legacy-os-temp", os.tmpdir(), followSymlinks));
  if (safety.allow_any_path === true) {
    rules.push(
      rule(
        "legacy-unrestricted",
        path.parse(path.resolve(filePath)).root,
        followSymlinks,
      ),
    );
    warnings.push(
      "UNRESTRICTED: safety.allow_any_path=true became an explicit catch-all path rule",
    );
  }
  return { rules, warnings };
}

function migrateLegacyText(
  source: string,
  parsed: Record<string, unknown>,
  filePath: string,
) {
  const { rules, warnings } = legacyRules(parsed, filePath);
  let migrated = source;
  const versionPattern = /^([\t ]*version[\t ]*=[\t ]*)[^\s#]+(.*)$/m;
  migrated = versionPattern.test(migrated)
    ? migrated.replace(
        versionPattern,
        (_match, prefix: string, suffix: string) => `${prefix}2${suffix}`,
      )
    : `version = 2\n\n${migrated}`;
  const formatting = (parsed.formatting ?? {}) as Record<string, unknown>;
  if (formatting.fallback === undefined)
    migrated = insertIntoSection(migrated, "formatting", 'fallback = "dprint"');
  migrated = formatterDefaults(migrated);
  migrated = insertIntoSection(
    migrated,
    "files.patch",
    'aider_matchers = ["exact", "whitespace", "relative-indentation", "diff-match-patch"]',
  );
  migrated = stripLegacySafety(migrated);
  migrated = `${migrated.trimEnd()}\n\n${rules.join("\n\n")}\n`;
  const validated = fileV2Schema.safeParse(Bun.TOML.parse(migrated));
  if (!validated.success)
    throw new Error(
      `Generated invalid version 2 configuration: ${validated.error.message}`,
    );
  return { migrated, warnings };
}

export function migrateConfigSource(
  source: string,
  filePath: string,
): MigrationPreview {
  const { fromVersion, parsed } = parsedMigration(source);
  if (fromVersion === 2) return currentPreview(parsed, source);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const normalized = source.replaceAll("\r\n", "\n");
  const { migrated, warnings } = migrateLegacyText(
    normalized,
    parsed,
    filePath,
  );
  return {
    changed: migrated !== normalized,
    fromVersion,
    source: newline === "\r\n" ? migrated.replaceAll("\n", "\r\n") : migrated,
    toVersion: 2,
    warnings,
  };
}

export async function writeMigratedConfig(
  filePath: string,
  source: string,
  backup = true,
): Promise<string | undefined> {
  const metadata = await lstat(filePath);
  const backupPath = backup ? `${filePath}.v1.bak` : undefined;
  if (backupPath) await copyFile(filePath, backupPath);
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.migrate-${randomUUID()}`,
  );
  try {
    await writeFile(temporary, source, { flag: "wx", mode: metadata.mode });
    await chmod(temporary, metadata.mode);
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return backupPath;
}

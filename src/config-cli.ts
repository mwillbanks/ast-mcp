import { readFile } from "node:fs/promises";
import path from "node:path";
import { globalConfigPath, resolveConfig } from "./config";
import { migrateConfigSource, writeMigratedConfig } from "./config-migrate";

class ConfigurationUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationUsageError";
  }
}

const stdout = process.stdout;

function valueAfter(tokens: string[], index: number) {
  const value = tokens[index + 1];
  if (!value || value.startsWith("-"))
    throw new ConfigurationUsageError(
      `Missing value for ${tokens[index] ?? "option"}`,
    );
  return value;
}

type ConfigOperation = "validate" | "show" | "migrate";

type ConfigOptions = {
  backup: boolean;
  check: boolean;
  file?: string;
  global: boolean;
  root: string;
  write: boolean;
};

function normalizeTokens(args: string[]): string[] {
  return args.flatMap((token) => {
    for (const option of ["root", "file", "to"])
      if (token.startsWith(`--${option}=`))
        return [`--${option}`, token.slice(option.length + 3)];
    return [token];
  });
}

function configOperation(token: string | undefined): ConfigOperation {
  if (token === "validate" || token === "show" || token === "migrate")
    return token;
  throw new ConfigurationUsageError(
    `Expected config validate, config show, or config migrate; received "${token ?? ""}"`,
  );
}

function valueOption(
  token: string | undefined,
  tokens: string[],
  index: number,
  options: ConfigOptions,
): boolean {
  if (token === "--root" || token === "-r")
    options.root = valueAfter(tokens, index);
  else if (token === "--file") options.file = valueAfter(tokens, index);
  else if (token === "--to") {
    if (valueAfter(tokens, index) !== "2")
      throw new ConfigurationUsageError("Only --to 2 is supported");
  } else return false;
  return true;
}

function flagOption(
  token: string | undefined,
  options: ConfigOptions,
): boolean {
  if (token === "--global") options.global = true;
  else if (token === "--check") options.check = true;
  else if (token === "--write") options.write = true;
  else if (token === "--no-backup") options.backup = false;
  else return false;
  return true;
}

function configOptions(tokens: string[]): ConfigOptions {
  const options: ConfigOptions = {
    backup: true,
    check: false,
    global: false,
    root: process.cwd(),
    write: false,
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (valueOption(token, tokens, index, options)) index += 1;
    else if (!flagOption(token, options))
      throw new ConfigurationUsageError(`Unknown option: ${token}`);
  }
  return options;
}

function assertReadOptions(options: ConfigOptions): void {
  if (
    options.file ||
    options.global ||
    options.check ||
    options.write ||
    !options.backup
  )
    throw new ConfigurationUsageError(
      "Migration options require config migrate",
    );
}

async function runConfigRead(
  operation: Exclude<ConfigOperation, "migrate">,
  options: ConfigOptions,
  write: (text: string) => void,
): Promise<void> {
  assertReadOptions(options);
  const config = await resolveConfig({ cwd: path.resolve(options.root) });
  const output =
    operation === "show"
      ? config
      : {
          projectRoot: config.projectRoot,
          sources: config.sources,
          valid: true,
          version: config.version,
        };
  write(`${JSON.stringify(output, null, 2)}\n`);
}

function migrationTarget(options: ConfigOptions): string {
  if (options.file) return path.resolve(options.file);
  if (options.global) return path.resolve(globalConfigPath());
  return path.resolve(options.root, "ast-mcp.toml");
}

async function migrationBackup(
  options: ConfigOptions,
  migration: ReturnType<typeof migrateConfigSource>,
  target: string,
) {
  if (!options.write || !migration.changed) return undefined;
  return writeMigratedConfig(target, migration.source, options.backup);
}

function migrationReport(
  options: ConfigOptions,
  migration: ReturnType<typeof migrateConfigSource>,
  target: string,
  backupPath: string | undefined,
) {
  return {
    backupPath,
    changed: migration.changed,
    file: target,
    fromVersion: migration.fromVersion,
    preview: options.write ? undefined : migration.source,
    toVersion: migration.toVersion,
    warnings: migration.warnings,
    written: options.write && migration.changed,
  };
}

async function runMigration(
  options: ConfigOptions,
  write: (text: string) => void,
): Promise<number> {
  if (options.file && options.global)
    throw new ConfigurationUsageError("Choose only one of --file or --global");
  if (options.check && options.write)
    throw new ConfigurationUsageError("--check and --write cannot be combined");
  const target = migrationTarget(options);
  const migration = migrateConfigSource(await readFile(target, "utf8"), target);
  const backupPath = await migrationBackup(options, migration, target);
  write(
    `${JSON.stringify(
      migrationReport(options, migration, target, backupPath),
      null,
      2,
    )}\n`,
  );
  return options.check && migration.changed ? 2 : 0;
}

export async function runConfigCli(
  args: string[],
  write: (text: string) => void = stdout.write.bind(stdout),
): Promise<number | undefined> {
  if (
    args.some(
      (token) =>
        token === "--root" || token === "-r" || token.startsWith("--root="),
    )
  )
    process.stderr.write(
      "ast-mcp: --root is deprecated; run this command from the project root.\n",
    );
  const tokens = normalizeTokens(args);
  const operation = configOperation(tokens.shift());
  const options = configOptions(tokens);
  if (operation === "migrate") return runMigration(options, write);
  await runConfigRead(operation, options, write);
}

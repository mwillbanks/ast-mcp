import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { currentConfig, type ResolvedConfig } from "../config";
import { replaceFileAtomically } from "./atomic";
import { configuredDprintBinary } from "./dependencies";
import { canonicalizePathSync, containingRoot, pathWithin } from "./path-utils";
import { runCommandInput } from "./process-input";

const dprint = configuredDprintBinary;

export function dprintCacheDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (env.DPRINT_CACHE_DIR) return paths.resolve(env.DPRINT_CACHE_DIR);
  if (platform === "win32")
    return paths.join(
      env.LOCALAPPDATA ?? paths.join(home, "AppData", "Local"),
      "dprint",
      "cache",
    );
  if (platform === "darwin")
    return paths.join(home, "Library", "Caches", "dprint", "cache");
  return paths.join(
    env.XDG_CACHE_HOME ?? paths.join(home, ".cache"),
    "dprint",
    "cache",
  );
}

async function dprintEnvironment(): Promise<
  Record<string, string | undefined>
> {
  const cache = dprintCacheDirectory();
  await mkdir(cache, { recursive: true });
  return { ...process.env, DPRINT_CACHE_DIR: cache };
}
function formatterRoot(config: ResolvedConfig, filePath: string) {
  const project = config.projectRoot;
  if (
    pathWithin(project, filePath) ||
    pathWithin(canonicalizePathSync(project), canonicalizePathSync(filePath))
  )
    return project;
  return (
    containingRoot(
      [...config.workspace.linkedWorktrees, ...config.workspace.roots],
      filePath,
    ) ?? project
  );
}
function formatterPath(config: ResolvedConfig, filePath: string) {
  const root = formatterRoot(config, filePath);
  const relative = path.relative(root, filePath);
  return relative && pathWithin(root, filePath)
    ? relative.split(path.sep).join("/")
    : path.basename(filePath);
}
function matchesFormatter(
  config: ResolvedConfig,
  filePath: string,
  formatter: ResolvedConfig["formatting"]["formatters"][number],
) {
  const extension = path.extname(filePath).toLowerCase();
  if (formatter.extensions.includes(extension)) return true;
  const relative = formatterPath(config, filePath);
  return formatter.globs.some((glob) => new Bun.Glob(glob).match(relative));
}
function formatterArgs(
  config: ResolvedConfig,
  sourceFile: string,
  formatterFile: string,
  args: string[],
) {
  return args.map((argument) =>
    argument
      .replaceAll("{file}", formatterFile)
      .replaceAll("{source_file}", sourceFile)
      .replaceAll("{project_root}", formatterRoot(config, sourceFile)),
  );
}

export class FormatterError extends Error {
  readonly retryable = false;
  readonly suggestedNextCall = "config_status";
  constructor(
    readonly code:
      | "formatter_unavailable"
      | "formatter_timeout"
      | "formatter_invalid_output"
      | "formatter_rejected"
      | "formatter_cleanup_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FormatterError";
  }
}

async function invokeFormatter(
  command: string,
  args: string[],
  content: string,
  options: {
    cwd: string;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  },
) {
  try {
    return await runCommandInput(command, args, content, options);
  } catch (error) {
    const value = error as Error & { code?: string };
    const code =
      value.code === "command_timeout"
        ? "formatter_timeout"
        : value.code === "command_invalid_output"
          ? "formatter_invalid_output"
          : value.code === "ENOENT" ||
              value.code === "EACCES" ||
              value.code === "EPERM"
            ? "formatter_unavailable"
            : "formatter_rejected";
    throw new FormatterError(code, `Formatter ${command}: ${value.message}`, {
      cause: error,
    });
  }
}

async function inPlaceContent(
  config: ResolvedConfig,
  filePath: string,
  content: string,
  formatter: ResolvedConfig["formatting"]["formatters"][number],
) {
  // Retain the basename for filename-sensitive rules. Parent configuration discovery
  // reaches the original directory without exposing the live file to the formatter.
  const directory = await mkdtemp(
    path.join(path.dirname(filePath), ".ast-mcp-format-"),
  );
  const staged = path.join(directory, path.basename(filePath));
  let primaryError: unknown;
  let output = "";
  try {
    await writeFile(staged, content, { flag: "wx", mode: 0o600 });
    await invokeFormatter(
      formatter.command,
      formatterArgs(config, filePath, staged, formatter.args),
      "",
      {
        cwd: formatterRoot(config, filePath),
        timeoutMs: formatter.timeoutMs,
      },
    );
    const metadata = await lstat(staged);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 16 * 1024 * 1024
    )
      throw new FormatterError(
        "formatter_invalid_output",
        "Formatter output must be a regular file of at most 16777216 bytes",
      );
    try {
      output = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(await readFile(staged));
    } catch (error) {
      throw new FormatterError(
        "formatter_invalid_output",
        "Formatter output must be valid UTF-8",
        { cause: error },
      );
    }
  } catch (error) {
    primaryError =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? new FormatterError(
            "formatter_invalid_output",
            "Formatter removed its staged output",
            { cause: error },
          )
        : error;
  }
  try {
    await rm(directory, { force: true, recursive: true });
  } catch (error) {
    primaryError ??= new FormatterError(
      "formatter_cleanup_failed",
      `Failed to remove formatter staging directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (primaryError) throw primaryError;
  return output;
}

export async function formatContent(
  filePath: string,
  content: string,
): Promise<string> {
  const config = await currentConfig();
  if (!config.formatting.enabled) return content;
  const formatter = config.formatting.formatters.find(
    (candidate) =>
      candidate.enabled !== false &&
      matchesFormatter(config, filePath, candidate),
  );
  if (formatter) {
    if (formatter.mode === "in_place")
      return inPlaceContent(config, filePath, content, formatter);
    return (
      await invokeFormatter(
        formatter.command,
        formatterArgs(config, filePath, filePath, formatter.args),
        content,
        {
          cwd: formatterRoot(config, filePath),
          timeoutMs: formatter.timeoutMs,
        },
      )
    ).stdout;
  }
  if (config.formatting.fallback === "preserve") return content;
  if (config.formatting.fallback === "reject")
    throw new FormatterError(
      "formatter_rejected",
      `No enabled formatter matches ${filePath}`,
    );
  const result = await invokeFormatter(
    await dprint(),
    [
      "fmt",
      "--config",
      config.formatting.dprintConfig,
      "--stdin",
      formatterPath(config, filePath),
    ],
    content,
    { cwd: formatterRoot(config, filePath), env: await dprintEnvironment() },
  );
  return result.stdout;
}

export async function assertFormattable(filePath: string): Promise<void> {
  await formatContent(filePath, await Bun.file(filePath).text());
}

export async function formatFileAtomically(filePath: string): Promise<void> {
  const metadata = await lstat(filePath);
  const source = await Bun.file(filePath).text();
  const formatted = await formatContent(filePath, source);
  if (formatted !== source)
    await replaceFileAtomically(filePath, formatted, metadata.mode);
}

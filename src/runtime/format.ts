import { randomUUID } from "node:crypto";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentConfig, type ResolvedConfig } from "../config";
import { replaceFileAtomically } from "./atomic";
import { configuredDprintBinary } from "./dependencies";
import { canonicalizePathSync, containingRoot, pathWithin } from "./path-utils";
import { runCommandInput } from "./process-input";

const dprint = configuredDprintBinary;
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
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
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

async function removeFormatterStage(staged: string): Promise<void> {
  try {
    await unlink(staged);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`Failed to remove formatter stage ${staged}`, {
        cause: error,
      });
  }
}

export async function formatContent(
  filePath: string,
  content: string,
): Promise<string> {
  const config = await currentConfig();
  const formatter = config.formatting.formatters.find(
    (candidate) =>
      (candidate.enabled ?? config.formatting.enabled) &&
      matchesFormatter(config, filePath, candidate),
  );
  if (formatter) {
    if (formatter.mode === "stdout") {
      const result = await runCommandInput(
        formatter.command,
        formatterArgs(config, filePath, filePath, formatter.args),
        content,
        {
          cwd: formatterRoot(config, filePath),
          timeoutMs: formatter.timeoutMs,
        },
      );
      return result.stdout;
    }
    const extension = path.extname(filePath);
    const staged = path.join(
      path.dirname(filePath),
      `.ast-mcp-format-${randomUUID()}${extension}`,
    );
    try {
      await writeFile(staged, content, { flag: "wx" });
      await runCommandInput(
        formatter.command,
        formatterArgs(config, filePath, staged, formatter.args),
        "",
        {
          cwd: formatterRoot(config, filePath),
          timeoutMs: formatter.timeoutMs,
        },
      );
      return await readFile(staged, "utf8");
    } finally {
      await removeFormatterStage(staged);
    }
  }
  if (!config.formatting.enabled || config.formatting.fallback === "preserve")
    return content;
  if (config.formatting.fallback === "reject")
    throw new Error(`No enabled formatter matches ${filePath}`);
  const result = await runCommandInput(
    await dprint(),
    [
      "fmt",
      "--config",
      config.formatting.dprintConfig,
      "--stdin",
      formatterPath(config, filePath),
    ],
    content,
    { cwd: formatterRoot(config, filePath) },
  );
  return result.stdout;
}

export async function assertFormattable(filePath: string): Promise<void> {
  await formatContent(filePath, await readFile(filePath, "utf8"));
}

export async function formatFileAtomically(filePath: string): Promise<void> {
  const metadata = await lstat(filePath);
  const source = await readFile(filePath, "utf8");
  const formatted = await formatContent(filePath, source);
  if (formatted !== source)
    await replaceFileAtomically(filePath, formatted, metadata.mode);
}

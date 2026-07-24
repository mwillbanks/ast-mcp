import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { currentConfig, type ResolvedConfig } from "../config";
import { configuredDprintBinary } from "./dependencies";
import { runCommandInput } from "./process-input";

const dprint = configuredDprintBinary;
function formatterPath(config: ResolvedConfig, filePath: string) {
  const relative = path.relative(config.projectRoot, filePath);
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
  filePath: string,
  args: string[],
) {
  return args.map((argument) =>
    argument
      .replaceAll("{file}", filePath)
      .replaceAll("{project_root}", config.projectRoot),
  );
}

export async function formatContent(
  filePath: string,
  content: string,
): Promise<string> {
  const config = await currentConfig();
  if (!config.formatting.enabled) return content;
  const formatter = config.formatting.formatters.find((candidate) =>
    matchesFormatter(config, filePath, candidate),
  );
  const result = formatter
    ? await runCommandInput(
        formatter.command,
        formatterArgs(config, filePath, formatter.args),
        content,
        { cwd: config.projectRoot, timeoutMs: formatter.timeoutMs },
      )
    : await runCommandInput(
        await dprint(),
        [
          "fmt",
          "--config",
          config.formatting.dprintConfig,
          "--stdin",
          formatterPath(config, filePath),
        ],
        content,
        { cwd: config.projectRoot },
      );
  return result.stdout;
}

export async function assertFormattable(filePath: string): Promise<void> {
  await formatContent(filePath, await readFile(filePath, "utf8"));
}

export async function formatFileAtomically(filePath: string): Promise<void> {
  if (!(await currentConfig()).formatting.enabled) return;
  const metadata = await lstat(filePath);
  const formatted = await formatContent(
    filePath,
    await readFile(filePath, "utf8"),
  );
  const extension = path.extname(filePath);
  const temporary = path.join(
    path.dirname(filePath),
    `${path.basename(filePath, extension)}.ast-mcp-format-${randomUUID()}${extension}`,
  );
  try {
    await writeFile(temporary, formatted, {
      encoding: "utf8",
      flag: "wx",
      mode: metadata.mode,
    });
    await chmod(temporary, metadata.mode);
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

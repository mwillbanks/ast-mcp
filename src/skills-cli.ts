import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  parseOutputArguments,
  selectOutputFormat,
  writeCliOutput,
  type CliOutputContext,
} from "./cli-output";
import { resolveConfig } from "./config";
import { bundledSkills } from "./skills";

export class SkillsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillsUsageError";
  }
}

async function directory(directory: string) {
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(
      "Skill export directories must not be symbolic links or files",
    );
}

export async function exportSkills(destination: string) {
  const root = path.resolve(destination);
  // Resolve caller-chosen ancestors; never follow a symlink inside the export tree.
  await mkdir(path.dirname(root), { recursive: true });
  await directory(root);
  const canonical = await realpath(root);
  const catalog = await bundledSkills();
  const written: string[] = [];
  const preserved: string[] = [];
  for (const file of catalog.files) {
    const segments = file.relative.split("/");
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      await directory(parent);
    }
    const actual = await realpath(parent);
    if (actual !== canonical && !actual.startsWith(canonical + path.sep))
      throw new Error("Skill export directory escaped its destination");
    const target = path.join(parent, segments.at(-1)!);
    const handle = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o644,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST" || error.code === "ELOOP") return undefined;
      throw error;
    });
    if (!handle) {
      preserved.push(file.relative);
      continue;
    }
    try {
      await handle.writeFile(file.bytes);
    } finally {
      await handle.close();
    }
    written.push(file.relative);
  }
  return { destination: root, written, preserved };
}

export async function runSkillsCli(
  args: string[],
  context: CliOutputContext = {},
) {
  const parsed = parseOutputArguments(args);
  args = parsed.args;
  if (
    args.length !== 2 ||
    args[0] !== "export" ||
    !args[1] ||
    args[1].startsWith("-")
  )
    throw new SkillsUsageError("Use ast-mcp skills export <destination>");
  const config = await resolveConfig();
  const format = selectOutputFormat(config, parsed.output, context.isTTY);
  const result = await exportSkills(args[1]);
  writeCliOutput(
    { operation: "export", ...result },
    format,
    "Skill export",
    context.write,
  );
}

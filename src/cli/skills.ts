import { resolveConfig } from "../config";
import { bundledSkills } from "../skills";
import { reconcileSkillExport } from "../skills/export";
import {
  parseOutputArguments,
  selectOutputFormat,
  writeCliOutput,
  type CliOutputContext,
} from "./output";

export class SkillsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillsUsageError";
  }
}

export async function exportSkills(destination: string) {
  return reconcileSkillExport(
    destination,
    "export",
    (await bundledSkills()).files,
  );
}

export async function updateSkills(destination: string) {
  return reconcileSkillExport(
    destination,
    "update",
    (await bundledSkills()).files,
  );
}

export async function runSkillsCli(
  args: string[],
  context: CliOutputContext = {},
) {
  const parsed = parseOutputArguments(args);
  args = parsed.args;
  if (
    args.length !== 2 ||
    (args[0] !== "export" && args[0] !== "update") ||
    !args[1] ||
    args[1].startsWith("-")
  )
    throw new SkillsUsageError(
      "Use ast-mcp skills <export|update> <destination>",
    );
  const operation = args[0];
  const format =
    parsed.output ??
    selectOutputFormat(await resolveConfig(), undefined, context.isTTY);
  const result =
    operation === "export"
      ? await exportSkills(args[1])
      : await updateSkills(args[1]);
  writeCliOutput(
    { operation, ...result },
    format,
    operation === "export" ? "Skill export" : "Skill update",
    context.write,
  );
  if (result.conflicts.length)
    throw new Error(
      "Skill update preserved customized or untracked files: " +
        result.conflicts.join(", ") +
        ". Compare these files with a fresh export and reconcile them manually.",
    );
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { checkMarkdown } from "./check-prose";

const root = path.resolve(import.meta.dir, "..");
const targets = [
  path.join(root, "templates/skills/ast-mcp/references/installation.md"),
];
const issues = (
  await Promise.all(
    targets.map(async (file) =>
      checkMarkdown(file, await readFile(file, "utf8")),
    ),
  )
).flat();

if (issues.length > 0) {
  for (const issue of issues)
    console.error(
      `${path.relative(root, issue.file)}:${issue.line} ${issue.message}`,
    );
  process.exitCode = 1;
}

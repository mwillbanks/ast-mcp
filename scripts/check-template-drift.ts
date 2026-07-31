import { cp, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const canonical = path.join(root, "templates/skills/ast-mcp");
const local = path.join(root, ".codex/skills/ast-mcp");
const write = process.argv.includes("--write");

async function files(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".ast-bro") continue;
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory())
      found.push(...(await files(path.join(directory, entry.name), relative)));
    else found.push(relative);
  }
  return found;
}

const mappings = (await files(canonical)).map((relative) => ({
  destination: path.join(local, relative),
  source: path.join(canonical, relative),
}));
mappings.push(
  {
    destination: path.join(local, "references/agents-guidance.md"),
    source: path.join(root, "templates/AGENTS.md"),
  },
  {
    destination: path.join(local, "references/hook.ts"),
    source: path.join(root, "src/hook.ts"),
  },
);

if (write) {
  for (const mapping of mappings)
    await cp(mapping.source, mapping.destination, { force: true });
}

const drift: string[] = [];
for (const mapping of mappings) {
  const [source, destination] = await Promise.all([
    readFile(mapping.source),
    readFile(mapping.destination).catch(() => undefined),
  ]);
  if (!destination || !source.equals(destination))
    drift.push(path.relative(root, mapping.destination));
}

if (drift.length > 0) {
  console.error(`Template drift: ${drift.join(", ")}`);
  process.exitCode = 1;
}

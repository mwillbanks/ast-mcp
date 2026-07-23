import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isManagedHook } from "./managed-hook";
import { assertAstBroAvailable } from "./runtime/dependencies";

const packageRoot = path.resolve(import.meta.dir, "..");
const cliEntry = path.join(packageRoot, "dist/ast-mcp.js");
const hookEntry = path.join(packageRoot, "src/hook.ts");
const targets = ["codex", "claude", "copilot"] as const;
type Target = (typeof targets)[number];

// biome-ignore lint/suspicious/noExplicitAny: Host configuration JSON is intentionally dynamic.
async function json(file: string): Promise<Record<string, any>> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
async function save(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
function definition(root?: string) {
  return {
    args: [cliEntry, "mcp"],
    command: "bun",
    env: root ? { AST_MCP_ALLOW_EXTERNAL_ROOTS: "1", AST_MCP_ROOTS: root } : {},
  };
}
async function codexMcp(file: string, root?: string) {
  const old = await readFile(file, "utf8").catch(() => "");
  const clean = old
    .replace(/# ast-mcp:begin[\s\S]*?# ast-mcp:end\n?/g, "")
    .trimEnd();
  const environment = root
    ? `env = { AST_MCP_ALLOW_EXTERNAL_ROOTS = "1", AST_MCP_ROOTS = ${JSON.stringify(root)} }\n`
    : "";
  const block = `# ast-mcp:begin\n[mcp_servers.ast-mcp]\ncommand = "bun"\nargs = [${JSON.stringify(cliEntry)}, "mcp"]\n${environment}# ast-mcp:end`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${clean ? `${clean}\n\n` : ""}${block}\n`);
}
async function jsonMcp(file: string, root?: string, copilot = false) {
  const value = await json(file);
  value.mcpServers = {
    ...(value.mcpServers ?? {}),
    "ast-mcp": copilot
      ? { type: "local", ...definition(root), tools: ["*"] }
      : definition(root),
  };
  await save(file, value);
}
async function vscodeMcp(file: string, root: string) {
  const value = await json(file);
  value.servers = {
    ...(value.servers ?? {}),
    "ast-mcp": { type: "stdio", ...definition(root) },
  };
  await save(file, value);
}

async function hook(
  file: string,
  event: "PreToolUse" | "preToolUse",
  scriptFile: string,
  _commandPath?: string,
) {
  await rm(scriptFile, { force: true });
  const value = await json(file);
  if (event === "preToolUse") value.version ??= 1;
  value.hooks ??= {};
  const prior = Array.isArray(value.hooks[event]) ? value.hooks[event] : [];
  const command = `bun ${JSON.stringify(cliEntry)} hook`;
  const kept = prior.filter(
    (item: unknown) => !isManagedHook(item, event, command),
  );
  const item =
    event === "preToolUse"
      ? {
          command,
          matcher: "bash|powershell|edit|create",
          timeoutSec: 10,
          type: "command",
        }
      : {
          hooks: [
            {
              command,
              statusMessage: "Enforcing ast-mcp writes",
              timeout: 10,
              type: "command",
            },
          ],
          matcher: ".*",
        };
  value.hooks[event] = [...kept, item];
  await save(file, value);
}
async function skills(folder: string) {
  const destination = path.join(folder, "ast-mcp");
  await rm(destination, { force: true, recursive: true });
  await mkdir(folder, { recursive: true });
  await cp(path.join(packageRoot, "templates/skills", "ast-mcp"), destination, {
    filter: (source) => path.basename(source) !== ".ast-bro",
    force: true,
    recursive: true,
  });
  await cp(
    path.join(packageRoot, "templates/AGENTS.md"),
    path.join(destination, "references/agents-guidance.md"),
    { force: true },
  );
  await cp(hookEntry, path.join(destination, "references/hook.ts"), {
    force: true,
  });
  await cp(
    path.join(destination, "SKILL.md"),
    path.join(destination, "references/skill-template.md"),
    { force: true },
  );
}
const instructionsBegin = "<!-- ast-mcp:begin -->";
const instructionsEnd = "<!-- ast-mcp:end -->";
const instructionsPattern =
  /<!-- ast-mcp:begin -->[\s\S]*?<!-- ast-mcp:end -->\n?/g;

async function writeText(file: string, content: string) {
  const normalized = content.trimEnd();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, normalized ? `${normalized}\n` : "");
}

async function instructions(file: string) {
  const block = (
    await readFile(path.join(packageRoot, "templates/AGENTS.md"), "utf8")
  ).trim();
  const old = await readFile(file, "utf8").catch(() => "");
  const clean = old.replace(instructionsPattern, "").trimEnd();
  await writeText(
    file,
    `${clean ? `${clean}\n\n` : ""}${instructionsBegin}\n\n${block}\n\n${instructionsEnd}`,
  );
}

async function removeInstructions(file: string) {
  const old = await readFile(file, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (old === undefined) return;
  await writeText(file, old.replace(instructionsPattern, ""));
}

// biome-ignore lint/suspicious/noExplicitAny: Host configuration JSON is intentionally dynamic.
async function saveRemainingJson(file: string, value: Record<string, any>) {
  await save(file, value);
}

async function removeJsonMcp(file: string, section = "mcpServers") {
  const value = await json(file);
  const entries = value[section];
  if (!entries || typeof entries !== "object" || !("ast-mcp" in entries))
    return;
  delete entries["ast-mcp"];
  if (Object.keys(entries).length === 0) delete value[section];
  await saveRemainingJson(file, value);
}

async function removeCodexMcp(file: string) {
  const old = await readFile(file, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (old === undefined) return;
  await writeText(
    file,
    old.replace(/# ast-mcp:begin[\s\S]*?# ast-mcp:end\n?/g, ""),
  );
}

async function removeHook(
  file: string,
  event: "PreToolUse" | "preToolUse",
  commandPath: string,
) {
  const value = await json(file);
  const hooks = value.hooks;
  if (!hooks || !Array.isArray(hooks[event])) return;
  const commands = [
    `bun ${JSON.stringify(commandPath)}`,
    `bun ${JSON.stringify(cliEntry)} hook`,
  ];
  hooks[event] = hooks[event].filter(
    (item: unknown) =>
      !commands.some((command) => isManagedHook(item, event, command)),
  );
  if (hooks[event].length === 0) delete hooks[event];
  if (Object.keys(hooks).length === 0) delete value.hooks;
  await saveRemainingJson(file, value);
}

async function hasLocalInstallation(root: string) {
  const codex = await readFile(
    path.join(root, ".codex/config.toml"),
    "utf8",
  ).catch(() => "");
  const claude = await json(path.join(root, ".mcp.json"));
  const copilot = await json(path.join(root, ".github/mcp.json"));
  return Boolean(
    codex.includes("# ast-mcp:begin") ||
      claude.mcpServers?.["ast-mcp"] ||
      copilot.mcpServers?.["ast-mcp"],
  );
}

export interface InstallOptions {
  astBroBinary?: string;
  home?: string;
  root: string;
  scope: "local" | "global";
  targets: Target[];
}

export class InstallerUsageError extends Error {
  override name = "InstallerUsageError";
}

function targetPaths(
  target: Target,
  global: boolean,
  root: string,
  home: string,
) {
  if (target === "codex") {
    const base = global ? path.join(home, ".codex") : path.join(root, ".codex");
    return [
      path.join(base, "config.toml"),
      path.join(base, "hooks.json"),
      path.join(base, "hooks/ast-mcp.ts"),
      path.join(base, "skills/ast-mcp"),
      global ? path.join(base, "AGENTS.md") : path.join(root, "AGENTS.md"),
    ];
  }
  if (target === "claude") {
    const base = global
      ? path.join(home, ".claude")
      : path.join(root, ".claude");
    return [
      global ? path.join(home, ".claude.json") : path.join(root, ".mcp.json"),
      path.join(base, "settings.json"),
      path.join(base, "hooks/ast-mcp.ts"),
      path.join(base, "skills/ast-mcp"),
      global ? path.join(base, "CLAUDE.md") : path.join(root, "AGENTS.md"),
    ];
  }
  const base = global
    ? path.join(home, ".copilot")
    : path.join(root, ".github");
  return [
    global
      ? path.join(base, "mcp-config.json")
      : path.join(root, ".github/mcp.json"),
    ...(global ? [] : [path.join(root, ".vscode/mcp.json")]),
    path.join(base, "hooks/ast-mcp.json"),
    path.join(base, "hooks/ast-mcp.ts"),
    path.join(base, "skills/ast-mcp"),
    global
      ? path.join(base, "copilot-instructions.md")
      : path.join(root, "AGENTS.md"),
  ];
}

async function snapshot(paths: string[]) {
  const files = new Map<string, string>();
  const visit = async (file: string): Promise<void> => {
    if (path.basename(file) === ".ast-bro") return;
    const metadata = await lstat(file).catch(() => undefined);
    if (!metadata) return;
    if (metadata.isDirectory()) {
      for (const entry of await readdir(file))
        await visit(path.join(file, entry));
      return;
    }
    if (metadata.isFile())
      files.set(file, (await readFile(file)).toString("base64"));
  };
  await Promise.all(paths.map(visit));
  return files;
}

function changedFiles(before: Map<string, string>, after: Map<string, string>) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

async function reconcile(options: InstallOptions) {
  assertAstBroAvailable(options.astBroBinary);
  const root = path.resolve(options.root);
  const home = options.home ?? os.homedir();
  const global = options.scope === "global";
  const paths = options.targets.flatMap((target) =>
    targetPaths(target, global, root, home),
  );
  const before = await snapshot(paths);
  for (const target of options.targets) {
    if (target === "codex") {
      const base = global
        ? path.join(home, ".codex")
        : path.join(root, ".codex");
      await codexMcp(path.join(base, "config.toml"), global ? undefined : root);
      await hook(
        path.join(base, "hooks.json"),
        "PreToolUse",
        path.join(base, "hooks/ast-mcp.ts"),
        global
          ? path.join(base, "hooks/ast-mcp.ts")
          : ".codex/hooks/ast-mcp.ts",
      );
      await skills(path.join(base, "skills"));
      await instructions(
        global ? path.join(base, "AGENTS.md") : path.join(root, "AGENTS.md"),
      );
    } else if (target === "claude") {
      const base = global
        ? path.join(home, ".claude")
        : path.join(root, ".claude");
      await jsonMcp(
        global ? path.join(home, ".claude.json") : path.join(root, ".mcp.json"),
        global ? undefined : root,
      );
      await hook(
        path.join(base, "settings.json"),
        "PreToolUse",
        path.join(base, "hooks/ast-mcp.ts"),
        global
          ? path.join(base, "hooks/ast-mcp.ts")
          : `\${CLAUDE_PROJECT_DIR}/.claude/hooks/ast-mcp.ts`,
      );
      await skills(path.join(base, "skills"));
      await instructions(
        global ? path.join(base, "CLAUDE.md") : path.join(root, "AGENTS.md"),
      );
    } else {
      const base = global
        ? path.join(home, ".copilot")
        : path.join(root, ".github");
      if (global)
        await jsonMcp(path.join(base, "mcp-config.json"), undefined, true);
      else {
        await jsonMcp(path.join(root, ".github/mcp.json"), root, true);
        await vscodeMcp(path.join(root, ".vscode/mcp.json"), root);
      }
      await hook(
        path.join(base, "hooks/ast-mcp.json"),
        "preToolUse",
        path.join(base, "hooks/ast-mcp.ts"),
        global
          ? path.join(base, "hooks/ast-mcp.ts")
          : ".github/hooks/ast-mcp.ts",
      );
      await skills(path.join(base, "skills"));
      await instructions(
        global
          ? path.join(base, "copilot-instructions.md")
          : path.join(root, "AGENTS.md"),
      );
    }
  }
  return changedFiles(before, await snapshot(paths));
}

export async function install(options: InstallOptions) {
  return reconcile(options);
}

export async function update(options: InstallOptions) {
  return reconcile(options);
}

export async function uninstall(options: InstallOptions) {
  const root = path.resolve(options.root);
  const home = options.home ?? os.homedir();
  const global = options.scope === "global";
  const paths = options.targets.flatMap((target) =>
    targetPaths(target, global, root, home),
  );
  const before = await snapshot(paths);
  for (const target of options.targets) {
    if (target === "codex") {
      const base = global
        ? path.join(home, ".codex")
        : path.join(root, ".codex");
      await removeCodexMcp(path.join(base, "config.toml"));
      await removeHook(
        path.join(base, "hooks.json"),
        "PreToolUse",
        global
          ? path.join(base, "hooks/ast-mcp.ts")
          : ".codex/hooks/ast-mcp.ts",
      );
      await rm(path.join(base, "hooks/ast-mcp.ts"), { force: true });
      await rm(path.join(base, "skills/ast-mcp"), {
        force: true,
        recursive: true,
      });
      if (global) await removeInstructions(path.join(base, "AGENTS.md"));
    } else if (target === "claude") {
      const base = global
        ? path.join(home, ".claude")
        : path.join(root, ".claude");
      await removeJsonMcp(
        global ? path.join(home, ".claude.json") : path.join(root, ".mcp.json"),
      );
      await removeHook(
        path.join(base, "settings.json"),
        "PreToolUse",
        global
          ? path.join(base, "hooks/ast-mcp.ts")
          : `\${CLAUDE_PROJECT_DIR}/.claude/hooks/ast-mcp.ts`,
      );
      await rm(path.join(base, "hooks/ast-mcp.ts"), { force: true });
      await rm(path.join(base, "skills/ast-mcp"), {
        force: true,
        recursive: true,
      });
      if (global) await removeInstructions(path.join(base, "CLAUDE.md"));
    } else {
      const base = global
        ? path.join(home, ".copilot")
        : path.join(root, ".github");
      if (global) await removeJsonMcp(path.join(base, "mcp-config.json"));
      else {
        await removeJsonMcp(path.join(root, ".github/mcp.json"));
        await removeJsonMcp(path.join(root, ".vscode/mcp.json"), "servers");
      }
      await removeHook(
        path.join(base, "hooks/ast-mcp.json"),
        "preToolUse",
        global
          ? path.join(base, "hooks/ast-mcp.ts")
          : ".github/hooks/ast-mcp.ts",
      );
      await rm(path.join(base, "hooks/ast-mcp.ts"), { force: true });
      await rm(path.join(base, "skills/ast-mcp"), {
        force: true,
        recursive: true,
      });
      if (global)
        await removeInstructions(path.join(base, "copilot-instructions.md"));
    }
  }
  if (options.scope === "local" && !(await hasLocalInstallation(root)))
    await removeInstructions(path.join(root, "AGENTS.md"));
  return changedFiles(before, await snapshot(paths));
}

export async function runInstallerCli(
  args = process.argv.slice(2),
): Promise<void> {
  const tokens = args.flatMap((token) => {
    const match = /^(--(?:scope|root|target))=(.*)$/.exec(token);
    return match ? [match[1], match[2]] : [token];
  });
  type Operation = "install" | "update" | "uninstall";
  let operation: Operation = "install";
  if (["install", "update", "uninstall"].includes(tokens[0] ?? ""))
    operation = tokens.shift() as Operation;
  let scope: "local" | "global" = "local";
  let root = process.cwd();
  let selected: Target[] = [...targets];
  const valueAfter = (index: number) => {
    const value = tokens[index + 1];
    if (!value || value.startsWith("-"))
      throw new InstallerUsageError(
        `Missing value for ${tokens[index] ?? "option"}`,
      );
    return value;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (["--scope", "-s"].includes(tokens[index] ?? "")) {
      scope = valueAfter(index) as typeof scope;
      index += 1;
    } else if (["--root", "-r"].includes(tokens[index] ?? "")) {
      root = valueAfter(index);
      index += 1;
    } else if (["--target", "-t"].includes(tokens[index] ?? "")) {
      const value = valueAfter(index);
      selected = value === "all" ? [...targets] : [value as Target];
      index += 1;
    } else throw new InstallerUsageError(`Unknown option: ${tokens[index]}`);
  }
  if (!["local", "global"].includes(scope))
    throw new InstallerUsageError(
      `Invalid scope "${scope}"; expected local or global`,
    );
  const invalidTarget = selected.find((item) => !targets.includes(item));
  if (invalidTarget)
    throw new InstallerUsageError(
      `Invalid target "${invalidTarget}"; expected codex, claude, copilot, or all`,
    );
  const options = { root, scope, targets: selected };
  const changed =
    operation === "install"
      ? await install(options)
      : operation === "update"
        ? await update(options)
        : await uninstall(options);
  const _label =
    operation === "install"
      ? "Installed"
      : operation === "update"
        ? "Updated"
        : "Uninstalled";
  process.stdout.write(`${JSON.stringify({ changed, operation })}\n`);
}
if (import.meta.main) await runInstallerCli();

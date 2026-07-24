#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Scope = "local" | "global";
type Target = "codex" | "claude" | "copilot";
type Transport = "stdio" | "http";

function parse(args: string[]) {
  let scope: Scope = "local";
  let target: Target = "codex";
  let root = process.cwd();
  let transport: Transport = "stdio";
  let host = "127.0.0.1";
  let port = 3768;
  let service = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--scope") scope = args[++index] as Scope;
    else if (args[index] === "--target") target = args[++index] as Target;
    else if (args[index] === "--root") root = path.resolve(args[++index]);
    else if (args[index] === "--transport")
      transport = args[++index] as Transport;
    else if (args[index] === "--host") host = args[++index];
    else if (args[index] === "--port") port = Number(args[++index]);
    else if (args[index] === "--service") service = true;
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (
    !["local", "global"].includes(scope) ||
    !["codex", "claude", "copilot"].includes(target) ||
    !["stdio", "http"].includes(transport)
  )
    throw new Error("Invalid --scope, --target, or --transport");
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("Invalid --port");
  if (service && transport !== "http")
    throw new Error("--service requires --transport http");
  const clientHost =
    host === "0.0.0.0"
      ? "127.0.0.1"
      : host === "::"
        ? "::1"
        : host.startsWith("[") && host.endsWith("]")
          ? host.slice(1, -1)
          : host;
  const url = `http://${clientHost.includes(":") ? `[${clientHost}]` : clientHost}:${port}/mcp`;
  return { host, port, root, scope, service, target, transport, url };
}

const instructionsBegin = "<!-- ast-mcp:begin -->";
const instructionsEnd = "<!-- ast-mcp:end -->";

async function astMcpEntry(entry: unknown): Promise<boolean> {
  if (typeof entry !== "string" || path.basename(entry) !== "ast-mcp.js")
    return false;
  let folder = path.dirname(path.resolve(entry));
  while (true) {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(folder, "package.json"), "utf8"),
      );
      return (
        manifest.name === "@mwillbanks/ast-mcp" &&
        path.resolve(entry) === path.join(folder, "dist/ast-mcp.js")
      );
    } catch {}
    const parent = path.dirname(folder);
    if (parent === folder) return false;
    folder = parent;
  }
}

async function expectedReference(
  name: "agents-guidance.md" | "hook.ts" | "skill-template.md",
) {
  const bundled = path.resolve(import.meta.dir, "../references", name);
  const source =
    name === "agents-guidance.md"
      ? path.resolve(import.meta.dir, "../../../AGENTS.md")
      : name === "hook.ts"
        ? path.resolve(import.meta.dir, "../../../../src/hook.ts")
        : path.resolve(import.meta.dir, "../SKILL.md");
  return (
    await readFile(bundled, "utf8").catch(() => readFile(source, "utf8"))
  ).trim();
}

async function managedInstructions(file: string) {
  const content = await readFile(file, "utf8").catch(() => "");
  const begin = content.indexOf(instructionsBegin);
  const end = content.indexOf(
    instructionsEnd,
    begin + instructionsBegin.length,
  );
  if (begin < 0 || end < 0) return undefined;
  return content.slice(begin + instructionsBegin.length, end).trim();
}

async function instructionsCurrent(file: string) {
  return (
    (await managedInstructions(file)) ===
    (await expectedReference("agents-guidance.md"))
  );
}

async function skillCurrent(file: string) {
  const installed = await readFile(file, "utf8").catch(() => "");
  return installed.trim() === (await expectedReference("skill-template.md"));
}

async function hookCurrent(
  configFile: string,
  event: "PreToolUse" | "preToolUse",
  _scriptFile: string,
  _commandPath?: string,
) {
  const config = JSON.parse(
    await readFile(configFile, "utf8").catch(() => "{}"),
  );
  const entries = Array.isArray(config.hooks?.[event])
    ? config.hooks[event]
    : [];
  const commands =
    event === "preToolUse"
      ? entries.map((item: { command?: unknown }) => item.command)
      : entries.flatMap((item: { hooks?: Array<{ command?: unknown }> }) =>
          (item.hooks ?? []).map((child) => child.command),
        );
  for (const command of commands) {
    if (typeof command !== "string") continue;
    const match = command.match(/^bun (.+) hook$/);
    if (!match) continue;
    try {
      if (await astMcpEntry(JSON.parse(match[1]))) return true;
    } catch {}
  }
  return false;
}

async function jsonMcpCurrent(
  file: string,
  section: "mcpServers" | "servers",
  root?: string,
  type?: "local" | "stdio",
  transport: Transport = "stdio",
  url?: string,
) {
  const value = JSON.parse(await readFile(file, "utf8").catch(() => "{}"));
  const entry = value[section]?.["ast-mcp"];
  if (transport === "http")
    return (
      entry?.type === "http" &&
      entry.url === url &&
      (type !== "local" || Array.isArray(entry.tools))
    );
  if (
    entry?.command !== "bun" ||
    !Array.isArray(entry.args) ||
    !(await astMcpEntry(entry.args[0])) ||
    entry.args[1] !== "mcp"
  )
    return false;
  if (type && entry.type !== type) return false;
  if (root && entry.env?.AST_MCP_PROJECT_ROOT !== root) return false;
  if (!root && Object.keys(entry.env ?? {}).length !== 0) return false;
  if (type === "local" && !Array.isArray(entry.tools)) return false;
  return true;
}

async function codexMcpCurrent(
  file: string,
  root?: string,
  transport: Transport = "stdio",
  url?: string,
) {
  const content = await readFile(file, "utf8").catch(() => "");
  const block =
    content.match(/# ast-mcp:begin\n([\s\S]*?)# ast-mcp:end/)?.[1] ?? "";
  if (transport === "http")
    return (
      block.includes("[mcp_servers.ast-mcp]") &&
      block.includes(`url = ${JSON.stringify(url)}`) &&
      !block.includes("command =")
    );
  const args = block.match(/args = \[(".*"), "mcp"\]/);
  if (
    !block.includes("[mcp_servers.ast-mcp]") ||
    !block.includes('command = "bun"') ||
    !args ||
    !(await astMcpEntry(JSON.parse(args[1])))
  )
    return false;
  return root
    ? block.includes(`AST_MCP_PROJECT_ROOT = ${JSON.stringify(root)}`)
    : !block.includes("AST_MCP_PROJECT_ROOT");
}

export async function checkInstall(
  args = process.argv.slice(2),
  home = os.homedir(),
) {
  const options = parse(args);
  const global = options.scope === "global";
  const checks: Record<string, boolean> = {};
  if (options.target === "codex") {
    const base = global
      ? path.join(home, ".codex")
      : path.join(options.root, ".codex");
    checks.mcp = await codexMcpCurrent(
      path.join(base, "config.toml"),
      global ? undefined : options.root,
      options.transport,
      options.url,
    );
    checks.hook = await hookCurrent(
      path.join(base, "hooks.json"),
      "PreToolUse",
      path.join(base, "hooks/ast-mcp.ts"),
      global ? path.join(base, "hooks/ast-mcp.ts") : ".codex/hooks/ast-mcp.ts",
    );
    checks.skill = await skillCurrent(
      path.join(base, "skills/ast-mcp/SKILL.md"),
    );
    checks.instructions = await instructionsCurrent(
      global
        ? path.join(base, "AGENTS.md")
        : path.join(options.root, "AGENTS.md"),
    );
  } else if (options.target === "claude") {
    const base = global
      ? path.join(home, ".claude")
      : path.join(options.root, ".claude");
    checks.mcp = await jsonMcpCurrent(
      global
        ? path.join(home, ".claude.json")
        : path.join(options.root, ".mcp.json"),
      "mcpServers",
      global ? undefined : options.root,
      undefined,
      options.transport,
      options.url,
    );
    checks.hook = await hookCurrent(
      path.join(base, "settings.json"),
      "PreToolUse",
      path.join(base, "hooks/ast-mcp.ts"),
      global
        ? path.join(base, "hooks/ast-mcp.ts")
        : `\${CLAUDE_PROJECT_DIR}/.claude/hooks/ast-mcp.ts`,
    );
    checks.skill = await skillCurrent(
      path.join(base, "skills/ast-mcp/SKILL.md"),
    );
    checks.instructions = await instructionsCurrent(
      global
        ? path.join(base, "CLAUDE.md")
        : path.join(options.root, "AGENTS.md"),
    );
  } else {
    const base = global
      ? path.join(home, ".copilot")
      : path.join(options.root, ".github");
    checks.mcp = await jsonMcpCurrent(
      global
        ? path.join(base, "mcp-config.json")
        : path.join(options.root, ".github/mcp.json"),
      "mcpServers",
      global ? undefined : options.root,
      "local",
      options.transport,
      options.url,
    );
    checks.hook = await hookCurrent(
      path.join(base, "hooks/ast-mcp.json"),
      "preToolUse",
      path.join(base, "hooks/ast-mcp.ts"),
      global ? path.join(base, "hooks/ast-mcp.ts") : ".github/hooks/ast-mcp.ts",
    );
    checks.skill = await skillCurrent(
      path.join(base, "skills/ast-mcp/SKILL.md"),
    );
    checks.instructions = await instructionsCurrent(
      global
        ? path.join(base, "copilot-instructions.md")
        : path.join(options.root, "AGENTS.md"),
    );
    if (!global)
      checks.vscode = await jsonMcpCurrent(
        path.join(options.root, ".vscode/mcp.json"),
        "servers",
        options.root,
        "stdio",
        options.transport,
        options.url,
      );
  }
  if (options.service) {
    if (process.platform !== "darwin" && process.platform !== "linux")
      checks.service = false;
    else {
      const digest = new Bun.CryptoHasher("sha256")
        .update(path.resolve(options.root))
        .digest("hex")
        .slice(0, 12);
      const id = options.scope === "global" ? "ast-mcp" : `ast-mcp-${digest}`;
      const file =
        process.platform === "darwin"
          ? path.join(
              home,
              "Library/LaunchAgents",
              `com.mwillbanks.${id}.plist`,
            )
          : path.join(home, ".config/systemd/user", `${id}.service`);
      let content = "";
      try {
        content = await readFile(file, "utf8");
      } catch {}
      checks.service =
        content.includes("--transport") &&
        content.includes("http") &&
        content.includes(options.host) &&
        content.includes(String(options.port)) &&
        (options.scope === "global" ||
          content.includes(path.resolve(options.root)));
    }
  }
  const installed = Object.values(checks).every(Boolean);
  const operation = installed
    ? "none"
    : Object.values(checks).some(Boolean)
      ? "update"
      : "install";
  const suffix = `--scope ${options.scope} --target ${options.target}${global ? "" : ` --root ${JSON.stringify(options.root)}`}${options.transport === "http" ? ` --transport http --host ${JSON.stringify(options.host)} --port ${options.port}` : ""}${options.service ? " --service" : ""}`;
  const installCommand = global
    ? `bun add --global --trust @ast-bro/cli dprint @mwillbanks/ast-mcp && ast-mcp install ${suffix}`
    : `bun add --dev @mwillbanks/ast-mcp && bun pm trust @ast-bro/cli dprint && ./node_modules/.bin/ast-mcp install ${suffix}`;
  const updateCommand = global
    ? `ast-mcp update ${suffix}`
    : `./node_modules/.bin/ast-mcp update ${suffix}`;
  const uninstallCommand = global
    ? `ast-mcp uninstall ${suffix}`
    : `./node_modules/.bin/ast-mcp uninstall ${suffix}`;
  return {
    checks,
    installCommand,
    installed,
    needsUpdate: operation === "update",
    operation,
    recommendedCommand:
      operation === "update"
        ? updateCommand
        : operation === "install"
          ? installCommand
          : undefined,
    uninstallCommand,
    updateCommand,
    ...options,
  };
}
export async function runCheckInstallCli(args = process.argv.slice(2)) {
  process.stdout.write(`${JSON.stringify(await checkInstall(args))}\n`);
}
if (import.meta.main) await runCheckInstallCli();

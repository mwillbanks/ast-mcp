#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Scope = "local" | "global";
type Target = "codex" | "claude" | "copilot";
type Transport = "stdio" | "http";

type CheckOptions = {
  host: string;
  port: number;
  root: string;
  scope: Scope;
  service: boolean;
  target: Target;
  transport: Transport;
  url: string;
};
type MutableCheckOptions = Omit<CheckOptions, "url">;
function applyOption(
  options: MutableCheckOptions,
  args: string[],
  index: number,
) {
  const option = args[index];
  const value = args[index + 1];
  switch (option) {
    case "--scope":
      options.scope = value as Scope;
      return index + 1;
    case "--target":
      options.target = value as Target;
      return index + 1;
    case "--root":
      options.root = path.resolve(value);
      return index + 1;
    case "--transport":
      options.transport = value as Transport;
      return index + 1;
    case "--host":
      options.host = value;
      return index + 1;
    case "--port":
      options.port = Number(value);
      return index + 1;
    case "--service":
      options.service = true;
      return index;
    default:
      throw new Error(`Unknown argument: ${option}`);
  }
}
function validateOptions(options: MutableCheckOptions) {
  if (
    !["local", "global"].includes(options.scope) ||
    !["codex", "claude", "copilot"].includes(options.target) ||
    !["stdio", "http"].includes(options.transport)
  )
    throw new Error("Invalid --scope, --target, or --transport");
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65_535
  )
    throw new Error("Invalid --port");
  if (options.service && options.transport !== "http")
    throw new Error("--service requires --transport http");
}
function clientHost(host: string) {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}
function endpointUrl(host: string, port: number) {
  const client = clientHost(host);
  return `http://${client.includes(":") ? `[${client}]` : client}:${port}/mcp`;
}
function parse(args: string[]): CheckOptions {
  const options: MutableCheckOptions = {
    host: "127.0.0.1",
    port: 3768,
    root: process.cwd(),
    scope: "local",
    service: false,
    target: "codex",
    transport: "stdio",
  };
  for (let index = 0; index < args.length; index += 1)
    index = applyOption(options, args, index);
  validateOptions(options);
  return { ...options, url: endpointUrl(options.host, options.port) };
}

const instructionsBegin = "<!-- ast-mcp:begin -->";
const instructionsEnd = "<!-- ast-mcp:end -->";

async function astMcpEntry(entry: unknown): Promise<boolean> {
  if (entry === "./node_modules/.bin/ast-mcp") return true;
  if (typeof entry !== "string" || path.basename(entry) !== "ast-mcp")
    return false;
  const bin = path.dirname(entry);
  return (
    path.basename(bin) === "bin" && path.basename(path.dirname(bin)) === ".bun"
  );
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
    const match = command.match(/^(.+) hook$/);
    if (!match) continue;
    try {
      if (await astMcpEntry(JSON.parse(match[1]))) return true;
    } catch {}
  }
  return false;
}

type McpEntry = {
  args?: unknown[];
  command?: unknown;
  env?: Record<string, unknown>;
  tools?: unknown;
  type?: unknown;
  url?: unknown;
};
function httpJsonMcpCurrent(
  entry: McpEntry | undefined,
  type: "local" | "stdio" | undefined,
  url: string | undefined,
) {
  return (
    entry?.type === "http" &&
    entry.url === url &&
    (type !== "local" || Array.isArray(entry.tools))
  );
}
async function stdioCommandCurrent(entry: McpEntry | undefined) {
  return (
    (await astMcpEntry(entry?.command)) &&
    Array.isArray(entry?.args) &&
    entry.args.length === 1 &&
    entry.args[0] === "mcp"
  );
}

function entryTypeCurrent(
  entry: McpEntry,
  type: "local" | "stdio" | undefined,
) {
  if (!type) return true;
  if (entry.type !== type) return false;
  return type !== "local" || Array.isArray(entry.tools);
}

function entryRootCurrent(entry: McpEntry, root: string | undefined) {
  return root
    ? entry.env?.AST_MCP_PROJECT_ROOT === root
    : Object.keys(entry.env ?? {}).length === 0;
}

function stdioMetadataCurrent(
  entry: McpEntry,
  root: string | undefined,
  type: "local" | "stdio" | undefined,
) {
  return entryTypeCurrent(entry, type) && entryRootCurrent(entry, root);
}

async function stdioJsonMcpCurrent(
  entry: McpEntry | undefined,
  root: string | undefined,
  type: "local" | "stdio" | undefined,
) {
  return (
    (await stdioCommandCurrent(entry)) &&
    stdioMetadataCurrent(entry as McpEntry, root, type)
  );
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
  const entry: McpEntry | undefined = value[section]?.["ast-mcp"];
  return transport === "http"
    ? httpJsonMcpCurrent(entry, type, url)
    : stdioJsonMcpCurrent(entry, root, type);
}

function codexHttpMcpCurrent(block: string, url: string | undefined) {
  return (
    block.includes("[mcp_servers.ast-mcp]") &&
    block.includes(`url = ${JSON.stringify(url)}`) &&
    !block.includes("command =")
  );
}
async function codexStdioMcpCurrent(block: string, root: string | undefined) {
  const command = block.match(/command = (".*")/);
  if (
    !block.includes("[mcp_servers.ast-mcp]") ||
    !block.includes('args = ["mcp"]') ||
    !command ||
    !(await astMcpEntry(JSON.parse(command[1])))
  )
    return false;
  return root
    ? block.includes(`AST_MCP_PROJECT_ROOT = ${JSON.stringify(root)}`)
    : !block.includes("AST_MCP_PROJECT_ROOT");
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
  return transport === "http"
    ? codexHttpMcpCurrent(block, url)
    : codexStdioMcpCurrent(block, root);
}

type InstallChecks = Record<string, boolean>;
async function codexChecks(
  options: CheckOptions,
  home: string,
  global: boolean,
): Promise<InstallChecks> {
  const base = global
    ? path.join(home, ".codex")
    : path.join(options.root, ".codex");
  const [mcp, hook, skill, instructions] = await Promise.all([
    codexMcpCurrent(
      path.join(base, "config.toml"),
      global ? undefined : options.root,
      options.transport,
      options.url,
    ),
    hookCurrent(
      path.join(base, "hooks.json"),
      "PreToolUse",
      path.join(base, "hooks/ast-mcp.ts"),
      global ? path.join(base, "hooks/ast-mcp.ts") : ".codex/hooks/ast-mcp.ts",
    ),
    skillCurrent(path.join(base, "skills/ast-mcp/SKILL.md")),
    instructionsCurrent(
      global
        ? path.join(base, "AGENTS.md")
        : path.join(options.root, "AGENTS.md"),
    ),
  ]);
  return { hook, instructions, mcp, skill };
}
async function claudeChecks(
  options: CheckOptions,
  home: string,
  global: boolean,
): Promise<InstallChecks> {
  const base = global
    ? path.join(home, ".claude")
    : path.join(options.root, ".claude");
  const [mcp, hook, skill, instructions] = await Promise.all([
    jsonMcpCurrent(
      global
        ? path.join(home, ".claude.json")
        : path.join(options.root, ".mcp.json"),
      "mcpServers",
      global ? undefined : options.root,
      undefined,
      options.transport,
      options.url,
    ),
    hookCurrent(
      path.join(base, "settings.json"),
      "PreToolUse",
      path.join(base, "hooks/ast-mcp.ts"),
      global
        ? path.join(base, "hooks/ast-mcp.ts")
        : `\${CLAUDE_PROJECT_DIR}/.claude/hooks/ast-mcp.ts`,
    ),
    skillCurrent(path.join(base, "skills/ast-mcp/SKILL.md")),
    instructionsCurrent(
      global
        ? path.join(base, "CLAUDE.md")
        : path.join(options.root, "AGENTS.md"),
    ),
  ]);
  return { hook, instructions, mcp, skill };
}
async function copilotChecks(
  options: CheckOptions,
  home: string,
  global: boolean,
): Promise<InstallChecks> {
  const base = global
    ? path.join(home, ".copilot")
    : path.join(options.root, ".github");
  const [mcp, hook, skill, instructions] = await Promise.all([
    jsonMcpCurrent(
      global
        ? path.join(base, "mcp-config.json")
        : path.join(options.root, ".github/mcp.json"),
      "mcpServers",
      global ? undefined : options.root,
      "local",
      options.transport,
      options.url,
    ),
    hookCurrent(
      path.join(base, "hooks/ast-mcp.json"),
      "preToolUse",
      path.join(base, "hooks/ast-mcp.ts"),
      global ? path.join(base, "hooks/ast-mcp.ts") : ".github/hooks/ast-mcp.ts",
    ),
    skillCurrent(path.join(base, "skills/ast-mcp/SKILL.md")),
    instructionsCurrent(
      global
        ? path.join(base, "copilot-instructions.md")
        : path.join(options.root, "AGENTS.md"),
    ),
  ]);
  const checks: InstallChecks = { hook, instructions, mcp, skill };
  if (!global)
    checks.vscode = await jsonMcpCurrent(
      path.join(options.root, ".vscode/mcp.json"),
      "servers",
      options.root,
      "stdio",
      options.transport,
      options.url,
    );
  return checks;
}
function targetChecks(options: CheckOptions, home: string, global: boolean) {
  if (options.target === "codex") return codexChecks(options, home, global);
  if (options.target === "claude") return claudeChecks(options, home, global);
  return copilotChecks(options, home, global);
}
function serviceFile(options: CheckOptions, home: string) {
  const digest = new Bun.CryptoHasher("sha256")
    .update(path.resolve(options.root))
    .digest("hex")
    .slice(0, 12);
  const id = options.scope === "global" ? "ast-mcp" : `ast-mcp-${digest}`;
  return process.platform === "darwin"
    ? path.join(home, "Library/LaunchAgents", `com.mwillbanks.${id}.plist`)
    : path.join(home, ".config/systemd/user", `${id}.service`);
}
async function serviceCurrent(options: CheckOptions, home: string) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    return false;
  const content = await readFile(serviceFile(options, home), "utf8").catch(
    () => "",
  );
  return (
    content.includes("--transport") &&
    content.includes("http") &&
    content.includes(options.host) &&
    content.includes(String(options.port)) &&
    (options.scope === "global" || content.includes(path.resolve(options.root)))
  );
}
function installOperation(checks: InstallChecks) {
  if (Object.values(checks).every(Boolean)) return "none" as const;
  return Object.values(checks).some(Boolean)
    ? ("update" as const)
    : ("install" as const);
}
function commandSuffix(options: CheckOptions, global: boolean) {
  return `--scope ${options.scope} --target ${options.target}${global ? "" : ` --root ${JSON.stringify(options.root)}`}${options.transport === "http" ? ` --transport http --host ${JSON.stringify(options.host)} --port ${options.port}` : ""}${options.service ? " --service" : ""}`;
}
function installCommands(options: CheckOptions, global: boolean) {
  const suffix = commandSuffix(options, global);
  return {
    installCommand: global
      ? `bun add --global --trust @ast-bro/cli dprint @mwillbanks/ast-mcp && ast-mcp install ${suffix}`
      : `bun add --dev @mwillbanks/ast-mcp && bun pm trust @ast-bro/cli dprint && ./node_modules/.bin/ast-mcp install ${suffix}`,
    uninstallCommand: global
      ? `ast-mcp uninstall ${suffix}`
      : `./node_modules/.bin/ast-mcp uninstall ${suffix}`,
    updateCommand: global
      ? `ast-mcp update ${suffix}`
      : `./node_modules/.bin/ast-mcp update ${suffix}`,
  };
}
export async function checkInstall(
  args = process.argv.slice(2),
  home = os.homedir(),
) {
  const options = parse(args);
  const global = options.scope === "global";
  const checks = await targetChecks(options, home, global);
  if (options.service) checks.service = await serviceCurrent(options, home);
  const installed = Object.values(checks).every(Boolean);
  const operation = installOperation(checks);
  const commands = installCommands(options, global);
  return {
    checks,
    installCommand: commands.installCommand,
    installed,
    needsUpdate: operation === "update",
    operation,
    recommendedCommand:
      operation === "update"
        ? commands.updateCommand
        : operation === "install"
          ? commands.installCommand
          : undefined,
    uninstallCommand: commands.uninstallCommand,
    updateCommand: commands.updateCommand,
    ...options,
  };
}
export async function runCheckInstallCli(args = process.argv.slice(2)) {
  process.stdout.write(`${JSON.stringify(await checkInstall(args))}\n`);
}
if (import.meta.main) await runCheckInstallCli();

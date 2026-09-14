#!/usr/bin/env bun
// biome-ignore-all assist/source/useSortedKeys: Diagnostic output preserves stable user-facing order.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  globalBinDirectories,
  isExecutable,
  resolveGlobalBinaryAlias,
} from "./binary-resolution";
import { managedAstMcpHookEntry } from "./managed-hook";

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
const expectedIntelligenceTools = [
  "graph_diff",
  "graph_explain",
  "graph_path",
  "graph_query",
  "index",
  "index_status",
  "retrieve",
  "workspace_open",
  "workspace_status",
] as const;

export interface McpSmokeResult {
  exposedTools: string[];
  initialized: boolean;
  selectedWorkspace: boolean;
}

export async function smokeMcpStdio(
  binary: string,
  root: string,
  timeoutMs = 15_000,
): Promise<McpSmokeResult> {
  const process = Bun.spawn([binary, "mcp"], {
    cwd: root,
    env: {
      ...Bun.env,
      AST_MCP_PROJECT_ROOT: root,
      AST_MCP_ROOTS: root,
    },
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  const deadline = Date.now() + timeoutMs;
  const responses = new Map<number, Record<string, unknown>>();
  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const send = async (message: Record<string, unknown>) => {
    process.stdin.write(`${JSON.stringify(message)}\n`);
    await process.stdin.flush();
  };
  await send({
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "ast-mcp-check-install", version: "1" },
      protocolVersion: "2025-06-18",
    },
  });
  const readUntil = async (id: number): Promise<Record<string, unknown>> => {
    while (!responses.has(id)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("MCP smoke timed out");
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(remaining).then(() => {
          throw new Error("MCP smoke timed out");
        }),
      ]);
      if (chunk.done) throw new Error("MCP smoke ended before responding");
      buffered += decoder.decode(chunk.value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value.id === "number") responses.set(value.id, value);
      }
    }
    return responses.get(id) as Record<string, unknown>;
  };
  try {
    const initialize = await readUntil(1);
    if (!initialize.result) throw new Error("MCP initialize failed");
    await send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await send({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} });
    await send({
      id: 3,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { directory: root }, name: "workspace_open" },
    });
    const listed = await readUntil(2);
    const opened = await readUntil(3);
    const result = listed.result as
      | { tools?: Array<{ name?: unknown }> }
      | undefined;
    const exposedTools = (result?.tools ?? [])
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string")
      .sort();
    const missing = expectedIntelligenceTools.filter(
      (name) => !exposedTools.includes(name),
    );
    if (missing.length)
      throw new Error(`MCP smoke is missing tools: ${missing.join(", ")}`);
    const openedResult = opened.result as
      | {
          structuredContent?: {
            data?: {
              workspace?: {
                canonicalRootAnchor?: unknown;
                checkoutRoot?: unknown;
                workspaceId?: unknown;
              };
            };
            ok?: unknown;
          };
        }
      | undefined;
    const openedWorkspace = openedResult?.structuredContent?.data?.workspace;
    const expectedRoot = path.resolve(root);
    const selectedWorkspace =
      !opened.error &&
      openedResult?.structuredContent?.ok === true &&
      typeof openedWorkspace?.workspaceId === "string" &&
      openedWorkspace.workspaceId.startsWith("workspace:v1:") &&
      typeof openedWorkspace.checkoutRoot === "string" &&
      path.resolve(openedWorkspace.checkoutRoot) === expectedRoot &&
      typeof openedWorkspace.canonicalRootAnchor === "string" &&
      path.resolve(openedWorkspace.canonicalRootAnchor) === expectedRoot;
    if (!selectedWorkspace)
      throw new Error("MCP smoke did not select the requested workspace");
    return { exposedTools, initialized: true, selectedWorkspace };
  } finally {
    process.kill();
    await process.exited;
  }
}

async function astMcpEntry(
  entry: unknown,
  root?: string,
  home = os.homedir(),
): Promise<boolean> {
  if (typeof entry !== "string") return false;
  const normalized = entry.replaceAll("\\", "/");
  if (root) return normalized === "./node_modules/.bin/ast-mcp";
  if (
    ![
      "ast-mcp",
      "ast-mcp.bat",
      "ast-mcp.cmd",
      "ast-mcp.com",
      "ast-mcp.exe",
    ].includes(path.basename(normalized).toLowerCase())
  )
    return false;
  const directory = path.dirname(path.resolve(entry));
  const recognized = globalBinDirectories(
    "ast-mcp",
    process.platform,
    home,
  ).some((candidate) => path.resolve(candidate) === directory);
  return recognized && isExecutable(entry);
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
  root: string | undefined,
  home: string,
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
  const managed = commands
    .map((command) => ({
      command,
      entry: managedAstMcpHookEntry(command),
    }))
    .filter(
      (item): item is { command: string; entry: string } =>
        typeof item.command === "string" && typeof item.entry === "string",
    );
  if (managed.length !== 1) return false;
  const [{ command, entry }] = managed;
  return (
    command === `${JSON.stringify(entry)} hook` &&
    (await astMcpEntry(entry, root, home))
  );
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
async function stdioCommandCurrent(
  entry: McpEntry | undefined,
  root?: string,
  home = os.homedir(),
) {
  return (
    (await astMcpEntry(entry?.command, root, home)) &&
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

function entryRootCurrent(entry: McpEntry, _root: string | undefined) {
  return Object.keys(entry.env ?? {}).length === 0;
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
  home: string,
) {
  return (
    (await stdioCommandCurrent(entry, root, home)) &&
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
  home = os.homedir(),
) {
  const value = JSON.parse(await readFile(file, "utf8").catch(() => "{}"));
  const entry: McpEntry | undefined = value[section]?.["ast-mcp"];
  return transport === "http"
    ? httpJsonMcpCurrent(entry, type, url)
    : stdioJsonMcpCurrent(entry, root, type, home);
}

function codexHttpMcpCurrent(block: string, url: string | undefined) {
  return (
    block.includes("[mcp_servers.ast-mcp]") &&
    block.includes(`url = ${JSON.stringify(url)}`) &&
    !block.includes("command =")
  );
}
async function codexStdioMcpCurrent(
  block: string,
  root: string | undefined,
  home: string,
) {
  const command = block.match(/command = (".*")/);
  if (
    !block.includes("[mcp_servers.ast-mcp]") ||
    !block.includes('args = ["mcp"]') ||
    !command ||
    !(await astMcpEntry(JSON.parse(command[1]), root, home))
  )
    return false;
  return !block.includes("AST_MCP_PROJECT_ROOT") && !block.includes("env =");
}
async function codexMcpCurrent(
  file: string,
  root?: string,
  transport: Transport = "stdio",
  url?: string,
  home = os.homedir(),
) {
  const content = await readFile(file, "utf8").catch(() => "");
  if (
    content.match(/# ast-mcp:begin/g)?.length !== 1 ||
    content.match(/# ast-mcp:end/g)?.length !== 1
  )
    return false;
  const block =
    content.match(/# ast-mcp:begin\n([\s\S]*?)# ast-mcp:end/)?.[1] ?? "";
  return transport === "http"
    ? codexHttpMcpCurrent(block, url)
    : codexStdioMcpCurrent(block, root, home);
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
      home,
    ),
    hookCurrent(
      path.join(base, "hooks.json"),
      "PreToolUse",
      global ? undefined : options.root,
      home,
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
      home,
    ),
    hookCurrent(
      path.join(base, "settings.json"),
      "PreToolUse",
      global ? undefined : options.root,
      home,
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
      home,
    ),
    hookCurrent(
      path.join(base, "hooks/ast-mcp.json"),
      "preToolUse",
      global ? undefined : options.root,
      home,
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
      home,
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
  const commandEntries = [
    ...content.matchAll(
      /(?:<string>|ExecStart=")([^"<\n]*ast-mcp)(?=<\/string>|")/g,
    ),
  ].map((match) => match[1]);
  const commandCurrent =
    options.scope === "local"
      ? commandEntries.includes("./node_modules/.bin/ast-mcp")
      : (
          await Promise.all(
            commandEntries.map((entry) => astMcpEntry(entry, undefined, home)),
          )
        ).some(Boolean);
  return (
    commandCurrent &&
    content.includes("--transport") &&
    content.includes("http") &&
    content.includes(options.host) &&
    content.includes(String(options.port)) &&
    (options.scope === "global" || content.includes(path.resolve(options.root)))
  );
}
function installOperation(checks: InstallChecks) {
  if (Object.values(checks).every(Boolean)) return "none" as const;
  const managedSurfaces = Object.values(checks);
  return managedSurfaces.some(Boolean)
    ? ("update" as const)
    : ("install" as const);
}
function commandSuffix(options: CheckOptions, _global: boolean) {
  return `--scope ${options.scope} --target ${options.target}${options.transport === "http" ? ` --transport http --host ${JSON.stringify(options.host)} --port ${options.port}` : ""}${options.service ? " --service" : ""}`;
}
function installCommands(options: CheckOptions, global: boolean) {
  const suffix = commandSuffix(options, global);
  const updateCommand = global
    ? `ast-mcp update ${suffix}`
    : `./node_modules/.bin/ast-mcp update ${suffix}`;
  return {
    installCommand: global
      ? `bun add --global --trust dprint @mwillbanks/ast-mcp && ast-mcp install ${suffix}`
      : `bun add --dev @mwillbanks/ast-mcp && bun pm trust dprint && ./node_modules/.bin/ast-mcp install ${suffix}`,
    repairCommand: global
      ? `bun add --global --trust dprint @mwillbanks/ast-mcp && ${updateCommand}`
      : `bun add --dev @mwillbanks/ast-mcp && bun pm trust dprint && ${updateCommand}`,
    uninstallCommand: global
      ? `ast-mcp uninstall ${suffix}`
      : `./node_modules/.bin/ast-mcp uninstall ${suffix}`,
    updateCommand,
  };
}
export async function checkInstall(
  args = process.argv.slice(2),
  home = os.homedir(),
) {
  const options = parse(args);
  const global = options.scope === "global";
  const checks = await targetChecks(options, home, global);
  let smoke: McpSmokeResult | null = null;
  if (
    checks.mcp &&
    options.transport === "stdio" &&
    process.env.AST_MCP_CHECK_INSTALL_SKIP_SMOKE !== "1"
  ) {
    const binary =
      options.scope === "local"
        ? path.join(options.root, "node_modules/.bin/ast-mcp")
        : resolveGlobalBinaryAlias("ast-mcp", {
            globalBinDirectories: globalBinDirectories(
              "ast-mcp",
              process.platform,
              home,
            ),
            platform: process.platform,
          });
    if (binary) {
      try {
        smoke = await smokeMcpStdio(binary, options.root);
      } catch {
        checks.mcp = false;
      }
    } else checks.mcp = false;
  }
  if (options.service) checks.service = await serviceCurrent(options, home);
  const installed = Object.values(checks).every(Boolean);
  const operation = installOperation(checks);
  const commands = installCommands(options, global);
  return {
    checks,
    intelligence: {
      engine: "lancedb",
      federationDefault: false,
      generationDefault: false,
      placementDefault: "global",
      retrievalSemanticDefault: false,
    },
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
    repairCommand: commands.repairCommand,
    smoke,
    uninstallCommand: commands.uninstallCommand,
    updateCommand: commands.updateCommand,
    ...options,
  };
}
export async function runCheckInstallCli(args = process.argv.slice(2)) {
  process.stdout.write(`${JSON.stringify(await checkInstall(args))}\n`);
}
if (import.meta.main) await runCheckInstallCli();

#!/usr/bin/env bun
import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  commandForPlatform,
  directoryBinaryCandidates,
  executableNames,
  globalBinDirectories,
  isExecutable,
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

export function mcpStdioCommand(
  binary: string,
  platform: NodeJS.Platform = process.platform,
) {
  const invocation = commandForPlatform(binary, ["mcp"], platform);
  return [invocation.command, ...invocation.args];
}

async function terminateMcpProcess(
  processHandle: ReturnType<typeof Bun.spawn>,
) {
  if (processHandle.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      const taskkill = Bun.spawn(
        ["taskkill.exe", "/PID", String(processHandle.pid), "/T", "/F"],
        { stderr: "ignore", stdin: "ignore", stdout: "ignore" },
      );
      await Promise.race([taskkill.exited, Bun.sleep(500)]);
      if (taskkill.exitCode === null) taskkill.kill();
    } catch {
      processHandle.kill();
    }
  } else {
    try {
      process.kill(-processHandle.pid, "SIGTERM");
    } catch {
      processHandle.kill("SIGTERM");
    }
  }
  const stopped = await Promise.race([
    processHandle.exited.then(() => true),
    Bun.sleep(500).then(() => false),
  ]);
  if (!stopped && processHandle.exitCode === null) {
    if (process.platform !== "win32") {
      try {
        process.kill(-processHandle.pid, "SIGKILL");
      } catch {
        processHandle.kill("SIGKILL");
      }
    } else processHandle.kill("SIGKILL");
  }
  await Promise.race([processHandle.exited, Bun.sleep(500)]);
}

export async function smokeMcpStdio(
  binary: string,
  root: string,
  timeoutMs = 15_000,
): Promise<McpSmokeResult> {
  const invocation = commandForPlatform(binary, ["mcp"]);
  const process = Bun.spawn([invocation.command, ...invocation.args], {
    cwd: root,
    detached: globalThis.process.platform !== "win32",
    env: {
      ...Bun.env,
      AST_MCP_PROJECT_ROOT: root,
      AST_MCP_ROOTS: root,
    },
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  const stderrDrain = new Response(process.stderr).text().catch(() => "");
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
      sameNativePath(openedWorkspace.checkoutRoot, expectedRoot) &&
      typeof openedWorkspace.canonicalRootAnchor === "string" &&
      sameNativePath(openedWorkspace.canonicalRootAnchor, expectedRoot);
    if (!selectedWorkspace)
      throw new Error("MCP smoke did not select the requested workspace");
    return { exposedTools, initialized: true, selectedWorkspace };
  } finally {
    process.stdin.end();
    const exited = await Promise.race([
      process.exited.then(() => true),
      Bun.sleep(500).then(() => false),
    ]);
    if (!exited) {
      await terminateMcpProcess(process);
    }
    await Promise.race([stderrDrain, Bun.sleep(500)]);
  }
}

async function astMcpEntry(
  entry: unknown,
  root?: string,
  home = os.homedir(),
): Promise<boolean> {
  if (typeof entry !== "string") return false;
  const directories = root
    ? [path.join(root, "node_modules/.bin")]
    : globalBinDirectories("ast-mcp", process.platform, home);
  const expected = directoryBinaryCandidates(
    directories,
    executableNames("ast-mcp", process.platform),
  ).filter((candidate) => isExecutable(candidate, process.platform));
  const configured = root ? path.resolve(root, entry) : path.resolve(entry);
  return expected.some((candidate) => sameNativePath(configured, candidate));
}

function samePhysicalPath(left: string, right: string, filesOnly = false) {
  try {
    const configured = statSync(left, { bigint: true });
    const expected = statSync(right, { bigint: true });
    return (
      (!filesOnly || (configured.isFile() && expected.isFile())) &&
      configured.dev !== 0n &&
      configured.ino !== 0n &&
      configured.dev === expected.dev &&
      configured.ino === expected.ino
    );
  } catch {
    return false;
  }
}

function sameNativePath(left: string, right: string): boolean {
  if (process.platform === "win32") return samePhysicalPath(left, right);
  try {
    return (
      path.relative(realpathSync.native(left), realpathSync.native(right)) ===
      ""
    );
  } catch {
    return path.relative(path.resolve(left), path.resolve(right)) === "";
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
  root: string | undefined,
  home: string,
) {
  const config = Bun.JSONC.parse(
    await readFile(configFile, "utf8").catch(() => "{}"),
  );
  const hostConfig = config as Record<string, any>;
  const entries = Array.isArray(hostConfig.hooks?.[event])
    ? hostConfig.hooks[event]
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
  return (await matchingStdioBinary(entry, root, home)) !== undefined;
}

function sameCommand(left: unknown, right: string) {
  if (typeof left !== "string") return false;
  if (!path.isAbsolute(left) || !path.isAbsolute(right)) return left === right;
  return sameNativePath(left, right);
}

function batchAliasPath(commandLine: string) {
  const match =
    /^call (?:(?:"([^"\0\r\n%!^]+)")|([A-Za-z0-9_./:\\=-]+)) mcp$/u.exec(
      commandLine,
    );
  return match?.[1] ?? match?.[2];
}

export function stdioArgsMatch(
  configured: unknown[],
  expected: string[],
  platform: NodeJS.Platform = process.platform,
) {
  if (configured.length !== expected.length) return false;
  return configured.every((argument, index) => {
    if (argument === expected[index]) return true;
    if (
      platform !== "win32" ||
      index !== expected.length - 1 ||
      typeof argument !== "string"
    )
      return false;
    const actualPath = batchAliasPath(argument);
    const expectedPath = batchAliasPath(expected[index] as string);
    return (
      actualPath !== undefined &&
      expectedPath !== undefined &&
      path.win32.normalize(actualPath).toLowerCase() ===
        path.win32.normalize(expectedPath).toLowerCase()
    );
  });
}

function sameBatchAliasFile(
  configuredArgument: unknown,
  candidate: string,
  root?: string,
) {
  if (typeof configuredArgument !== "string") return false;
  const configuredAlias = batchAliasPath(configuredArgument);
  if (!configuredAlias) return false;
  return samePhysicalPath(
    root ? path.resolve(root, configuredAlias) : configuredAlias,
    candidate,
    true,
  );
}

async function matchingStdioBinary(
  entry: McpEntry | undefined,
  root?: string,
  home = os.homedir(),
) {
  if (!entry || !Array.isArray(entry.args)) return undefined;
  const directories = root
    ? [path.join(root, "node_modules/.bin")]
    : globalBinDirectories("ast-mcp", process.platform, home);
  const binaries = directoryBinaryCandidates(
    directories,
    executableNames("ast-mcp", process.platform),
  ).filter((candidate) => isExecutable(candidate, process.platform));
  for (const binary of binaries) {
    const configured = root
      ? `./${path.relative(root, binary).split(path.sep).join("/")}`
      : binary;
    const expected = commandForPlatform(configured, ["mcp"]);
    if (
      sameCommand(entry.command, expected.command) &&
      stdioArgsMatch(entry.args, expected.args) &&
      (entry.args.every(
        (argument, index) => argument === expected.args[index],
      ) ||
        sameBatchAliasFile(entry.args.at(-1), binary, root))
    )
      return binary;
  }
  return undefined;
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
  const value = Bun.JSONC.parse(await readFile(file, "utf8").catch(() => "{}"));
  const hostConfig = value as Record<string, any>;
  const entry: McpEntry | undefined = hostConfig[section]?.["ast-mcp"];
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
  const args = block.match(/^args = (\[.*\])$/m);
  if (
    !block.includes("[mcp_servers.ast-mcp]") ||
    !command ||
    !args ||
    !(await stdioCommandCurrent(
      { args: JSON.parse(args[1]), command: JSON.parse(command[1]) },
      root,
      home,
    ))
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

async function configuredStdioCommand(
  options: CheckOptions,
  home: string,
  global: boolean,
): Promise<string | undefined> {
  let entry: McpEntry | undefined;
  if (options.target === "codex") {
    const base = global
      ? path.join(home, ".codex")
      : path.join(options.root, ".codex");
    const content = await readFile(
      path.join(base, "config.toml"),
      "utf8",
    ).catch(() => "");
    const block =
      content.match(/# ast-mcp:begin\n([\s\S]*?)# ast-mcp:end/)?.[1] ?? "";
    const command = block.match(/command = (".*")/)?.[1];
    const args = block.match(/^args = (\[.*\])$/m)?.[1];
    if (command && args)
      entry = { args: JSON.parse(args), command: JSON.parse(command) };
  } else {
    const file =
      options.target === "claude"
        ? global
          ? path.join(home, ".claude.json")
          : path.join(options.root, ".mcp.json")
        : global
          ? path.join(home, ".copilot/mcp-config.json")
          : path.join(options.root, ".github/mcp.json");
    const value = Bun.JSONC.parse(
      await readFile(file, "utf8").catch(() => "{}"),
    );
    const hostConfig = value as Record<string, any>;
    entry = hostConfig.mcpServers?.["ast-mcp"];
  }
  return matchingStdioBinary(entry, global ? undefined : options.root, home);
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
  let smokeError: string | null = null;
  if (
    checks.mcp &&
    options.transport === "stdio" &&
    process.env.AST_MCP_CHECK_INSTALL_SKIP_SMOKE !== "1"
  ) {
    const binary = await configuredStdioCommand(options, home, global);
    if (binary) {
      try {
        smoke = await smokeMcpStdio(binary, options.root);
      } catch (error) {
        smokeError = error instanceof Error ? error.message : String(error);
        checks.mcp = false;
      }
    } else {
      smokeError = "No platform-compatible ast-mcp executable was found";
      checks.mcp = false;
    }
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
    smokeError,
    uninstallCommand: commands.uninstallCommand,
    updateCommand: commands.updateCommand,
    ...options,
  };
}
export async function runCheckInstallCli(args = process.argv.slice(2)) {
  process.stdout.write(`${JSON.stringify(await checkInstall(args))}\n`);
}
if (import.meta.main) await runCheckInstallCli();

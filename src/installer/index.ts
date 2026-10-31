import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  parseOutputArguments,
  selectOutputFormat,
  writeCliOutput,
  type CliOutputContext,
} from "../cli/output";
import { clearConfigCache, globalConfigPath, resolveConfig } from "../config";
import { migrateConfigSource } from "../config/migrate";
import { configWriteTarget } from "../config/transaction";
import {
  codexHome,
  codexTransport,
  installerTargetPaths,
  jsonTargetConfig,
  jsonTransport,
  parseInstallerArguments,
} from "../helpers/installer";
import { isManagedHook } from "../hooks/managed";
import {
  globalBinDirectories,
  resolveGlobalBinaryAlias,
  resolveLocalBinaryAlias,
} from "../runtime/dependencies";
import { withFencedFileLocks } from "../runtime/locks";
import { pathWithin } from "../runtime/path-utils";
import { commandForPlatform } from "../runtime/subprocess";
import {
  enableCodexElicitation,
  parseCodexConfig,
  refreshCodexMcp,
  removeCodexMcpConfiguration,
} from "./codex";
import { type InstallerLaunch, verifyMcpLaunch } from "./health";
import {
  launchFields,
  launchReceipt,
  managedToolSelection,
  parseLaunchReceipt,
  removeManagedEntry,
} from "./ownership";
import {
  createServicePlan,
  installService,
  preflightService,
  removeService,
  type ServiceExecutionOptions,
} from "./service";
import {
  mkdirInstallerDirectory as mkdir,
  readInstallerText,
  removeInstallerFile,
  withInstallerFileTransaction,
  writeInstallerFile,
} from "./transaction";
import {
  type HttpEndpoint,
  httpEndpoint,
  type McpTransport,
  resolveInstallerEndpoint,
  transports,
} from "./transport";

const packageRoot = path.resolve(
  import.meta.dir,
  import.meta.path.endsWith(".ts") ? "../.." : "..",
);
const cliEntry = path.join(
  packageRoot,
  import.meta.path.endsWith(".ts") ? "bin/ast-mcp.ts" : "dist/ast-mcp.js",
);
const installerRuntime = new AsyncLocalStorage<{
  cliEntry: string;
  platform: NodeJS.Platform;
}>();
function stableGlobalCliEntry(
  value: string | undefined,
  directories: string[],
  platform: NodeJS.Platform,
) {
  if (!value) return undefined;
  const resolved = path.resolve(value);
  const basename = path.basename(resolved).toLowerCase();
  const astMcpNames =
    platform === "win32"
      ? ["ast-mcp", "ast-mcp.cmd", "ast-mcp.exe"]
      : ["ast-mcp"];
  if (!astMcpNames.includes(basename)) return undefined;
  const candidateDirectory = path.dirname(resolved);
  const normalize = (entry: string) =>
    platform === "win32"
      ? path.resolve(entry).toLowerCase()
      : path.resolve(entry);
  if (
    !directories.some(
      (directory) => normalize(directory) === normalize(candidateDirectory),
    )
  )
    return undefined;
  return resolveGlobalBinaryAlias("ast-mcp", {
    globalBinDirectories: [candidateDirectory],
    platform,
  });
}

function configuredCliEntry(
  options: InstallOptions,
  root: string,
  home: string,
) {
  const platform = options.platform ?? process.platform;
  if (options.scope === "local") {
    const alias = resolveLocalBinaryAlias("ast-mcp", root, platform);
    if (alias) return alias;
    if (existsSync(cliEntry)) return cliEntry;
    throw new Error(
      "No local ast-mcp executable or shipped CLI was found. Build or install ast-mcp, then rerun the installer.",
    );
  }
  for (const discover of options.globalBinDirectories
    ? [false]
    : [false, true]) {
    const directories =
      options.globalBinDirectories ??
      globalBinDirectories("ast-mcp", platform, home, discover);
    const preferred = stableGlobalCliEntry(
      options.cliEntry,
      directories,
      platform,
    );
    if (preferred) return preferred;
    if (options.cliEntry && !discover && !options.globalBinDirectories)
      continue;
    const resolved = resolveGlobalBinaryAlias("ast-mcp", {
      globalBinDirectories: directories,
      platform,
    });
    if (resolved) return resolved;
  }
  throw new Error(
    "No executable global ast-mcp package-manager alias was found. Install @mwillbanks/ast-mcp globally with Bun, npm, pnpm, or Yarn, then rerun the installer.",
  );
}
function cliEntryFor(root: string | undefined, _home: string) {
  const entry = installerRuntime.getStore()?.cliEntry ?? cliEntry;
  if (!root || /\.[cm]?[jt]s$/u.test(entry)) return entry;
  const relative = path.relative(root, entry);
  if (relative && pathWithin(root, entry))
    return `./${relative.split(path.sep).join("/")}`;
  return entry;
}

function cliInvocation(entry: string, args: string[]) {
  return /\.[cm]?[jt]s$/u.test(entry)
    ? commandForPlatform(
        process.execPath,
        [entry, ...args],
        installerRuntime.getStore()?.platform,
      )
    : commandForPlatform(entry, args, installerRuntime.getStore()?.platform);
}

function displayCommandPart(value: string, platform: NodeJS.Platform) {
  if (/^[A-Za-z0-9_./:\\=-]+$/u.test(value)) return value;
  if (platform === "win32") return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function manualHttpLaunchCommand(
  cliCommand: string,
  root: string,
  endpoint: HttpEndpoint,
  platform: NodeJS.Platform,
) {
  const parts = [
    ...(/\.[cm]?[jt]s$/u.test(cliCommand)
      ? [process.execPath, cliCommand]
      : [cliCommand]),
    "mcp",
    "--transport",
    "http",
    "--host",
    endpoint.host,
    "--port",
    String(endpoint.port),
  ];
  if (
    platform === "win32" &&
    [root, ...parts].some((part) => /[%!^"]/u.test(part))
  )
    throw new Error(
      "Windows manual HTTP launch paths and arguments cannot contain CMD expansion characters or quotes",
    );
  const launch = parts
    .map((part) => displayCommandPart(part, platform))
    .join(" ");
  return `${platform === "win32" ? "cd /d" : "cd"} ${displayCommandPart(root, platform)} && ${launch}`;
}
const targets = ["codex", "claude", "copilot"] as const;
type Target = (typeof targets)[number];

async function json(file: string): Promise<Record<string, any>> {
  try {
    const value = Bun.JSONC.parse(await readInstallerText(file));
    return value as Record<string, any>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
async function save(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeInstallerFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
async function readLaunchReceipt(file: string, strict = false) {
  const info = await lstat(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  const receipt = info.isFile()
    ? await json(file)
        .then(parseLaunchReceipt)
        .catch(() => undefined)
    : undefined;
  if (!receipt && strict)
    throw new Error(
      "Existing launch receipt is not owned by ast-mcp; preserve or relocate it before refresh",
    );
  return receipt;
}
async function saveLaunchReceipt(file: string, value: unknown) {
  await readLaunchReceipt(file, true);
  await mkdir(path.dirname(file), { recursive: true });
  const previous = await lstat(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (previous && !previous.isFile())
    throw new Error("Launch receipt must be a regular file");
  await writeInstallerFile(file, JSON.stringify(value, null, 2) + "\n", {
    mode: previous ? previous.mode & 0o600 : 0o600,
  });
}
function definition(
  root: string | undefined,
  home: string,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  if (transport === "http") return { type: "http", url: endpoint?.url };
  const invocation = cliInvocation(cliEntryFor(root, home), ["mcp"]);
  return {
    args: invocation.args,
    command: invocation.command,
    ...(root ? { cwd: root } : {}),
  };
}
function retainedMcpSettings(
  value: unknown,
  ownsDefaultTools = false,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const retained = { ...value } as Record<string, unknown>;
  for (const key of launchFields) delete retained[key];
  // Copilot's installer default is launch metadata, rather than customization.
  if (
    ownsDefaultTools &&
    Array.isArray(retained.tools) &&
    retained.tools.length === 1 &&
    retained.tools[0] === "*"
  )
    delete retained.tools;
  return retained;
}

async function codexProfileFiles(home: string): Promise<string[]> {
  const base = codexHome(home);
  const content = (await optionalText(path.join(base, "config.toml"))) ?? "";
  const selected = parseCodexConfig(content).profile;
  const names = [
    ...content.matchAll(/^# ast-mcp:profile-file ([\w.-]{1,100})$/gm),
  ].map((match) => match[1]!);
  if (typeof selected === "string" && /^[\w.-]{1,100}$/.test(selected))
    names.push(selected);
  return [...new Set(names)].map((name) =>
    path.join(base, name + ".config.toml"),
  );
}

async function codexMcp(
  file: string,
  root: string | undefined,
  home: string,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  const old = await readInstallerText(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  let inherited = root
    ? await Bun.file(path.join(codexHome(home), "config.toml"))
        .text()
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw error;
        })
    : "";
  if (root && inherited) {
    const inheritedDocument = parseCodexConfig(inherited);
    const selected = inheritedDocument.profile;
    if (typeof selected === "string" && /^[\w.-]{1,100}$/.test(selected)) {
      const profileSource = await Bun.file(
        path.join(codexHome(home), `${selected}.config.toml`),
      )
        .text()
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw error;
        });
      if (profileSource) {
        const profile = parseCodexConfig(profileSource);
        if (profile.approval_policy !== undefined)
          inherited = Bun.TOML.stringify({
            ...inheritedDocument,
            approval_policy: profile.approval_policy,
          });
      }
    }
  }
  const stdio = definition(root, home, "stdio") as InstallerLaunch;
  const launch =
    transport === "http"
      ? { url: endpoint?.url }
      : {
          command: stdio.command,
          args: stdio.args,
          ...(root ? { cwd: root } : {}),
        };
  let next = refreshCodexMcp(enableCodexElicitation(old, inherited), launch);
  if (!root) {
    const selected = parseCodexConfig(old).profile;
    if (typeof selected === "string" && /^[\w.-]{1,100}$/.test(selected)) {
      const profileFile = path.join(codexHome(home), selected + ".config.toml");
      const source = await optionalText(profileFile);
      if (source !== undefined) {
        const enabled = enableCodexElicitation(source);
        if (enabled !== source) {
          await writeText(profileFile, enabled);
          const marker = "# ast-mcp:profile-file " + selected;
          if (!next.split("\n").includes(marker)) next = marker + "\n" + next;
        }
      }
    }
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeInstallerFile(file, next, { expected: old });
}
async function jsonMcp(
  file: string,
  root: string | undefined,
  home: string,
  copilot: boolean,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  const value = await json(file);
  const previous = await readLaunchReceipt(file + ".ast-mcp.json", true);
  const original = value.mcpServers?.["ast-mcp"] ?? {};
  const tools = copilot ? managedToolSelection(original, previous) : {};
  const entry = definition(root, home, transport, endpoint);
  value.mcpServers = {
    ...(value.mcpServers ?? {}),
    "ast-mcp": {
      ...retainedMcpSettings(value.mcpServers?.["ast-mcp"], copilot),
      ...(copilot
        ? transport === "stdio"
          ? {
              type: "local",
              ...entry,
              ...tools,
            }
          : { ...entry, ...tools }
        : entry),
    },
  };
  await saveLaunchReceipt(
    file + ".ast-mcp.json",
    launchReceipt(original, value.mcpServers["ast-mcp"], previous, copilot),
  );
  await save(file, value);
}
async function vscodeMcp(
  file: string,
  root: string,
  home: string,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  const value = await json(file);
  const entry = definition(root, home, transport, endpoint);
  value.servers = {
    ...(value.servers ?? {}),
    "ast-mcp": {
      ...retainedMcpSettings(value.servers?.["ast-mcp"]),
      ...(transport === "stdio" ? { type: "stdio", ...entry } : entry),
    },
  };
  await saveLaunchReceipt(
    file + ".ast-mcp.json",
    launchReceipt(
      (await json(file)).servers?.["ast-mcp"] ?? {},
      value.servers["ast-mcp"],
      await readLaunchReceipt(file + ".ast-mcp.json", true),
    ),
  );
  await save(file, value);
}

function factoryHook(
  event: "PreToolUse" | "preToolUse",
  command: string,
): Record<string, any> {
  return event === "preToolUse"
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
}
function retainUnmanagedHooks(
  prior: unknown[],
  event: "PreToolUse" | "preToolUse",
  commands: string[],
): unknown[] {
  const factory = factoryHook(event, commands[0]!);
  return prior.flatMap((item) => {
    if (!commands.some((command) => isManagedHook(item, event, command)))
      return [item];
    const group = item as Record<string, any>;
    if (event === "preToolUse")
      return commands.includes(group.command) &&
        isDeepStrictEqual({ ...group, command: commands[0] }, factory)
        ? []
        : [item];
    const { hooks, ...metadata } = group;
    const { hooks: _factoryChildren, ...factoryMetadata } = factory;
    if (!isDeepStrictEqual(metadata, factoryMetadata)) return [item];
    const retained = (hooks as unknown[]).filter(
      (child) =>
        !commands.includes(
          (child as Record<string, unknown>)?.command as string,
        ) ||
        !isDeepStrictEqual(
          { ...(child as Record<string, unknown>), command: commands[0] },
          factory.hooks[0],
        ),
    );
    return retained.length ? [{ ...group, hooks: retained }] : [];
  });
}
function refreshManagedHooks(
  prior: unknown[],
  event: "PreToolUse" | "preToolUse",
  command: string,
): unknown[] {
  const factory = factoryHook(event, command);
  let found = false;
  const refreshed = prior.map((item) => {
    if (!isManagedHook(item, event, command)) return item;
    const group = item as Record<string, any>;
    if (event === "preToolUse") {
      if (group.command === command) {
        found = true;
        return item;
      }
      if (isDeepStrictEqual({ ...group, command }, factory)) {
        found = true;
        return { ...group, command };
      }
      return item;
    }
    const current = group.hooks.some(
      (child: Record<string, unknown>) => child?.command === command,
    );
    if (current) {
      found = true;
      return item;
    }
    if (
      group.hooks.length === 1 &&
      isDeepStrictEqual(
        {
          ...group,
          hooks: [{ ...group.hooks[0], command }],
        },
        factory,
      )
    ) {
      found = true;
      return { ...group, hooks: [{ ...group.hooks[0], command }] };
    }
    return item;
  });
  let keptFactory = false;
  const unique = refreshed.filter((item) => {
    if (!isDeepStrictEqual(item, factory)) return true;
    if (keptFactory) return false;
    keptFactory = true;
    return true;
  });
  return found ? unique : [...unique, factory];
}
function hookCommand(commandPath: string): string {
  return /\.[cm]?[jt]s$/u.test(commandPath)
    ? `${JSON.stringify(process.execPath)} ${JSON.stringify(commandPath)} hook`
    : `${JSON.stringify(commandPath)} hook`;
}
async function hook(
  file: string,
  event: "PreToolUse" | "preToolUse",
  commandPath: string,
) {
  const value = await json(file);
  if (event === "preToolUse") value.version ??= 1;
  value.hooks ??= {};
  const prior = Array.isArray(value.hooks[event]) ? value.hooks[event] : [];
  const command = hookCommand(commandPath);
  value.hooks[event] = refreshManagedHooks(prior, event, command);
  await save(file, value);
}
const instructionsBegin = "<!-- ast-mcp:begin -->";
const instructionsEnd = "<!-- ast-mcp:end -->";
const instructionsPattern =
  /<!-- ast-mcp:begin -->[\s\S]*?<!-- ast-mcp:end -->\n?/g;

async function writeText(file: string, content: string) {
  const normalized = content.trimEnd();
  await mkdir(path.dirname(file), { recursive: true });
  await writeInstallerFile(file, normalized ? `${normalized}\n` : "");
}

async function instructions(file: string) {
  const block = (
    await Bun.file(path.join(packageRoot, "templates/AGENTS.md")).text()
  ).trim();
  const old = await readInstallerText(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  const clean = old.replace(instructionsPattern, "").trimEnd();
  await writeText(
    file,
    `${clean ? `${clean}\n\n` : ""}${instructionsBegin}\n\n${block}\n\n${instructionsEnd}`,
  );
}

async function optionalText(file: string) {
  return readInstallerText(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
}

async function removeInstructions(file: string) {
  const old = await optionalText(file);
  if (old === undefined) return;
  await writeText(file, old.replace(instructionsPattern, ""));
}

async function saveRemainingJson(file: string, value: Record<string, any>) {
  await save(file, value);
}

async function removeJsonMcp(file: string, section = "mcpServers") {
  const value = await json(file);
  const entries = value[section];
  if (!entries || typeof entries !== "object" || !("ast-mcp" in entries))
    return;
  const receipt = await readLaunchReceipt(file + ".ast-mcp.json");
  if (!receipt) return;
  const retained = removeManagedEntry(entries["ast-mcp"], receipt);
  if (retained) entries["ast-mcp"] = retained;
  else delete entries["ast-mcp"];
  if (Object.keys(entries).length === 0) delete value[section];
  await saveRemainingJson(file, value);
  await removeInstallerFile(file + ".ast-mcp.json");
}

async function removeCodexMcp(file: string) {
  const old = await optionalText(file);
  if (old === undefined) return;
  await writeText(file, removeCodexMcpConfiguration(old));
}

async function removeHook(
  file: string,
  event: "PreToolUse" | "preToolUse",
  cliAlias: string,
) {
  const value = await json(file);
  const hooks = value.hooks;
  if (!hooks || !Array.isArray(hooks[event])) return;
  const commands = [
    hookCommand(cliAlias),
    `bun ${JSON.stringify(cliEntry)} hook`,
    `${JSON.stringify(cliAlias)} hook`,
  ];
  hooks[event] = retainUnmanagedHooks(hooks[event], event, commands);
  if (hooks[event].length === 0) delete hooks[event];
  if (Object.keys(hooks).length === 0) delete value.hooks;
  await saveRemainingJson(file, value);
}

async function hasLocalInstallation(root: string) {
  const codex = await Bun.file(path.join(root, ".codex/config.toml"))
    .text()
    .catch(() => "");
  const claude = await json(path.join(root, ".mcp.json"));
  const copilot = await json(path.join(root, ".github/mcp.json"));
  return Boolean(
    codex.includes("# ast-mcp:begin") ||
    claude.mcpServers?.["ast-mcp"] ||
    copilot.mcpServers?.["ast-mcp"],
  );
}

export type InstallOptions = ServiceExecutionOptions<
  "serviceRunner",
  "serviceStateQuery"
> & {
  cliEntry?: string;
  verifyLaunch?: (launch: InstallerLaunch) => Promise<void>;
  deprecatedRoot?: boolean;
  globalBinDirectories?: string[];
  home?: string;
  host?: string;
  platform?: NodeJS.Platform;
  port?: number;
  root: string;
  scope: "local" | "global";
  service?: boolean;
  targets: Target[];
  transport?: McpTransport;
};

class InstallerUsageError extends Error {
  override name = "InstallerUsageError";
}

async function targetTransport(
  target: Target,
  global: boolean,
  root: string,
  home: string,
): Promise<McpTransport | undefined> {
  if (target === "codex") {
    const base = global ? codexHome(home) : path.join(root, ".codex");
    const content = await Bun.file(path.join(base, "config.toml"))
      .text()
      .catch(() => "");
    return codexTransport(content);
  }
  const file = jsonTargetConfig(target, global, root, home);
  const entry = (await json(file)).mcpServers?.["ast-mcp"] as
    | Record<string, unknown>
    | undefined;
  return jsonTransport(entry);
}

async function selectedTransport(
  options: InstallOptions,
  operation: "install" | "update",
) {
  if (options.transport) return options.transport;
  if (operation === "install") return "stdio" as const;
  const root = path.resolve(options.root);
  const home = options.home ?? os.homedir();
  const global = options.scope === "global";
  const found = new Set(
    (
      await Promise.all(
        options.targets.map((target) =>
          targetTransport(target, global, root, home),
        ),
      )
    ).filter((value): value is McpTransport => value !== undefined),
  );
  if (found.size > 1)
    throw new InstallerUsageError(
      "Selected targets use mixed transports; pass --transport stdio or --transport http",
    );
  return found.values().next().value ?? "stdio";
}

function serviceConfiguration(options: InstallOptions, endpoint: HttpEndpoint) {
  const root = path.resolve(options.root);
  const home = options.home ?? os.homedir();
  const entry = cliEntryFor(options.scope === "local" ? root : undefined, home);
  const invocation = cliInvocation(path.resolve(root, entry), []);
  const execution = options.serviceRunner
    ? { runner: options.serviceRunner, stateQuery: options.serviceStateQuery }
    : { stateQuery: options.serviceStateQuery };
  return {
    cliEntry: invocation.command,
    cliArgs: invocation.args,
    endpoint,
    home,
    platform: options.platform,
    root,
    ...execution,
    scope: options.scope,
  };
}

async function hasHttpInstallation(options: InstallOptions) {
  const root = path.resolve(options.root);
  const home = options.home ?? os.homedir();
  const global = options.scope === "global";
  return (
    await Promise.all(
      targets.map((target) => targetTransport(target, global, root, home)),
    )
  ).includes("http");
}

function targetPaths(
  target: Target,
  global: boolean,
  root: string,
  home: string,
) {
  const paths = installerTargetPaths(target, global, root, home);
  const configs =
    target === "codex"
      ? []
      : [
          jsonTargetConfig(target, global, root, home),
          ...(target === "copilot" && !global
            ? [path.join(root, ".vscode/mcp.json")]
            : []),
        ];
  return [...paths, ...configs.map((file) => file + ".ast-mcp.json")];
}

async function snapshot(paths: string[]) {
  const files = new Map<string, string>();
  const visit = async (file: string): Promise<void> => {
    const metadata = await lstat(file).catch(() => undefined);
    if (!metadata) return;
    if (metadata.isDirectory()) {
      for (const entry of await readdir(file))
        await visit(path.join(file, entry));
      return;
    }
    if (metadata.isFile())
      files.set(
        file,
        Buffer.from(await Bun.file(file).bytes()).toString("base64"),
      );
  };
  await Promise.all(paths.map(visit));
  return files;
}

function changedFiles(before: Map<string, string>, after: Map<string, string>) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

async function installTargetAssets(_base: string, instructionsPath: string) {
  await instructions(instructionsPath);
}

async function installCodexTarget(
  global: boolean,
  root: string,
  home: string,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  const base = global ? codexHome(home) : path.join(root, ".codex");
  await codexMcp(
    path.join(base, "config.toml"),
    global ? undefined : root,
    home,
    transport,
    endpoint,
  );
  await hook(
    path.join(base, "hooks.json"),
    "PreToolUse",
    cliEntryFor(global ? undefined : root, home),
  );
  await installTargetAssets(
    base,
    global ? path.join(base, "AGENTS.md") : path.join(root, "AGENTS.md"),
  );
}

async function installClaudeTarget(
  global: boolean,
  root: string,
  home: string,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  const base = global ? path.join(home, ".claude") : path.join(root, ".claude");
  await jsonMcp(
    global ? path.join(home, ".claude.json") : path.join(root, ".mcp.json"),
    global ? undefined : root,
    home,
    false,
    transport,
    endpoint,
  );
  await hook(
    path.join(base, "settings.json"),
    "PreToolUse",
    cliEntryFor(global ? undefined : root, home),
  );
  await installTargetAssets(
    base,
    global ? path.join(base, "CLAUDE.md") : path.join(root, "AGENTS.md"),
  );
}

async function installCopilotTarget(
  global: boolean,
  root: string,
  home: string,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  const base = global
    ? path.join(home, ".copilot")
    : path.join(root, ".github");
  if (global)
    await jsonMcp(
      path.join(base, "mcp-config.json"),
      undefined,
      home,
      true,
      transport,
      endpoint,
    );
  else {
    await jsonMcp(
      path.join(root, ".github/mcp.json"),
      root,
      home,
      true,
      transport,
      endpoint,
    );
    await vscodeMcp(
      path.join(root, ".vscode/mcp.json"),
      root,
      home,
      transport,
      endpoint,
    );
  }
  await hook(
    path.join(base, "hooks/ast-mcp.json"),
    "preToolUse",
    cliEntryFor(global ? undefined : root, home),
  );
  await installTargetAssets(
    base,
    global
      ? path.join(base, "copilot-instructions.md")
      : path.join(root, "AGENTS.md"),
  );
}

async function installTarget(
  target: Target,
  global: boolean,
  root: string,
  home: string,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  if (target === "codex")
    return installCodexTarget(global, root, home, transport, endpoint);
  if (target === "claude")
    return installClaudeTarget(global, root, home, transport, endpoint);
  return installCopilotTarget(global, root, home, transport, endpoint);
}

function validateTransport(transport: McpTransport) {
  if (!transports.includes(transport))
    throw new InstallerUsageError(
      `Invalid transport "${transport}"; expected stdio or http`,
    );
}

function validateTransportAddress(
  options: InstallOptions,
  transport: McpTransport,
) {
  if (
    transport === "stdio" &&
    (options.host !== undefined || options.port !== undefined)
  )
    throw new InstallerUsageError("--host and --port require --transport http");
}

function validateServiceTransport(
  options: InstallOptions,
  transport: McpTransport,
) {
  if (options.service === true && transport !== "http")
    throw new InstallerUsageError("--service requires --transport http");
}

function validateLocalServicePort(options: InstallOptions) {
  if (
    options.service === true &&
    options.scope === "local" &&
    options.port === undefined
  )
    throw new InstallerUsageError(
      "Local managed HTTP services require an explicit --port",
    );
}

function validateReconcileOptions(
  options: InstallOptions,
  transport: McpTransport,
) {
  validateTransport(transport);
  validateTransportAddress(options, transport);
  validateServiceTransport(options, transport);
  validateLocalServicePort(options);
}

function hasExplicitEndpoint(options: InstallOptions) {
  return options.host !== undefined || options.port !== undefined;
}

function installerConfigEnvironment(options: InstallOptions) {
  return options.home === undefined
    ? process.env
    : { ...process.env, APPDATA: undefined, XDG_CONFIG_HOME: undefined };
}

function installerConfigPath(
  options: InstallOptions,
  root: string,
  home: string,
) {
  return options.scope === "local"
    ? path.join(root, "ast-mcp.toml")
    : globalConfigPath({ env: installerConfigEnvironment(options), home });
}

function installerConfigSeed(local: boolean) {
  const common = [
    "version = 2",
    "",
    "[files.read]",
    'modes = ["ast", "text"]',
    "",
    "[files.patch]",
    'strategies = ["ast", "aider_block"]',
    'aider_matchers = ["exact", "whitespace", "relative-indentation", "diff-match-patch"]',
    "",
    "[formatting]",
    "enabled = false",
    'fallback = "preserve"',
    "",
    "[safety]",
    "require_hash = true",
    "",
    "[safety.hook]",
    "enabled = true",
    "allow_tools = []",
    "block_tools = []",
    "",
    "[http]",
    'host = "127.0.0.1"',
    "port = 3768",
    "session_timeout_ms = 1800000",
    "session_sweep_interval_ms = 60000",
    "",
    "[mcp.configuration]",
    "enabled = true",
    "require_approval = true",
  ];
  if (!local) return `${common.join("\n")}\n`;
  return `${[
    "version = 2",
    "",
    "[workspace]",
    'roots = ["."]',
    'worktrees = "include"',
    "",
    ...common.slice(2),
    "",
    "[[paths]]",
    'id = "workspace"',
    'path = "."',
    'policies = { read = "allow", write = "allow", delete = "deny" }',
    "follow_symlinks = false",
    'includes = ["**/*"]',
    'excludes = [".git/**"]',
  ].join("\n")}\n`;
}

async function ensureInstallerConfig(
  options: InstallOptions,
  root: string,
  home: string,
) {
  const file = installerConfigPath(options, root, home);
  await mkdir(path.dirname(file), { recursive: true });
  const { target, mode } = await configWriteTarget(file, true);
  const existing = await readInstallerText(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  clearConfigCache();
  await resolveConfig({
    cwd: options.scope === "local" ? root : home,
    env: installerConfigEnvironment(options),
    home,
  });
  if (existing === undefined) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeInstallerFile(
      target,
      installerConfigSeed(options.scope === "local"),
      {
        exclusive: true,
        mode,
        configuration: file,
      },
    );
  } else {
    let migration: ReturnType<typeof migrateConfigSource>;
    try {
      migration = migrateConfigSource(existing, file);
    } catch (error) {
      throw new Error(
        `invalid configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (migration.changed) {
      const backup = file + ".v1.bak";
      const backupInfo = await lstat(backup).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      });
      await writeInstallerFile(backup, existing, {
        mode: (backupInfo?.mode ?? mode) & 0o777,
      });
      await writeInstallerFile(target, migration.source, {
        expected: existing,
        mode: mode & 0o777,
        configuration: file,
      });
    }
  }
  clearConfigCache();
  await resolveConfig({
    cwd: options.scope === "local" ? root : home,
    env: installerConfigEnvironment(options),
    home,
  });
}

async function reconcileEndpoint(
  options: InstallOptions,
  transport: McpTransport,
  root: string,
  home: string,
) {
  if (transport !== "http") return undefined;
  const env = installerConfigEnvironment(options);
  const endpoint = await resolveInstallerEndpoint({
    env,
    home: home,
    host: options.host,
    persist: false,
    port: options.port,
    root: root,
    scope: options.scope,
  });
  if (options.service === true)
    await preflightService(serviceConfiguration(options, endpoint));
  if (hasExplicitEndpoint(options))
    await resolveInstallerEndpoint({
      env,
      home: home,
      host: options.host,
      port: options.port,
      root: root,
      scope: options.scope,
    });
  return endpoint;
}

function sourceLaunchReceiptPath(root: string, home: string) {
  const digest = new Bun.CryptoHasher("sha256")
    .update(path.resolve(root))
    .digest("hex");
  return path.join(home, ".ast-mcp/installations", `local-${digest}.json`);
}

function usesSourceLaunch(options: InstallOptions) {
  return (
    options.scope === "local" &&
    /\.[cm]?[jt]s$/u.test(installerRuntime.getStore()?.cliEntry ?? "")
  );
}

async function recordSourceLaunch(
  options: InstallOptions,
  root: string,
  home: string,
) {
  if (!usesSourceLaunch(options)) return;
  const file = sourceLaunchReceiptPath(root, home);
  await save(file, {
    ...(await json(file)),
    projectRoot: root,
    runtime: path.resolve(process.execPath),
    script: path.resolve(installerRuntime.getStore()!.cliEntry),
    version: 1,
  });
}

async function reconcilePaths(
  options: InstallOptions,
  global: boolean,
  root: string,
  home: string,
  _transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  const paths = options.targets.flatMap((target) =>
    targetPaths(target, global, root, home),
  );
  if (global && options.targets.includes("codex"))
    paths.push(...(await codexProfileFiles(home)));
  paths.push(installerConfigPath(options, root, home));
  if (usesSourceLaunch(options))
    paths.push(sourceLaunchReceiptPath(root, home));
  if (options.service !== undefined)
    paths.push(
      createServicePlan(
        serviceConfiguration(
          options,
          endpoint ?? httpEndpoint("127.0.0.1", 3768),
        ),
      ).file,
    );
  return paths;
}

async function reconcileService(
  options: InstallOptions,
  endpoint?: HttpEndpoint,
) {
  if (options.service === true && endpoint)
    await installService(serviceConfiguration(options, endpoint));
  else if (options.service === false)
    await removeService(
      serviceConfiguration(
        options,
        endpoint ?? httpEndpoint("127.0.0.1", 3768),
      ),
    );
}

async function withInstallerLocks<T>(
  options: InstallOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const root = path.resolve(options.root);
  const home = path.resolve(options.home ?? os.homedir());
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  return withFencedFileLocks(
    [
      path.join(root, ".ast-mcp-installation"),
      path.join(home, ".ast-mcp-installation"),
    ],
    () => withInstallerFileTransaction(operation).finally(clearConfigCache),
    { deadline: Date.now() + 10_000 },
  );
}

async function reconcile(
  options: InstallOptions,
  operation: "install" | "update",
) {
  const root = path.resolve(options.root);
  const home = options.home ?? os.homedir();
  const global = options.scope === "global";
  return installerRuntime.run(
    {
      cliEntry: configuredCliEntry(options, root, home),
      platform: options.platform ?? process.platform,
    },
    async () => {
      const transport = await selectedTransport(options, operation);
      validateReconcileOptions(options, transport);
      if (!global) await mkdir(root, { recursive: true });
      const launch: InstallerLaunch = {
        ...cliInvocation(cliEntryFor(global ? undefined : root, home), ["mcp"]),
        ...(!global ? { cwd: root } : {}),
      };
      await (options.verifyLaunch ?? verifyMcpLaunch)(launch);
      const paths = await reconcilePaths(
        options,
        global,
        root,
        home,
        transport,
        undefined,
      );
      for (const file of paths.filter((candidate) =>
        candidate.endsWith(".ast-mcp.json"),
      ))
        await readLaunchReceipt(file, true);
      const before = await snapshot(paths);
      if (transport === "http" && options.service === true) {
        const endpoint = await resolveInstallerEndpoint({
          env: installerConfigEnvironment(options),
          home,
          host: options.host,
          persist: false,
          port: options.port,
          root,
          scope: options.scope,
        });
        await preflightService(serviceConfiguration(options, endpoint));
      }
      await ensureInstallerConfig(options, root, home);
      await recordSourceLaunch(options, root, home);
      const endpoint = await reconcileEndpoint(options, transport, root, home);
      for (const target of options.targets)
        await installTarget(target, global, root, home, transport, endpoint);
      await reconcileService(options, endpoint);
      return changedFiles(before, await snapshot(paths));
    },
  );
}

export async function install(options: InstallOptions) {
  return withInstallerLocks(options, () => reconcile(options, "install"));
}

export async function update(options: InstallOptions) {
  return withInstallerLocks(options, () => reconcile(options, "update"));
}

async function removeTargetAssets(instructionsPath?: string) {
  if (instructionsPath) await removeInstructions(instructionsPath);
}

async function uninstallCodexTarget(
  global: boolean,
  root: string,
  home: string,
) {
  const base = global ? codexHome(home) : path.join(root, ".codex");
  if (global) {
    for (const profileFile of await codexProfileFiles(home))
      await removeCodexMcp(profileFile);
    const config = path.join(base, "config.toml");
    const old = await optionalText(config);
    if (old !== undefined)
      await writeText(
        config,
        old.replace(/^# ast-mcp:profile-file [\w.-]{1,100}\r?\n/gm, ""),
      );
  }
  await removeCodexMcp(path.join(base, "config.toml"));
  await removeHook(
    path.join(base, "hooks.json"),
    "PreToolUse",
    cliEntryFor(global ? undefined : root, home),
  );
  await removeTargetAssets(global ? path.join(base, "AGENTS.md") : undefined);
}

async function uninstallClaudeTarget(
  global: boolean,
  root: string,
  home: string,
) {
  const base = global ? path.join(home, ".claude") : path.join(root, ".claude");
  await removeJsonMcp(
    global ? path.join(home, ".claude.json") : path.join(root, ".mcp.json"),
  );
  await removeHook(
    path.join(base, "settings.json"),
    "PreToolUse",
    cliEntryFor(global ? undefined : root, home),
  );
  await removeTargetAssets(global ? path.join(base, "CLAUDE.md") : undefined);
}

async function uninstallCopilotTarget(
  global: boolean,
  root: string,
  home: string,
) {
  const base = global
    ? path.join(home, ".copilot")
    : path.join(root, ".github");
  if (global)
    await removeJsonMcp(path.join(base, "mcp-config.json"), "mcpServers");
  else {
    await removeJsonMcp(path.join(root, ".github/mcp.json"), "mcpServers");
    await removeJsonMcp(path.join(root, ".vscode/mcp.json"), "servers");
  }
  await removeHook(
    path.join(base, "hooks/ast-mcp.json"),
    "preToolUse",
    cliEntryFor(global ? undefined : root, home),
  );
  await removeTargetAssets(
    global ? path.join(base, "copilot-instructions.md") : undefined,
  );
}

async function uninstallTarget(
  target: Target,
  global: boolean,
  root: string,
  home: string,
) {
  if (target === "codex") return uninstallCodexTarget(global, root, home);
  if (target === "claude") return uninstallClaudeTarget(global, root, home);
  return uninstallCopilotTarget(global, root, home);
}

async function removeUnusedService(options: InstallOptions, root: string) {
  if (options.scope === "local" && !(await hasLocalInstallation(root)))
    await removeInstructions(path.join(root, "AGENTS.md"));
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return;
  if (await hasHttpInstallation(options)) return;
  const service = serviceConfiguration(
    options,
    httpEndpoint("127.0.0.1", 3768),
  );
  const plan = createServicePlan(service);
  if (await lstat(plan.file).catch(() => undefined))
    await removeService(service);
}

export async function uninstall(options: InstallOptions) {
  return withInstallerLocks(options, () => uninstallLocked(options));
}

async function uninstallLocked(options: InstallOptions) {
  const root = path.resolve(options.root);
  const home = options.home ?? os.homedir();
  return installerRuntime.run(
    {
      cliEntry: configuredCliEntry(options, root, home),
      platform: options.platform ?? process.platform,
    },
    async () => {
      const global = options.scope === "global";
      const paths = options.targets.flatMap((target) =>
        targetPaths(target, global, root, home),
      );
      if (global && options.targets.includes("codex"))
        paths.push(...(await codexProfileFiles(home)));
      const before = await snapshot(paths);
      for (const target of options.targets)
        await uninstallTarget(target, global, root, home);
      await removeUnusedService(options, root);
      return changedFiles(before, await snapshot(paths));
    },
  );
}

export async function runInstallerCli(
  args = process.argv.slice(2),
  context: CliOutputContext = {},
): Promise<void> {
  const parsed = parseOutputArguments(args);
  const { operation, options: parsedOptions } = parseInstallerArguments(
    parsed.args,
    process.cwd(),
  );
  const options: InstallOptions = parsedOptions;
  if (options.deprecatedRoot)
    process.stderr.write(
      "ast-mcp: --root is deprecated; run this command from the project root.\n",
    );
  const root = path.resolve(options.root);
  const global = options.scope === "global";
  const manualHttp =
    operation !== "uninstall" &&
    options.service !== true &&
    (await selectedTransport(options, operation)) === "http";
  if (
    (options.platform ?? process.platform) === "win32" &&
    manualHttp &&
    [
      root,
      configuredCliEntry(options, root, options.home ?? os.homedir()),
    ].some((part) => /[%!^"]/u.test(part))
  )
    throw new Error(
      "Windows manual HTTP launch project path cannot contain CMD expansion characters or quotes",
    );
  const outputFormat =
    parsed.output ??
    selectOutputFormat(
      await resolveConfig({ cwd: root }),
      undefined,
      context.isTTY,
    );
  const operationHandlers = { install, uninstall, update };
  const changed = await operationHandlers[operation](options);
  const effectiveTransport =
    operation === "uninstall"
      ? (options.transport ?? "stdio")
      : ((await targetTransport(
          options.targets[0],
          global,
          root,
          os.homedir(),
        )) ??
        options.transport ??
        "stdio");
  const endpoint =
    effectiveTransport === "http"
      ? await resolveInstallerEndpoint({
          home: os.homedir(),
          host: options.host,
          port: options.port,
          root,
          scope: options.scope,
        })
      : undefined;
  const servicePlan =
    options.service === true && endpoint
      ? createServicePlan(serviceConfiguration(options, endpoint))
      : undefined;
  const manualStart =
    endpoint && options.service !== true && operation !== "uninstall"
      ? installerRuntime.run(
          {
            cliEntry: configuredCliEntry(
              options,
              root,
              options.home ?? os.homedir(),
            ),
            platform: options.platform ?? process.platform,
          },
          () =>
            manualHttpLaunchCommand(
              configuredCliEntry(options, root, options.home ?? os.homedir()),
              root,
              endpoint,
              options.platform ?? process.platform,
            ),
        )
      : undefined;
  const result = {
    changed,
    endpoint: endpoint?.url,
    manualStart,
    operation,
    service: servicePlan
      ? { id: servicePlan.id, managed: true }
      : { managed: false },
    transport: effectiveTransport,
  };
  writeCliOutput(
    result,
    outputFormat,
    `Installation ${operation}`,
    context.write,
  );
}
if (import.meta.main) await runInstallerCli();

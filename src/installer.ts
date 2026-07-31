import { AsyncLocalStorage } from "node:async_hooks";
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
import { clearConfigCache, globalConfigPath, resolveConfig } from "./config";
import { migrateConfigSource, writeMigratedConfig } from "./config-migrate";
import {
  codexTransport,
  installerTargetPaths,
  jsonTargetConfig,
  jsonTransport,
  parseInstallerArguments,
} from "./helpers/installer";
import {
  type HttpEndpoint,
  httpEndpoint,
  type McpTransport,
  resolveInstallerEndpoint,
  transports,
} from "./installer-transport";
import { isManagedHook } from "./managed-hook";
import { AST_BRO_BINARY, assertAstBroAvailable } from "./runtime/dependencies";
import {
  createServicePlan,
  installService,
  preflightService,
  removeService,
  type ServiceCommandRunner,
} from "./service";

const packageRoot = path.resolve(import.meta.dir, "..");
const cliEntry = path.join(packageRoot, "dist/ast-mcp.js");
const installerRuntime = new AsyncLocalStorage<{ cliEntry: string }>();
function configuredCliEntry(
  options: InstallOptions,
  root: string,
  home: string,
) {
  return options.cliEntry
    ? path.resolve(options.cliEntry)
    : options.scope === "local"
      ? path.join(root, "node_modules/.bin/ast-mcp")
      : path.join(home, ".bun/bin/ast-mcp");
}
function cliEntryFor(root: string | undefined, _home: string) {
  const entry = installerRuntime.getStore()?.cliEntry ?? cliEntry;
  if (!root) return entry;
  const relative = path.relative(root, entry);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative))
    return `./${relative.split(path.sep).join("/")}`;
  return entry;
}
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
async function installerAstBroBinary(options: InstallOptions) {
  const root = path.resolve(options.root);
  const config = await resolveConfig({
    cwd: root,
    env: installerConfigEnvironment(options),
    home: options.home,
  });
  return (
    options.astBroBinary ?? config.dependencies.astBroBinary ?? AST_BRO_BINARY
  );
}

function definition(
  root: string | undefined,
  home: string,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  if (transport === "http") return { type: "http", url: endpoint?.url };
  return { args: ["mcp"], command: cliEntryFor(root, home) };
}
async function codexMcp(
  file: string,
  root: string | undefined,
  home: string,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  const old = await readFile(file, "utf8").catch(() => "");
  const clean = old
    .replace(/# ast-mcp:begin[\s\S]*?# ast-mcp:end\n?/g, "")
    .trimEnd();
  const block =
    transport === "http"
      ? `# ast-mcp:begin\n[mcp_servers.ast-mcp]\nurl = ${JSON.stringify(endpoint?.url)}\n# ast-mcp:end`
      : `# ast-mcp:begin\n[mcp_servers.ast-mcp]\ncommand = ${JSON.stringify(cliEntryFor(root, home))}\nargs = ["mcp"]\n# ast-mcp:end`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${clean ? `${clean}\n\n` : ""}${block}\n`);
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
  const entry = definition(root, home, transport, endpoint);
  value.mcpServers = {
    ...(value.mcpServers ?? {}),
    "ast-mcp": copilot
      ? transport === "stdio"
        ? { type: "local", ...entry, tools: ["*"] }
        : { ...entry, tools: ["*"] }
      : entry,
  };
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
    "ast-mcp": transport === "stdio" ? { type: "stdio", ...entry } : entry,
  };
  await save(file, value);
}

async function hook(
  file: string,
  event: "PreToolUse" | "preToolUse",
  scriptFile: string,
  commandPath: string,
) {
  await rm(scriptFile, { force: true });
  const value = await json(file);
  if (event === "preToolUse") value.version ??= 1;
  value.hooks ??= {};
  const prior = Array.isArray(value.hooks[event]) ? value.hooks[event] : [];
  const command = `${JSON.stringify(commandPath)} hook`;
  const managedCommands = [command, `bun ${JSON.stringify(cliEntry)} hook`];
  const kept = prior.filter(
    (item: unknown) =>
      !managedCommands.some((managed) => isManagedHook(item, event, managed)),
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

async function optionalText(file: string) {
  return readFile(file, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
}

async function removeInstructions(file: string) {
  const old = await optionalText(file);
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
  const old = await optionalText(file);
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
  cliAlias: string,
) {
  const value = await json(file);
  const hooks = value.hooks;
  if (!hooks || !Array.isArray(hooks[event])) return;
  const commands = [
    `bun ${JSON.stringify(commandPath)}`,
    `bun ${JSON.stringify(cliEntry)} hook`,
    `${JSON.stringify(cliAlias)} hook`,
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
  cliEntry?: string;
  deprecatedRoot?: boolean;
  home?: string;
  host?: string;
  platform?: NodeJS.Platform;
  port?: number;
  root: string;
  scope: "local" | "global";
  service?: boolean;
  serviceRunner?: ServiceCommandRunner;
  targets: Target[];
  transport?: McpTransport;
}

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
    const base = global ? path.join(home, ".codex") : path.join(root, ".codex");
    const content = await readFile(
      path.join(base, "config.toml"),
      "utf8",
    ).catch(() => "");
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
  return {
    cliEntry: cliEntryFor(options.scope === "local" ? root : undefined, home),
    endpoint,
    home,
    platform: options.platform,
    root,
    runner: options.serviceRunner,
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
  return installerTargetPaths(target, global, root, home);
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

async function installTargetAssets(base: string, instructionsPath: string) {
  await skills(path.join(base, "skills"));
  await instructions(instructionsPath);
}

async function installCodexTarget(
  global: boolean,
  root: string,
  home: string,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  const base = global ? path.join(home, ".codex") : path.join(root, ".codex");
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
    path.join(base, "hooks/ast-mcp.ts"),
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
    path.join(base, "hooks/ast-mcp.ts"),
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
    path.join(base, "hooks/ast-mcp.ts"),
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
    "enabled = true",
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
  ];
  if (!local) return `${common.join("\n")}\n`;
  return `${[
    "version = 2",
    "",
    "[workspace]",
    'roots = ["."]',
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
  const existing = await readFile(file, "utf8").catch((error) => {
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
    await writeFile(file, installerConfigSeed(options.scope === "local"), {
      flag: "wx",
    });
  } else {
    try {
      const migration = migrateConfigSource(existing, file);
      if (migration.changed) await writeMigratedConfig(file, migration.source);
    } catch (error) {
      throw new Error(
        `invalid configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
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

function reconcilePaths(
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
  paths.push(installerConfigPath(options, root, home));
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

async function reconcile(
  options: InstallOptions,
  operation: "install" | "update",
) {
  const root = path.resolve(options.root);
  const home = options.home ?? os.homedir();
  const global = options.scope === "global";
  return installerRuntime.run(
    { cliEntry: configuredCliEntry(options, root, home) },
    async () => {
      const transport = await selectedTransport(options, operation);
      validateReconcileOptions(options, transport);
      const paths = reconcilePaths(
        options,
        global,
        root,
        home,
        transport,
        undefined,
      );
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
      assertAstBroAvailable(await installerAstBroBinary(options));
      const endpoint = await reconcileEndpoint(options, transport, root, home);
      for (const target of options.targets)
        await installTarget(target, global, root, home, transport, endpoint);
      await reconcileService(options, endpoint);
      return changedFiles(before, await snapshot(paths));
    },
  );
}

export async function install(options: InstallOptions) {
  return reconcile(options, "install");
}

export async function update(options: InstallOptions) {
  return reconcile(options, "update");
}

async function removeTargetAssets(base: string, instructionsPath?: string) {
  await rm(path.join(base, "hooks/ast-mcp.ts"), { force: true });
  await rm(path.join(base, "skills/ast-mcp"), { force: true, recursive: true });
  if (instructionsPath) await removeInstructions(instructionsPath);
}

async function uninstallCodexTarget(
  global: boolean,
  root: string,
  home: string,
) {
  const base = global ? path.join(home, ".codex") : path.join(root, ".codex");
  await removeCodexMcp(path.join(base, "config.toml"));
  await removeHook(
    path.join(base, "hooks.json"),
    "PreToolUse",
    global ? path.join(base, "hooks/ast-mcp.ts") : ".codex/hooks/ast-mcp.ts",
    cliEntryFor(global ? undefined : root, home),
  );
  await removeTargetAssets(
    base,
    global ? path.join(base, "AGENTS.md") : undefined,
  );
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
    global
      ? path.join(base, "hooks/ast-mcp.ts")
      : `\${CLAUDE_PROJECT_DIR}/.claude/hooks/ast-mcp.ts`,
    cliEntryFor(global ? undefined : root, home),
  );
  await removeTargetAssets(
    base,
    global ? path.join(base, "CLAUDE.md") : undefined,
  );
}

async function uninstallCopilotTarget(
  global: boolean,
  root: string,
  home: string,
) {
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
    global ? path.join(base, "hooks/ast-mcp.ts") : ".github/hooks/ast-mcp.ts",
    cliEntryFor(global ? undefined : root, home),
  );
  await removeTargetAssets(
    base,
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
  const root = path.resolve(options.root);
  const home = options.home ?? os.homedir();
  return installerRuntime.run(
    { cliEntry: configuredCliEntry(options, root, home) },
    async () => {
      const global = options.scope === "global";
      const paths = options.targets.flatMap((target) =>
        targetPaths(target, global, root, home),
      );
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
): Promise<void> {
  const { operation, options: parsedOptions } = parseInstallerArguments(
    args,
    process.cwd(),
  );
  const options: InstallOptions = {
    ...parsedOptions,
    cliEntry: process.argv[1],
  };
  if (options.deprecatedRoot)
    process.stderr.write(
      "ast-mcp: --root is deprecated; run this command from the project root.\n",
    );
  const operationHandlers = { install, uninstall, update };
  const changed = await operationHandlers[operation](options);
  const root = path.resolve(options.root);
  const global = options.scope === "global";
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
    endpoint && options.service !== true
      ? installerRuntime.run(
          {
            cliEntry: configuredCliEntry(
              options,
              root,
              options.home ?? os.homedir(),
            ),
          },
          () =>
            `${global ? "" : `cd ${JSON.stringify(root)} && `}${JSON.stringify(cliEntryFor(global ? undefined : root, options.home ?? os.homedir()))} mcp --transport http --host ${JSON.stringify(endpoint.host)} --port ${endpoint.port}`,
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
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (import.meta.main) await runInstallerCli();

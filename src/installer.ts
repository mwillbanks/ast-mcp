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
import { globalConfigPath, resolveConfig } from "./config";
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
  const env =
    options.scope === "local"
      ? { ...process.env, AST_MCP_PROJECT_ROOT: root }
      : process.env;
  const config = await resolveConfig({
    cwd: root,
    env,
    home: options.home,
  });
  return (
    options.astBroBinary ?? config.dependencies.astBroBinary ?? AST_BRO_BINARY
  );
}

function definition(
  root: string | undefined,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  if (transport === "http") return { type: "http", url: endpoint?.url };
  return {
    args: [cliEntry, "mcp"],
    command: "bun",
    env: root ? { AST_MCP_PROJECT_ROOT: root } : {},
  };
}
async function codexMcp(
  file: string,
  root: string | undefined,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  const old = await readFile(file, "utf8").catch(() => "");
  const clean = old
    .replace(/# ast-mcp:begin[\s\S]*?# ast-mcp:end\n?/g, "")
    .trimEnd();
  const environment = root
    ? `env = { AST_MCP_PROJECT_ROOT = ${JSON.stringify(root)} }\n`
    : "";
  const block =
    transport === "http"
      ? `# ast-mcp:begin\n[mcp_servers.ast-mcp]\nurl = ${JSON.stringify(endpoint?.url)}\n# ast-mcp:end`
      : `# ast-mcp:begin\n[mcp_servers.ast-mcp]\ncommand = "bun"\nargs = [${JSON.stringify(cliEntry)}, "mcp"]\n${environment}# ast-mcp:end`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${clean ? `${clean}\n\n` : ""}${block}\n`);
}
async function jsonMcp(
  file: string,
  root: string | undefined,
  copilot: boolean,
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  const value = await json(file);
  const entry = definition(root, transport, endpoint);
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
  transport: McpTransport,
  endpoint?: HttpEndpoint,
) {
  const value = await json(file);
  const entry = definition(root, transport, endpoint);
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
    const block = content.match(
      /# ast-mcp:begin\n([\s\S]*?)# ast-mcp:end/,
    )?.[1];
    if (!block) return undefined;
    return /^\s*url\s*=/m.test(block) ? "http" : "stdio";
  }
  const file =
    target === "claude"
      ? global
        ? path.join(home, ".claude.json")
        : path.join(root, ".mcp.json")
      : global
        ? path.join(home, ".copilot/mcp-config.json")
        : path.join(root, ".github/mcp.json");
  const entry = (await json(file)).mcpServers?.["ast-mcp"];
  if (!entry) return undefined;
  return typeof entry.url === "string" ? "http" : "stdio";
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
  return {
    cliEntry,
    endpoint,
    home: options.home ?? os.homedir(),
    platform: options.platform,
    root: path.resolve(options.root),
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

async function reconcile(
  options: InstallOptions,
  operation: "install" | "update",
) {
  assertAstBroAvailable(await installerAstBroBinary(options));
  const root = path.resolve(options.root);
  const home = options.home ?? os.homedir();
  const global = options.scope === "global";
  const transport = await selectedTransport(options, operation);
  if (!transports.includes(transport))
    throw new InstallerUsageError(
      `Invalid transport "${transport}"; expected stdio or http`,
    );
  if (
    transport === "stdio" &&
    (options.host !== undefined || options.port !== undefined)
  )
    throw new InstallerUsageError("--host and --port require --transport http");
  if (options.service === true && transport !== "http")
    throw new InstallerUsageError("--service requires --transport http");
  if (
    options.service === true &&
    options.scope === "local" &&
    options.port === undefined
  )
    throw new InstallerUsageError(
      "Local managed HTTP services require an explicit --port",
    );
  const endpoint =
    transport === "http"
      ? await resolveInstallerEndpoint({
          home,
          host: options.host,
          persist: false,
          port: options.port,
          root,
          scope: options.scope,
        })
      : undefined;
  if (options.service === true && endpoint)
    await preflightService(serviceConfiguration(options, endpoint));
  if (
    transport === "http" &&
    (options.host !== undefined || options.port !== undefined)
  )
    await resolveInstallerEndpoint({
      home,
      host: options.host,
      port: options.port,
      root,
      scope: options.scope,
    });
  const paths = options.targets.flatMap((target) =>
    targetPaths(target, global, root, home),
  );
  if (
    transport === "http" &&
    (options.host !== undefined || options.port !== undefined)
  )
    paths.push(
      options.scope === "local"
        ? path.join(root, "ast-mcp.toml")
        : globalConfigPath({ home }),
    );
  if (options.service !== undefined)
    paths.push(
      createServicePlan(
        serviceConfiguration(
          options,
          endpoint ?? httpEndpoint("127.0.0.1", 3768),
        ),
      ).file,
    );
  const before = await snapshot(paths);
  for (const target of options.targets) {
    if (target === "codex") {
      const base = global
        ? path.join(home, ".codex")
        : path.join(root, ".codex");
      await codexMcp(
        path.join(base, "config.toml"),
        global ? undefined : root,
        transport,
        endpoint,
      );
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
        false,
        transport,
        endpoint,
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
        await jsonMcp(
          path.join(base, "mcp-config.json"),
          undefined,
          true,
          transport,
          endpoint,
        );
      else {
        await jsonMcp(
          path.join(root, ".github/mcp.json"),
          root,
          true,
          transport,
          endpoint,
        );
        await vscodeMcp(
          path.join(root, ".vscode/mcp.json"),
          root,
          transport,
          endpoint,
        );
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
  if (options.service === true && endpoint)
    await installService(serviceConfiguration(options, endpoint));
  else if (options.service === false)
    await removeService(
      serviceConfiguration(
        options,
        endpoint ?? httpEndpoint("127.0.0.1", 3768),
      ),
    );
  return changedFiles(before, await snapshot(paths));
}

export async function install(options: InstallOptions) {
  return reconcile(options, "install");
}

export async function update(options: InstallOptions) {
  return reconcile(options, "update");
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
  const platform = options.platform ?? process.platform;
  if (
    (platform === "darwin" || platform === "linux") &&
    !(await hasHttpInstallation(options))
  ) {
    const service = serviceConfiguration(
      options,
      httpEndpoint("127.0.0.1", 3768),
    );
    const plan = createServicePlan(service);
    if (await lstat(plan.file).catch(() => undefined))
      await removeService(service);
  }
  return changedFiles(before, await snapshot(paths));
}

export async function runInstallerCli(
  args = process.argv.slice(2),
): Promise<void> {
  const tokens = args.flatMap((token) => {
    const match = /^(--(?:scope|root|target|transport|host|port))=(.*)$/.exec(
      token,
    );
    return match ? [match[1], match[2]] : [token];
  });
  type Operation = "install" | "update" | "uninstall";
  let operation: Operation = "install";
  if (["install", "update", "uninstall"].includes(tokens[0] ?? ""))
    operation = tokens.shift() as Operation;
  let scope: "local" | "global" = "local";
  let root = process.cwd();
  let selected: Target[] = [...targets];
  let transport: McpTransport | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let service: boolean | undefined;
  const valueAfter = (index: number) => {
    const value = tokens[index + 1];
    if (!value || value.startsWith("-"))
      throw new InstallerUsageError(
        `Missing value for ${tokens[index] ?? "option"}`,
      );
    return value;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (["--scope", "-s"].includes(token ?? "")) {
      scope = valueAfter(index) as "local" | "global";
      index += 1;
    } else if (["--root", "-r"].includes(token ?? "")) {
      root = valueAfter(index);
      index += 1;
    } else if (["--target", "-t"].includes(token ?? "")) {
      const value = valueAfter(index);
      selected = value === "all" ? [...targets] : [value as Target];
      index += 1;
    } else if (token === "--transport") {
      transport = valueAfter(index) as McpTransport;
      index += 1;
    } else if (token === "--host") {
      host = valueAfter(index);
      index += 1;
    } else if (token === "--port") {
      const value = valueAfter(index);
      if (!/^\d+$/.test(value))
        throw new InstallerUsageError(
          `Invalid HTTP port "${value}"; expected an integer from 1 through 65535`,
        );
      port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new InstallerUsageError(
          `Invalid HTTP port "${value}"; expected an integer from 1 through 65535`,
        );
      index += 1;
    } else if (token === "--service" || token === "--no-service") {
      const next = token === "--service";
      if (service !== undefined && service !== next)
        throw new InstallerUsageError(
          "--service and --no-service cannot be used together",
        );
      service = next;
    } else throw new InstallerUsageError(`Unknown option: ${token}`);
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
  if (transport && !transports.includes(transport))
    throw new InstallerUsageError(
      `Invalid transport "${transport}"; expected stdio or http`,
    );
  const options: InstallOptions = {
    host,
    port,
    root,
    scope,
    service,
    targets: selected,
    transport,
  };
  const changed =
    operation === "install"
      ? await install(options)
      : operation === "update"
        ? await update(options)
        : await uninstall(options);
  const effectiveTransport =
    operation === "uninstall"
      ? (transport ?? "stdio")
      : ((await targetTransport(
          selected[0],
          scope === "global",
          path.resolve(root),
          os.homedir(),
        )) ??
        transport ??
        "stdio");
  const endpoint =
    effectiveTransport === "http"
      ? await resolveInstallerEndpoint({
          home: os.homedir(),
          host,
          port,
          root: path.resolve(root),
          scope,
        })
      : undefined;
  const servicePlan =
    service === true && endpoint
      ? createServicePlan(serviceConfiguration(options, endpoint))
      : undefined;
  const manualStart =
    endpoint && service !== true
      ? `${scope === "local" ? `cd ${JSON.stringify(path.resolve(root))} && ` : ""}bun ${JSON.stringify(cliEntry)} mcp --transport http --host ${JSON.stringify(endpoint.host)} --port ${endpoint.port}`
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

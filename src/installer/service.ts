import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import {
  readSubprocessOutput,
  terminateProcessTree,
} from "../runtime/subprocess";
import {
  mkdirInstallerDirectory as mkdir,
  readInstallerText,
  onInstallerRollback,
  removeInstallerFile,
  withInstallerFileTransaction,
  writeInstallerFile,
} from "./transaction";
import type { HttpEndpoint } from "./transport";

export type ServiceScope = "local" | "global";
export type ServiceCommandRunner = (
  command: string[],
  ignoreFailure?: boolean,
) => Promise<void>;

export interface ServiceOptions {
  cliEntry: string;
  cliArgs?: string[];
  endpoint: HttpEndpoint;
  home: string;
  platform?: NodeJS.Platform;
  root: string;
  runner?: ServiceCommandRunner;
  scope: ServiceScope;
}

export interface ServicePlan {
  content: string;
  file: string;
  id: string;
  installCommands: string[][];
  removeCommands: string[][];
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemd(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function serviceIdentity(scope: ServiceScope, root: string) {
  if (scope === "global") return "ast-mcp";
  const digest = createHash("sha256")
    .update(path.resolve(root))
    .digest("hex")
    .slice(0, 12);
  return `ast-mcp-${digest}`;
}

export function createServicePlan(options: ServiceOptions): ServicePlan {
  const platform = options.platform ?? process.platform;
  if (platform === "win32")
    throw new Error(
      "Managed ast-mcp services are not supported on Windows; start `ast-mcp mcp --transport http` manually",
    );
  if (platform !== "darwin" && platform !== "linux")
    throw new Error(
      `Managed ast-mcp services are not supported on ${platform}; start the HTTP transport manually`,
    );
  const id = serviceIdentity(options.scope, options.root);
  const args = [
    options.cliEntry,
    ...(options.cliArgs ?? []),
    "mcp",
    "--transport",
    "http",
    "--host",
    options.endpoint.host,
    "--port",
    String(options.endpoint.port),
  ];
  const environment =
    options.scope === "local"
      ? { AST_MCP_PROJECT_ROOT: path.resolve(options.root) }
      : {};
  if (platform === "darwin") {
    const label = `com.mwillbanks.${id}`;
    const file = path.join(
      options.home,
      "Library/LaunchAgents",
      `${label}.plist`,
    );
    const state = path.join(options.home, ".local/state/ast-mcp");
    const programArguments = args
      .map((value) => `      <string>${xml(value)}</string>`)
      .join("\n");
    const environmentVariables = Object.entries(environment)
      .map(
        ([name, value]) =>
          `      <key>${xml(name)}</key>\n      <string>${xml(value)}</string>`,
      )
      .join("\n");
    const environmentBlock = environmentVariables
      ? `\n    <key>EnvironmentVariables</key>\n    <dict>\n${environmentVariables}\n    </dict>`
      : "";
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${label}</string>\n  <key>ProgramArguments</key>\n  <array>\n${programArguments}\n  </array>${environmentBlock}\n  <key>WorkingDirectory</key>\n  <string>${xml(options.scope === "local" ? path.resolve(options.root) : options.home)}</string>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n  <key>StandardOutPath</key>\n  <string>${xml(path.join(state, `${id}.out.log`))}</string>\n  <key>StandardErrorPath</key>\n  <string>${xml(path.join(state, `${id}.err.log`))}</string>\n</dict>\n</plist>\n`;
    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 501}`;
    return {
      content,
      file,
      id,
      installCommands: [
        ["launchctl", "bootout", domain, file],
        ["launchctl", "bootstrap", domain, file],
        ["launchctl", "kickstart", "-k", `${domain}/${label}`],
      ],
      removeCommands: [["launchctl", "bootout", `${domain}/${label}`]],
    };
  }
  const file = path.join(options.home, ".config/systemd/user", `${id}.service`);
  const environmentLines = Object.entries(environment)
    .map(([name, value]) => `Environment="${name}=${systemd(value)}"`)
    .join("\n");
  const command = args.map((value) => `"${systemd(value)}"`).join(" ");
  const workingDirectory = systemd(
    options.scope === "local" ? path.resolve(options.root) : options.home,
  );
  const content = `[Unit]\nDescription=ast-mcp Streamable HTTP (${id})\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory="${workingDirectory}"\n${environmentLines ? `${environmentLines}\n` : ""}ExecStart=${command}\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
  return {
    content,
    file,
    id,
    installCommands: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", `${id}.service`],
    ],
    removeCommands: [
      ["systemctl", "--user", "disable", "--now", `${id}.service`],
    ],
  };
}

async function assertPortAvailable(endpoint: HttpEndpoint) {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint.port, endpoint.host, resolve);
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "EADDRINUSE"
        ? `Cannot install the managed service because ${endpoint.host}:${endpoint.port} is already in use`
        : `Cannot bind managed service endpoint ${endpoint.host}:${endpoint.port}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function runServiceCommand(
  command: string[],
  ignoreFailure = false,
  timeoutMs = 10_000,
): Promise<void> {
  const child = Bun.spawn(command, {
    detached: process.platform !== "win32",
    stderr: "pipe",
    stdin: "ignore",
    stdout: "ignore",
  });
  const controller = new AbortController();
  const deadline = setTimeout(
    () =>
      controller.abort(
        new Error(
          `Service command interrupted (${command.join(" ")}): deadline expired`,
        ),
      ),
    timeoutMs,
  );
  const interrupted = Promise.withResolvers<never>();
  const onAbort = () => interrupted.reject(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const [exitCode, stderr] = await Promise.all([
      Promise.race([child.exited, interrupted.promise]),
      readSubprocessOutput(child.stderr, controller.signal, () =>
        terminateProcessTree(child, { force: true }),
      ),
    ]);
    if (child.signalCode)
      throw new Error(
        `Service command interrupted (${command.join(" ")}): ${child.signalCode}`,
      );
    if (exitCode !== 0 && !ignoreFailure)
      throw new Error(
        `Service command failed (${command.join(" ")}): ${stderr.trim() || `exit ${exitCode}`}`,
      );
  } catch (error) {
    await terminateProcessTree(child, { force: true });
    throw error;
  } finally {
    clearTimeout(deadline);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
const defaultRunner = runServiceCommand;

export async function waitForService(url: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 25 && Date.now() < deadline; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(500, deadline - Date.now())),
        ),
      });
      await response.body?.cancel();
      if (response.status < 500) return;
    } catch {
      // The service may still be starting.
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await Bun.sleep(Math.min(100, remaining));
  }
  throw new Error(`Managed ast-mcp service did not become ready at ${url}`);
}

export async function preflightService(options: ServiceOptions) {
  const plan = createServicePlan(options);
  if (!(await lstat(plan.file).catch(() => undefined)))
    await assertPortAvailable(options.endpoint);
  return plan;
}

export async function installService(options: ServiceOptions) {
  return withInstallerFileTransaction(() => installServiceFiles(options));
}

async function compensateService(
  options: ServiceOptions,
  plan: ServicePlan,
  existed: boolean,
) {
  // The journal validates restored or untouched bytes before any compensating command.
  await readInstallerText(plan.file).catch((error) => {
    if (!existed && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  });
  const runner = options.runner ?? defaultRunner;
  for (const command of plan.removeCommands) await runner(command, true);
  if (existed) {
    for (let index = 0; index < plan.installCommands.length; index += 1)
      await runner(
        plan.installCommands[index],
        index === 0 && plan.installCommands[index][0] === "launchctl",
      );
  } else if ((options.platform ?? process.platform) === "linux") {
    await runner(["systemctl", "--user", "daemon-reload"]);
  }
}

async function installServiceFiles(options: ServiceOptions) {
  const plan = await preflightService(options);
  const existed = await readInstallerText(plan.file)
    .then(() => true)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
  const runner = options.runner ?? defaultRunner;
  await mkdir(path.dirname(plan.file), { recursive: true });
  if ((options.platform ?? process.platform) === "darwin")
    await mkdir(path.join(options.home, ".local/state/ast-mcp"), {
      recursive: true,
    });
  await writeInstallerFile(plan.file, plan.content);
  onInstallerRollback(() => compensateService(options, plan, existed));
  for (let index = 0; index < plan.installCommands.length; index += 1)
    await runner(
      plan.installCommands[index],
      index === 0 && plan.installCommands[index][0] === "launchctl",
    );
  if (!options.runner) await waitForService(options.endpoint.url);
  return plan;
}

export async function removeService(options: ServiceOptions) {
  return withInstallerFileTransaction(() => removeServiceFiles(options));
}

async function removeServiceFiles(options: ServiceOptions) {
  const plan = createServicePlan(options);
  const existed = await readInstallerText(plan.file)
    .then(() => true)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
  onInstallerRollback(() => compensateService(options, plan, existed));
  const runner = options.runner ?? defaultRunner;
  for (const command of plan.removeCommands) await runner(command, true);
  await removeInstallerFile(plan.file);
  if ((options.platform ?? process.platform) === "linux")
    await runner(["systemctl", "--user", "daemon-reload"], true);
  return plan;
}

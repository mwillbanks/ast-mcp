import path from "node:path";
import type { McpTransport } from "../installer-transport";

const installerTargets = ["codex", "claude", "copilot"] as const;
export type InstallerTarget = (typeof installerTargets)[number];
export type InstallerOperation = "install" | "update" | "uninstall";

export interface ParsedInstallerCommand {
  operation: InstallerOperation;
  options: {
    deprecatedRoot?: boolean;
    host?: string;
    port?: number;
    root: string;
    scope: "local" | "global";
    service?: boolean;
    targets: InstallerTarget[];
    transport?: McpTransport;
  };
}

function usageError(message: string): Error {
  const error = new Error(message);
  error.name = "InstallerUsageError";
  return error;
}

function expandedTokens(args: string[]): string[] {
  return args.flatMap((token) => {
    const match = /^(--(?:scope|root|target|transport|host|port))=(.*)$/.exec(
      token,
    );
    return match ? [match[1], match[2]] : [token];
  });
}

function requiredValue(tokens: string[], index: number): string {
  const value = tokens[index + 1];
  if (!value || value.startsWith("-"))
    throw usageError(`Missing value for ${tokens[index] ?? "option"}`);
  return value;
}

function httpPort(value: string): number {
  if (!/^\d+$/.test(value))
    throw usageError(
      `Invalid HTTP port "${value}"; expected an integer from 1 through 65535`,
    );
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw usageError(
      `Invalid HTTP port "${value}"; expected an integer from 1 through 65535`,
    );
  return port;
}

function operationFrom(tokens: string[]): InstallerOperation {
  const first = tokens[0];
  if (first === "install" || first === "update" || first === "uninstall") {
    tokens.shift();
    return first;
  }
  return "install";
}

type MutableOptions = ParsedInstallerCommand["options"];

type ValueOptionHandler = (value: string, options: MutableOptions) => void;

const valueOptionHandlers: Record<string, ValueOptionHandler> = {
  "--host": (value, options) => {
    options.host = value;
  },
  "--port": (value, options) => {
    options.port = httpPort(value);
  },
  "--root": (value, options) => {
    options.root = value;
  },
  "--scope": (value, options) => {
    options.scope = value as "local" | "global";
  },
  "--target": (value, options) => {
    options.targets =
      value === "all" ? [...installerTargets] : [value as InstallerTarget];
  },
  "--transport": (value, options) => {
    options.transport = value as McpTransport;
  },
};

valueOptionHandlers["-r"] = valueOptionHandlers["--root"] as ValueOptionHandler;
valueOptionHandlers["-s"] = valueOptionHandlers[
  "--scope"
] as ValueOptionHandler;
valueOptionHandlers["-t"] = valueOptionHandlers[
  "--target"
] as ValueOptionHandler;

function applyValueOption(
  token: string,
  value: string,
  options: MutableOptions,
): void {
  const handler = valueOptionHandlers[token];
  if (!handler) throw usageError(`Unknown option: ${token}`);
  handler(value, options);
}

function validateOptions(options: MutableOptions): void {
  if (options.scope !== "local" && options.scope !== "global")
    throw usageError(
      `Invalid scope "${options.scope}"; expected local or global`,
    );
  const invalidTarget = options.targets.find(
    (target) => !installerTargets.includes(target),
  );
  if (invalidTarget)
    throw usageError(
      `Invalid target "${invalidTarget}"; expected codex, claude, copilot, or all`,
    );
  if (
    options.transport &&
    options.transport !== "stdio" &&
    options.transport !== "http"
  )
    throw usageError(
      `Invalid transport "${options.transport}"; expected stdio or http`,
    );
}

export function parseInstallerArguments(
  args: string[],
  cwd: string,
): ParsedInstallerCommand {
  const tokens = expandedTokens(args);
  const operation = operationFrom(tokens);
  const options: MutableOptions = {
    root: cwd,
    scope: "local",
    targets: [...installerTargets],
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--service" || token === "--no-service") {
      const service = token === "--service";
      if (options.service !== undefined && options.service !== service)
        throw usageError("--service and --no-service cannot be used together");
      options.service = service;
      continue;
    }
    if (
      ![
        "--scope",
        "-s",
        "--root",
        "-r",
        "--target",
        "-t",
        "--transport",
        "--host",
        "--port",
      ].includes(token)
    )
      throw usageError(`Unknown option: ${token}`);
    applyValueOption(token, requiredValue(tokens, index), options);
    index += 1;
  }
  if (
    args.some(
      (token) =>
        token === "--root" || token === "-r" || token.startsWith("--root="),
    )
  )
    options.deprecatedRoot = true;
  validateOptions(options);
  return { operation, options };
}

function codexPaths(global: boolean, root: string, home: string): string[] {
  const base = global ? path.join(home, ".codex") : path.join(root, ".codex");
  return [
    path.join(base, "config.toml"),
    path.join(base, "hooks.json"),
    path.join(base, "hooks/ast-mcp.ts"),
    path.join(base, "skills/ast-mcp"),
    global ? path.join(base, "AGENTS.md") : path.join(root, "AGENTS.md"),
  ];
}

function claudePaths(global: boolean, root: string, home: string): string[] {
  const base = global ? path.join(home, ".claude") : path.join(root, ".claude");
  return [
    global ? path.join(home, ".claude.json") : path.join(root, ".mcp.json"),
    path.join(base, "settings.json"),
    path.join(base, "hooks/ast-mcp.ts"),
    path.join(base, "skills/ast-mcp"),
    global ? path.join(base, "CLAUDE.md") : path.join(root, "AGENTS.md"),
  ];
}

function copilotPaths(global: boolean, root: string, home: string): string[] {
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

export function installerTargetPaths(
  target: InstallerTarget,
  global: boolean,
  root: string,
  home: string,
): string[] {
  if (target === "codex") return codexPaths(global, root, home);
  if (target === "claude") return claudePaths(global, root, home);
  return copilotPaths(global, root, home);
}

export function codexTransport(content: string): McpTransport | undefined {
  const block = content.match(/# ast-mcp:begin\n([\s\S]*?)# ast-mcp:end/)?.[1];
  if (!block) return undefined;
  return /^\s*url\s*=/m.test(block) ? "http" : "stdio";
}

export function jsonTransport(
  entry: Record<string, unknown> | undefined,
): McpTransport | undefined {
  if (!entry) return undefined;
  return typeof entry.url === "string" ? "http" : "stdio";
}

export function jsonTargetConfig(
  target: Exclude<InstallerTarget, "codex">,
  global: boolean,
  root: string,
  home: string,
): string {
  if (target === "claude")
    return global
      ? path.join(home, ".claude.json")
      : path.join(root, ".mcp.json");
  return global
    ? path.join(home, ".copilot/mcp-config.json")
    : path.join(root, ".github/mcp.json");
}

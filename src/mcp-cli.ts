import {
  transports,
  validateHttpHost,
  validateHttpPort,
} from "./installer-transport";

export interface McpCliRuntime {
  http?(options: { host?: string; port?: number }): Promise<{ url: URL }>;
  stdio?(): Promise<void>;
}

function mcpUsageError(message: string) {
  const error = new Error(message);
  error.name = "McpUsageError";
  return error;
}

function valueAfter(args: string[], index: number) {
  const value = args[index + 1];
  if (!value || value.startsWith("-"))
    throw mcpUsageError(`Missing value for ${args[index] ?? "option"}`);
  return value;
}

interface ParsedMcpOptions {
  host?: string;
  port?: number;
  transport: "stdio" | "http";
}

function normalizedMcpTokens(args: string[]) {
  return args.flatMap((token) => {
    const match = /^(--(?:transport|host|port))=(.*)$/.exec(token);
    return match ? [match[1] as string, match[2] as string] : [token];
  });
}

function parsedPort(raw: string) {
  if (!/^\d+$/.test(raw))
    throw mcpUsageError(
      `Invalid HTTP port "${raw}"; expected an integer from 1 through 65535`,
    );
  return validateHttpPort(Number(raw));
}

function parseMcpOptions(args: string[]): ParsedMcpOptions {
  const tokens = normalizedMcpTokens(args);
  const options: ParsedMcpOptions = { transport: "stdio" };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--transport") {
      options.transport = valueAfter(
        tokens,
        index,
      ) as ParsedMcpOptions["transport"];
      index += 1;
    } else if (token === "--host") {
      options.host = valueAfter(tokens, index);
      index += 1;
    } else if (token === "--port") {
      options.port = parsedPort(valueAfter(tokens, index));
      index += 1;
    } else throw mcpUsageError(`Unknown option: ${token}`);
  }
  return options;
}

function validateMcpOptions(options: ParsedMcpOptions) {
  if (!transports.includes(options.transport))
    throw mcpUsageError(
      `Invalid transport "${options.transport}"; expected stdio or http`,
    );
  if (
    options.transport === "stdio" &&
    (options.host !== undefined || options.port !== undefined)
  )
    throw mcpUsageError("--host and --port require --transport http");
}

async function startStdio(runtime: McpCliRuntime) {
  if (runtime.stdio) await runtime.stdio();
  else await import("./index");
}

async function startHttp(options: ParsedMcpOptions, runtime: McpCliRuntime) {
  const host =
    options.host === undefined ? undefined : validateHttpHost(options.host);
  if (runtime.http) return await runtime.http({ host, port: options.port });
  const { startHttpServer } = await import("./http");
  return await startHttpServer({ host, port: options.port });
}

export async function runMcpCli(args: string[], runtime: McpCliRuntime = {}) {
  const options = parseMcpOptions(args);
  validateMcpOptions(options);
  if (options.transport === "stdio") {
    await startStdio(runtime);
    return;
  }
  const server = await startHttp(options, runtime);
  const endpoint = new URL("/mcp", server.url);
  process.stderr.write(`ast-mcp: listening on ${endpoint.toString()}\n`);
  return server;
}

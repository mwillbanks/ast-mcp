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

export async function runMcpCli(args: string[], runtime: McpCliRuntime = {}) {
  const tokens = args.flatMap((token) => {
    const match = /^(--(?:transport|host|port))=(.*)$/.exec(token);
    return match ? [match[1], match[2]] : [token];
  });
  let transport: "stdio" | "http" = "stdio";
  let host: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--transport") {
      transport = valueAfter(tokens, index) as typeof transport;
      index += 1;
    } else if (token === "--host") {
      host = valueAfter(tokens, index);
      index += 1;
    } else if (token === "--port") {
      const raw = valueAfter(tokens, index);
      if (!/^\d+$/.test(raw))
        throw mcpUsageError(
          `Invalid HTTP port "${raw}"; expected an integer from 1 through 65535`,
        );
      port = validateHttpPort(Number(raw));
      index += 1;
    } else throw mcpUsageError(`Unknown option: ${token}`);
  }
  if (!transports.includes(transport))
    throw mcpUsageError(
      `Invalid transport "${transport}"; expected stdio or http`,
    );
  if (transport === "stdio") {
    if (host !== undefined || port !== undefined)
      throw mcpUsageError("--host and --port require --transport http");
    runtime.stdio ? await runtime.stdio() : await import("./index");
    return;
  }
  if (host !== undefined) host = validateHttpHost(host);
  let server: { url: URL };
  if (runtime.http) server = await runtime.http({ host, port });
  else {
    const { startHttpServer } = await import("./http");
    server = await startHttpServer({ host, port });
  }
  const endpoint = new URL("/mcp", server.url);
  process.stderr.write(`ast-mcp: listening on ${endpoint.toString()}\n`);
  return server;
}

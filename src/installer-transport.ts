import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { clearConfigCache, globalConfigPath, resolveConfig } from "./config";

export const transports = ["stdio", "http"] as const;
export type McpTransport = (typeof transports)[number];

export interface HttpEndpoint {
  host: string;
  port: number;
  url: string;
}

export interface InstallerEndpointOptions {
  env?: NodeJS.ProcessEnv;
  home: string;
  host?: string;
  persist?: boolean;
  port?: number;
  root: string;
  scope: "local" | "global";
}

export function validateHttpHost(host: string) {
  const value = host.trim();
  const hostname =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (
    !hostname ||
    (!isIP(hostname) &&
      !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)$/.test(hostname))
  )
    throw new Error(
      `Invalid HTTP host "${host}"; expected a hostname or IP address without a scheme or path`,
    );
  return hostname;
}

export function validateHttpPort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(
      `Invalid HTTP port "${port}"; expected an integer from 1 through 65535`,
    );
  return port;
}

export function httpEndpoint(host: string, port: number): HttpEndpoint {
  const bindHost = validateHttpHost(host);
  const clientHost =
    bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost === "::" ? "::1" : bindHost;
  const urlHost = isIP(clientHost) === 6 ? `[${clientHost}]` : clientHost;
  return {
    host: bindHost,
    port: validateHttpPort(port),
    url: `http://${urlHost}:${port}/mcp`,
  };
}

function assignment(name: "host" | "port", value: string | number) {
  return `${name} = ${typeof value === "string" ? JSON.stringify(value) : value}`;
}

type HttpValues = { host?: string; port?: number };
type HttpField = "host" | "port";

function assertToml(content: string, message: string) {
  try {
    Bun.TOML.parse(content);
  } catch (error) {
    throw new Error(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function httpHeader(content: string) {
  if (/^\s*http\.(?:host|port)\s*=/m.test(content))
    throw new Error(
      "Cannot update HTTP configuration with dotted http.host or http.port keys; move them into an [http] table",
    );
  const headers = [...content.matchAll(/^\s*\[http\]\s*(?:#.*)?$/gm)];
  if (headers.length > 1)
    throw new Error(
      "Cannot update HTTP configuration with duplicate [http] tables",
    );
  return headers[0];
}

function normalizedHttpValue(name: HttpField, value: string | number) {
  return name === "host"
    ? validateHttpHost(String(value))
    : validateHttpPort(Number(value));
}

function newHttpSection(content: string, values: HttpValues) {
  const lines = ["[http]"];
  for (const [name, value] of Object.entries(values) as Array<
    [HttpField, string | number | undefined]
  >) {
    if (value !== undefined)
      lines.push(assignment(name, normalizedHttpValue(name, value)));
  }
  return `${content.trimEnd()}${content.trim() ? "\n\n" : ""}${lines.join("\n")}\n`;
}

function updateHttpField(
  section: string,
  name: HttpField,
  value: string | number,
) {
  const line = assignment(name, normalizedHttpValue(name, value));
  const pattern = new RegExp(`^(\\s*)${name}\\s*=([^#\\n]*)(\\s+#.*)?$`, "m");
  return pattern.test(section)
    ? section.replace(
        pattern,
        (_match, indentation: string, _oldValue: string, comment = "") =>
          `${indentation}${line}${comment}`,
      )
    : `${section.trimEnd()}\n${line}\n`;
}

function updateHttpSection(
  content: string,
  header: RegExpMatchArray,
  values: HttpValues,
) {
  const start = (header.index ?? 0) + header[0].length;
  const nextHeader = /^\s*\[(?!http\])[^\n]+\]\s*(?:#.*)?$/gm;
  nextHeader.lastIndex = start;
  const end = nextHeader.exec(content)?.index ?? content.length;
  let section = content.slice(start, end);
  for (const [name, value] of Object.entries(values) as Array<
    [HttpField, string | number | undefined]
  >) {
    if (value !== undefined) section = updateHttpField(section, name, value);
  }
  return `${content.slice(0, start)}${section}${content.slice(end)}`;
}

export function updateHttpToml(
  content: string,
  values: { host?: string; port?: number },
) {
  if (values.host === undefined && values.port === undefined) return content;
  assertToml(
    content,
    "Cannot update HTTP configuration because the existing TOML is invalid",
  );
  const header = httpHeader(content);
  const result = header
    ? updateHttpSection(content, header, values)
    : newHttpSection(content, values);
  assertToml(result, "Generated invalid HTTP configuration");
  return result;
}

export async function resolveInstallerEndpoint(
  options: InstallerEndpointOptions,
): Promise<HttpEndpoint> {
  const configFile =
    options.scope === "local"
      ? path.join(path.resolve(options.root), "ast-mcp.toml")
      : globalConfigPath({ env: options.env, home: options.home });
  if (
    options.persist !== false &&
    (options.host !== undefined || options.port !== undefined)
  ) {
    let current = "";
    try {
      current = await readFile(configFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const updated = updateHttpToml(current, {
      host: options.host,
      port: options.port,
    });
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, updated);
    clearConfigCache();
  }
  const config = await resolveConfig({
    cwd: options.scope === "local" ? options.root : options.home,
    env: options.env,
    home: options.home,
  });
  return httpEndpoint(
    options.host ?? config.http.host,
    options.port ?? config.http.port,
  );
}

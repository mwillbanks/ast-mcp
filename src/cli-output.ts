import type { ResolvedConfig } from "./config";
import {
  cliOutputFormatSchema,
  type CliOutputFormat,
} from "./config-schema-common";

export class CliOutputUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliOutputUsageError";
  }
}

export interface CliOutputContext {
  isTTY?: boolean;
  write?: (text: string) => void;
}

/** Validate every output option before a command can perform work. */
export function parseOutputArguments(args: string[]): {
  args: string[];
  output?: CliOutputFormat;
} {
  const remaining: string[] = [];
  let output: CliOutputFormat | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token !== "--output" && !token.startsWith("--output=")) {
      remaining.push(token);
      continue;
    }
    if (output !== undefined)
      throw new CliOutputUsageError("Specify --output only once");
    const value = token === "--output" ? args[++index] : token.slice(9);
    const parsed = cliOutputFormatSchema.safeParse(value);
    if (!parsed.success)
      throw new CliOutputUsageError(
        "Expected --output human, json, yaml, or toml",
      );
    output = parsed.data;
  }
  return { args: remaining, output };
}

export function selectOutputFormat(
  config: Pick<ResolvedConfig, "cli">,
  output?: CliOutputFormat,
  isTTY = process.stdout.isTTY === true,
): CliOutputFormat {
  return (
    output ??
    (isTTY ? config.cli.output.interactive : config.cli.output.nonInteractive)
  );
}

function humanLabel(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function humanLines(value: object, indent = ""): string[] {
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}None`];
    return value.flatMap((item) => {
      if (item !== null && typeof item === "object")
        return [`${indent}-`, ...humanLines(item, `${indent}  `)];
      return [`${indent}- ${String(item)}`];
    });
  }
  return Object.entries(value).flatMap(([key, item]) => {
    if (item === undefined) return [];
    const label = humanLabel(key);
    if (item !== null && typeof item === "object")
      return [`${indent}${label}:`, ...humanLines(item, `${indent}  `)];
    return [`${indent}${label}: ${item === null ? "None" : String(item)}`];
  });
}

function tomlValue(
  value: unknown,
  location: string,
  ancestors: Set<object>,
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  )
    throw new Error(
      `TOML cannot represent the value at ${location}; use --output json or yaml`,
    );
  if (typeof value !== "object" || value instanceof Date) return value;
  if (ancestors.has(value))
    throw new Error(
      `TOML cannot represent a circular value at ${location}; use --output json or yaml`,
    );
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1)
        result.push(
          tomlValue(value[index], `${location}[${index}]`, ancestors),
        );
      return result;
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null && item !== undefined)
        .map(([key, item]) => [
          key,
          tomlValue(item, `${location}.${key}`, ancestors),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function renderCliOutput(
  result: object,
  format: CliOutputFormat,
  title: string,
): string {
  let rendered: string;
  if (format === "human")
    rendered = [title, "", ...humanLines(result)].join("\n");
  else if (format === "json") rendered = JSON.stringify(result, null, 2);
  else if (format === "yaml") rendered = Bun.YAML.stringify(result, null, 2);
  else {
    try {
      rendered = Bun.TOML.stringify(
        tomlValue(result, "$", new Set()) as object,
      );
    } catch (error) {
      const message = String(error);
      throw new Error(
        `Cannot render TOML output: ${message}. Use --output json or yaml.`,
      );
    }
  }
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

export function writeCliOutput(
  result: object,
  format: CliOutputFormat,
  title: string,
  write: (text: string) => void = (text) => process.stdout.write(text),
): void {
  write(renderCliOutput(result, format, title));
}

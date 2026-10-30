import path from "node:path";

import { resolveConfig } from "../config";
import { inspectHostConfiguration } from "../installer/diagnostics";
import { collectDiagnostics } from "../runtime/diagnostics";
import {
  parseOutputArguments,
  selectOutputFormat,
  writeCliOutput,
  type CliOutputContext,
} from "./output";

class DoctorUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoctorUsageError";
  }
}

export function parseDoctorArguments(args: string[], cwd = process.cwd()) {
  const options: {
    root: string;
    scope: "local" | "global";
    target: "auto" | "codex" | "claude" | "copilot";
    profile?: string;
  } = { root: cwd, scope: "local", target: "auto" };
  const tokens = args.flatMap((token) => {
    const match = /^(--(?:root|scope|target|profile))=(.*)$/.exec(token);
    return match ? [match[1]!, match[2]!] : [token];
  });
  for (let index = 0; index < tokens.length; index++) {
    const option = tokens[index]!;
    if (!["--root", "--scope", "--target", "--profile"].includes(option))
      throw new DoctorUsageError(`Unknown option: ${option}`);
    const value = tokens[++index];
    if (!value || value.startsWith("-"))
      throw new DoctorUsageError(`Missing value for ${option}`);
    if (option === "--root") options.root = path.resolve(value);
    if (option === "--scope") {
      if (value !== "local" && value !== "global")
        throw new DoctorUsageError("Expected --scope local or global");
      options.scope = value;
    }
    if (option === "--target") {
      if (!["auto", "codex", "claude", "copilot"].includes(value))
        throw new DoctorUsageError(
          "Expected --target auto, codex, claude, or copilot",
        );
      options.target = value as typeof options.target;
    }
    if (option === "--profile") {
      if (!/^[\w.-]{1,100}$/.test(value))
        throw new DoctorUsageError(
          "Expected a profile name containing letters, digits, dots, underscores, or hyphens",
        );
      options.profile = value;
    }
  }
  if (
    options.profile &&
    options.target !== "codex" &&
    options.target !== "auto"
  )
    throw new DoctorUsageError("--profile requires --target codex or auto");
  return options;
}

export async function runDoctorCli(
  args = process.argv.slice(2),
  context: CliOutputContext & {
    fetch?: typeof fetch;
    home?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  const parsed = parseOutputArguments(args);
  const options = parseDoctorArguments(parsed.args);
  const [diagnostics, host] = await Promise.all([
    collectDiagnostics({ cwd: options.root, fetch: context.fetch }),
    inspectHostConfiguration({
      ...options,
      home: context.home,
      env: context.env,
    }),
  ]);
  const config = await resolveConfig({ cwd: options.root }).catch(
    () => undefined,
  );
  const output =
    parsed.output ??
    (config
      ? selectOutputFormat(config, undefined, context.isTTY)
      : context.isTTY
        ? "human"
        : "json");
  writeCliOutput(
    { ...diagnostics, host },
    output,
    "AST-MCP diagnostics",
    context.write,
  );
  return 0;
}

import path from "node:path";
import { resolveConfig } from "./config";

class ConfigurationUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationUsageError";
  }
}

const stdout = process.stdout;

function valueAfter(tokens: string[], index: number) {
  const value = tokens[index + 1];
  if (!value || value.startsWith("-"))
    throw new ConfigurationUsageError(
      `Missing value for ${tokens[index] ?? "option"}`,
    );
  return value;
}

export async function runConfigCli(
  args: string[],
  write: (text: string) => void = stdout.write.bind(stdout),
) {
  const tokens = args.flatMap((token) => {
    const match = /^--root=(.*)$/.exec(token);
    return match ? ["--root", match[1] as string] : [token];
  });
  const operation = tokens.shift();
  if (operation !== "validate" && operation !== "show")
    throw new ConfigurationUsageError(
      `Expected config validate or config show; received "${operation ?? ""}"`,
    );

  let root = process.cwd();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "--root" && tokens[index] !== "-r")
      throw new ConfigurationUsageError(`Unknown option: ${tokens[index]}`);
    root = valueAfter(tokens, index);
    index += 1;
  }

  const config = await resolveConfig({ cwd: path.resolve(root) });
  const output =
    operation === "show"
      ? config
      : {
          projectRoot: config.projectRoot,
          sources: config.sources,
          valid: true,
        };
  write(`${JSON.stringify(output, null, 2)}\n`);
}

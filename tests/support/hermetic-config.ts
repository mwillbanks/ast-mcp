import path from "node:path";
import type { ResolveConfigOptions } from "../../src/config";

export function hermeticConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): ResolveConfigOptions {
  const stateRoot = path.join(cwd, ".ast-mcp-test-state");
  return {
    cwd,
    env: {
      ...env,
      XDG_CONFIG_HOME: path.join(stateRoot, "xdg"),
    },
    home: path.join(stateRoot, "home"),
  };
}

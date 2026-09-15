import path from "node:path";
import type { ResolveConfigOptions } from "../../src/config";

export function hermeticConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): ResolveConfigOptions {
  const stateRoot = path.join(cwd, ".ast-mcp-test-state");
  const configHome = path.join(stateRoot, "xdg");
  return {
    cwd,
    env: {
      ...env,
      APPDATA: configHome,
      XDG_CONFIG_HOME: configHome,
    },
    home: path.join(stateRoot, "home"),
  };
}

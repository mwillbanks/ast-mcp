import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const isolatedHome = path.join(os.tmpdir(), `ast-mcp-test-home-${process.pid}`);

mkdirSync(path.join(isolatedHome, "bin"), { recursive: true });
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.XDG_CONFIG_HOME = path.join(isolatedHome, ".config");
process.env.XDG_CACHE_HOME = path.join(isolatedHome, "cache");
process.env.APPDATA = path.join(isolatedHome, ".config");
process.env.LOCALAPPDATA = path.join(isolatedHome, "cache");
const configurationDirectory = path.join(isolatedHome, ".config", "ast-mcp");
mkdirSync(configurationDirectory, { recursive: true });
// Keep the global policy at v2 so explicit v2 projects retain their boundaries.
// Fixtures that exercise legacy temporary access must select version 1 explicitly.
writeFileSync(
  path.join(configurationDirectory, "ast-mcp.toml"),
  "version = 2\n[telemetry]\nenabled = false\n",
);
Object.defineProperty(os, "homedir", {
  configurable: true,
  value: () => isolatedHome,
});

process.on("exit", () => {
  rmSync(isolatedHome, { force: true, recursive: true });
});

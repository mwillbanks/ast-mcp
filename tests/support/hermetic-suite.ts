import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const isolatedHome = path.join(os.tmpdir(), `ast-mcp-test-home-${process.pid}`);

mkdirSync(path.join(isolatedHome, "bin"), { recursive: true });
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.XDG_CONFIG_HOME = path.join(isolatedHome, "xdg");
process.env.XDG_CACHE_HOME = path.join(isolatedHome, "cache");
process.env.APPDATA = path.join(isolatedHome, "xdg");
process.env.LOCALAPPDATA = path.join(isolatedHome, "cache");
Object.defineProperty(os, "homedir", {
  configurable: true,
  value: () => isolatedHome,
});

process.on("exit", () => {
  rmSync(isolatedHome, { force: true, recursive: true });
});

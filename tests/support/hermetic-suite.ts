import { afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { disposeMockTimes } from "./mock-time";

const isolatedHome = path.join(os.tmpdir(), `ast-mcp-test-home-${process.pid}`);

mkdirSync(path.join(isolatedHome, "bin"), { recursive: true });
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
// Let explicit fixture homes own global Codex installations.
delete process.env.CODEX_HOME;
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

// Load runtime modules only after the isolated environment is installed.
const { configRegistry } = await import("../../src/config/registry");

afterEach(() => {
  const failures: unknown[] = [];
  try {
    configRegistry.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    disposeMockTimes();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Test resource and clock cleanup failed",
    );
});

process.on("exit", () => {
  rmSync(isolatedHome, { force: true, recursive: true });
});

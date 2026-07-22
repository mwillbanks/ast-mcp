import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { install } from "../src/installer";

test("installer configures stable CLI subcommands for every local host", async () => {
  const root = await os.tmpdir();
  const folder = path.join(
    root,
    `ast-mcp-hot-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const home = path.join(
    root,
    `ast-mcp-hot-home-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await install({
    home,
    root: folder,
    scope: "local",
    targets: ["codex", "claude", "copilot"],
  });
  try {
    expect(
      await readFile(path.join(folder, ".codex/config.toml"), "utf8"),
    ).toContain('/dist/ast-mcp.js", "mcp"]');
    const claude = JSON.parse(
      await readFile(path.join(folder, ".mcp.json"), "utf8"),
    );
    expect(claude.mcpServers["ast-mcp"].args).toEqual([
      path.resolve(import.meta.dir, "../dist/ast-mcp.js"),
      "mcp",
    ]);
    const copilot = JSON.parse(
      await readFile(path.join(folder, ".github/mcp.json"), "utf8"),
    );
    expect(copilot.mcpServers["ast-mcp"].args).toEqual([
      path.resolve(import.meta.dir, "../dist/ast-mcp.js"),
      "mcp",
    ]);
  } finally {
    await rm(folder, { force: true, recursive: true });
    await rm(home, { force: true, recursive: true });
  }
});

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { install } from "../../src/installer";

test("installer configures stable CLI subcommands for every local host", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-hot-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-hot-home-"));
  await install({
    home,
    root: folder,
    scope: "local",
    targets: ["codex", "claude", "copilot"],
  });
  try {
    const launch = {
      args: [
        path.resolve(import.meta.dir, "../../bin/ast-mcp.ts"),
        "mcp",
        "--shared-stdio",
      ],
      command: process.execPath,
      cwd: folder,
    };
    const codex = Bun.TOML.parse(
      await readFile(path.join(folder, ".codex/config.toml"), "utf8"),
    ) as { mcp_servers: Record<string, unknown> };
    expect(codex.mcp_servers["ast-mcp"]).toMatchObject(launch);
    const claude = JSON.parse(
      await readFile(path.join(folder, ".mcp.json"), "utf8"),
    );
    expect(claude.mcpServers["ast-mcp"]).toMatchObject(launch);
    const copilot = JSON.parse(
      await readFile(path.join(folder, ".github/mcp.json"), "utf8"),
    );
    expect(copilot.mcpServers["ast-mcp"]).toMatchObject(launch);
  } finally {
    await rm(folder, { force: true, recursive: true });
    await rm(home, { force: true, recursive: true });
  }
});

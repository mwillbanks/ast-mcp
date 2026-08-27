import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { install, uninstall } from "../src/installer";
import { checkInstall } from "../templates/skills/ast-mcp/scripts/check-install";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

async function temporary(prefix: string) {
  const folder = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(folder);
  return folder;
}

test("installs, diagnoses, and uninstalls global HTTP host entries", async () => {
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = await temporary("ast-mcp-http-global-xdg-");
  try {
    const root = await temporary("ast-mcp-http-global-root-");
    const home = await temporary("ast-mcp-http-global-home-");
    const globalAlias = path.join(home, ".bun/bin/ast-mcp");
    await mkdir(path.dirname(globalAlias), { recursive: true });
    await writeFile(globalAlias, "#!/bin/sh\nexit 0\n");
    await chmod(globalAlias, 0o755);
    await install({
      home,
      host: "127.0.0.1",
      port: 4891,
      root,
      scope: "global",
      targets: ["codex", "claude", "copilot"],
      transport: "http",
    });

    for (const target of ["codex", "claude", "copilot"] as const) {
      const result = await checkInstall(
        [
          "--scope",
          "global",
          "--target",
          target,
          "--transport",
          "http",
          "--host",
          "127.0.0.1",
          "--port",
          "4891",
        ],
        home,
      );
      expect(result.installed).toBeTrue();
      expect(result.transport).toBe("http");
      expect(result.url).toBe("http://127.0.0.1:4891/mcp");
    }

    await uninstall({
      home,
      root,
      scope: "global",
      targets: ["codex", "claude", "copilot"],
    });
    expect(
      await readFile(path.join(home, ".config/ast-mcp/ast-mcp.toml"), "utf8"),
    ).toContain("port = 4891");
    expect(await readFile(path.join(home, ".codex/config.toml"), "utf8")).toBe(
      "",
    );
  } finally {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }
});

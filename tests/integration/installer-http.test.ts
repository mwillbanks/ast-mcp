import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { globalConfigPath } from "../../src/config";
import { install, uninstall } from "../../src/installer";
import { checkInstall } from "../../templates/skills/ast-mcp/scripts/check-install";

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
  const root = await temporary("ast-mcp-http-global-root-");
  const home = await temporary("ast-mcp-http-global-home-");
  const globalAlias = path.join(
    home,
    ".bun/bin",
    process.platform === "win32" ? "ast-mcp.cmd" : "ast-mcp",
  );
  await mkdir(path.dirname(globalAlias), { recursive: true });
  await writeFile(
    globalAlias,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${path.resolve(import.meta.dir, "../../bin/ast-mcp.ts")}" %*\r\n`
      : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve(import.meta.dir, "../../bin/ast-mcp.ts"))} "$@"\n`,
  );
  await chmod(globalAlias, 0o755);
  const discovery = spyOn(Bun, "spawnSync");
  try {
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

    expect(discovery).not.toHaveBeenCalled();

    const managerAlias = path.join(
      home,
      "manager-bin",
      path.basename(globalAlias),
    );
    await mkdir(path.dirname(managerAlias), { recursive: true });
    await writeFile(managerAlias, await readFile(globalAlias));
    await chmod(managerAlias, 0o755);
    const hookFile = path.join(home, ".codex/hooks.json");
    const hooks = await readFile(hookFile, "utf8");
    const encodedAlias = JSON.stringify(globalAlias).slice(1, -1);
    const nativeCase = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    const aliasIndex = nativeCase(hooks).indexOf(nativeCase(encodedAlias));
    expect(aliasIndex).toBeGreaterThanOrEqual(0);
    const installedAlias = hooks.slice(
      aliasIndex,
      aliasIndex + encodedAlias.length,
    );
    await writeFile(
      hookFile,
      hooks.replaceAll(
        installedAlias,
        JSON.stringify(managerAlias).slice(1, -1),
      ),
    );
    discovery.mockImplementation(((args: string[]) => ({
      exitCode: args.join(" ") === "bun pm bin -g" ? 0 : 1,
      stdout: Buffer.from(path.dirname(managerAlias)),
    })) as never);
    const configuredManager = await checkInstall(
      [
        "--scope",
        "global",
        "--target",
        "codex",
        "--transport",
        "http",
        "--host",
        "127.0.0.1",
        "--port",
        "4891",
      ],
      home,
    );
    expect(configuredManager.installed).toBeTrue();
    expect(discovery).toHaveBeenCalled();
    await install({
      home,
      root,
      scope: "global",
      targets: ["codex"],
      transport: "http",
      host: "127.0.0.1",
      port: 4891,
      cliEntry: managerAlias,
    });
    expect(nativeCase(await readFile(hookFile, "utf8"))).toContain(
      nativeCase(JSON.stringify(managerAlias).slice(1, -1)),
    );
    await writeFile(hookFile, hooks);

    await uninstall({
      home,
      root,
      scope: "global",
      targets: ["codex", "claude", "copilot"],
    });
    expect(
      await readFile(globalConfigPath({ env: {}, home }), "utf8"),
    ).toContain("port = 4891");
    expect(await readFile(path.join(home, ".codex/config.toml"), "utf8")).toBe(
      "",
    );
  } finally {
    discovery.mockRestore();
  }
});

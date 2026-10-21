import { expect, test } from "bun:test";
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

import { globalConfigPath, resolveConfig } from "../../src/config";
import { install, update } from "../../src/installer";

test.each(["local", "global"] as const)(
  "new %s installs disable formatting and updates preserve explicit opt-in",
  async (scope) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-installer-formatting-"),
    );
    const home = path.join(root, "home");
    await mkdir(path.join(root, ".git"));
    await mkdir(home);
    const bin = path.join(home, "bin");
    await mkdir(bin);
    const alias = path.join(
      bin,
      process.platform === "win32" ? "ast-mcp.cmd" : "ast-mcp",
    );
    const entry = path.resolve(import.meta.dir, "../../bin/ast-mcp.ts");
    await writeFile(
      alias,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`
        : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@"\n`,
    );
    await chmod(alias, 0o755);
    const options = {
      root,
      home,
      scope,
      globalBinDirectories: [bin],
      targets: ["codex"] as const,
    };
    const configPath =
      scope === "local"
        ? path.join(root, "ast-mcp.toml")
        : globalConfigPath({ home, env: {} });
    try {
      await install({ ...options, targets: [...options.targets] });
      const source = await readFile(configPath, "utf8");
      expect(
        (Bun.TOML.parse(source) as { formatting: { enabled: boolean } })
          .formatting.enabled,
      ).toBeFalse();
      const config = await resolveConfig({
        cwd: scope === "local" ? root : home,
        home,
        env: {},
      });
      expect(config.formatting).toMatchObject({
        enabled: false,
        fallback: "preserve",
      });
      const explicit = source.replace(
        "[formatting]\nenabled = false",
        "[formatting]\nenabled = true",
      );
      await writeFile(configPath, explicit);
      await update({ ...options, targets: [...options.targets] });
      expect(await readFile(configPath, "utf8")).toBe(explicit);
      expect(
        (
          await resolveConfig({
            cwd: scope === "local" ? root : home,
            home,
            env: {},
          })
        ).formatting.enabled,
      ).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

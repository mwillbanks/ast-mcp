import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { install, uninstall } from "../src/installer";
import { AST_BRO_BINARY } from "../src/runtime/dependencies";

test("installer validates configuration before mutation and uninstall stays available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-install-config-"));
  const home = path.join(root, "home");
  await mkdir(path.join(root, ".git"));
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    "[safety]\nunknown = true\n",
  );

  try {
    await expect(
      install({
        astBroBinary: AST_BRO_BINARY,
        home,
        root,
        scope: "local",
        targets: ["codex"],
      }),
    ).rejects.toThrow("invalid configuration");
    expect(
      await stat(path.join(root, ".codex"))
        .then(() => true)
        .catch(() => false),
    ).toBeFalse();

    await expect(
      uninstall({
        home,
        root,
        scope: "local",
        targets: ["codex"],
      }),
    ).resolves.toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

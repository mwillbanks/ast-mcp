import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { install } from "../../src/installer";

test("concurrent installers serialize shared checkout and home state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-install-race-"));
  const home = path.join(root, "home");
  await mkdir(path.join(root, ".git"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const common = { root, home, scope: "local" as const };
  let secondEntered = false;
  const first = install({
    ...common,
    targets: ["codex"],
    verifyLaunch: async () => {
      entered();
      await gate;
    },
  });
  let second: Promise<unknown> | undefined;
  try {
    await Promise.race([
      ready,
      first.then(() => {
        throw new Error("First installer never entered");
      }),
    ]);
    second = install({
      ...common,
      targets: ["claude"],
      verifyLaunch: async () => {
        secondEntered = true;
      },
    });
    await Bun.sleep(40);
    expect(secondEntered).toBeFalse();
    release();
    await Promise.all([first, second]);
    expect(secondEntered).toBeTrue();
    expect(
      (
        Bun.TOML.parse(
          await readFile(path.join(root, "ast-mcp.toml"), "utf8"),
        ) as Record<string, unknown>
      ).version,
    ).toBe(2);
    expect(
      (
        Bun.TOML.parse(
          await readFile(path.join(root, ".codex/config.toml"), "utf8"),
        ) as Record<string, unknown>
      ).mcp_servers,
    ).toHaveProperty("ast-mcp");
    expect(
      JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8"))
        .mcpServers,
    ).toHaveProperty("ast-mcp");
  } finally {
    release();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

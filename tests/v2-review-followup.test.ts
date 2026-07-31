import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigRegistry } from "../src/config-registry";
import { toolFailure } from "../src/helpers/mcp-schema";

test("registry watches every ancestor searched for project configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-ancestor-watch-"));
  const nested = path.join(root, "packages", "service");
  const registry = new ConfigRegistry(5, 20);
  try {
    await mkdir(path.join(root, ".git"));
    await mkdir(nested, { recursive: true });
    const options = {
      cwd: nested,
      env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
    };
    expect((await registry.snapshot(options)).config?.version).toBe(1);

    await writeFile(
      path.join(root, "ast-mcp.toml"),
      'version = 2\n[formatting]\nfallback = "reject"\n',
    );
    await Bun.sleep(60);

    const reloaded = await registry.snapshot(options);
    expect(reloaded).toMatchObject({ healthy: true });
    expect(reloaded.config).toMatchObject({
      formatting: { fallback: "reject" },
      version: 2,
    });
  } finally {
    registry.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("formatter selection failures use formatter diagnostics", () => {
  expect(
    toolFailure(new Error("No enabled formatter matches /tmp/value.ts")),
  ).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code: "format_failed", retryable: false },
      ok: false,
    },
  });
});

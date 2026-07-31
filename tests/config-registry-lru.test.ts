import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigRegistry } from "../src/config-registry";

async function root(parent: string, name: string): Promise<string> {
  const value = path.join(parent, name);
  await mkdir(path.join(value, ".git"), { recursive: true });
  return value;
}

test("configuration registry bounds watchers with least-recently-used eviction", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-registry-lru-"));
  const registry = new ConfigRegistry(5, 20, 2);
  try {
    const firstRoot = await root(parent, "first");
    const secondRoot = await root(parent, "second");
    const thirdRoot = await root(parent, "third");
    const options = (cwd: string) => ({
      clientRoots: [cwd],
      cwd,
      env: { XDG_CONFIG_HOME: path.join(parent, "xdg") },
    });
    const first = await registry.snapshot(options(firstRoot));
    const second = await registry.snapshot(options(secondRoot));
    expect(await registry.snapshot(options(firstRoot))).toBe(first);
    await registry.snapshot(options(thirdRoot));
    expect(await registry.snapshot(options(secondRoot))).not.toBe(second);
  } finally {
    registry.close();
    await rm(parent, { force: true, recursive: true });
  }
});

test("closing during initial reload cannot resurrect registry watchers", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-registry-close-"),
  );
  const registry = new ConfigRegistry(5, 20, 2);
  try {
    const projectRoot = await root(parent, "project");
    const pending = registry.snapshot({
      clientRoots: [projectRoot],
      cwd: projectRoot,
      env: { XDG_CONFIG_HOME: path.join(parent, "xdg") },
    });
    registry.close();
    await expect(pending).resolves.toMatchObject({ healthy: true });
  } finally {
    registry.close();
    await rm(parent, { force: true, recursive: true });
  }
});

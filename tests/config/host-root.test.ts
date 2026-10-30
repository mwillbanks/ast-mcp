import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { clearConfigCache, resolveConfig } from "../../src/config";
import { ConfigRegistry } from "../../src/config/registry";

const created: string[] = [];
afterEach(async () => {
  clearConfigCache();
  await Promise.all(
    created.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-host-root-"));
  created.push(base);
  const roots = ["cwd", "claude", "explicit", "client"].map((name) =>
    path.join(base, name),
  );
  for (const root of roots) {
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, "ast-mcp.toml"), "version = 2\n");
  }
  return {
    base,
    roots,
    options: { cwd: roots[0]!, home: path.join(base, "home") },
  };
}

test("Claude launch root follows client and explicit AST root precedence", async () => {
  const { roots, options } = await fixture();
  const env = { CLAUDE_PROJECT_DIR: roots[1]! };
  expect((await resolveConfig({ home: options.home, env })).projectRoot).toBe(
    roots[1]!,
  );
  expect(
    (
      await resolveConfig({
        ...options,
        env: { ...env, AST_MCP_PROJECT_ROOT: roots[2]! },
      })
    ).projectRoot,
  ).toBe(roots[2]!);
  expect(
    (
      await resolveConfig({
        ...options,
        env: { ...env, AST_MCP_ROOTS: roots[2]! },
      })
    ).projectRoot,
  ).toBe(roots[2]!);
  expect(
    (await resolveConfig({ ...options, env, clientRoots: [roots[3]!] }))
      .projectRoot,
  ).toBe(roots[3]!);
  expect((await resolveConfig({ ...options, env })).projectRoot).toBe(
    roots[0]!,
  );
  const config = await resolveConfig({ home: options.home, env });
  expect(config.safety.filesystem).toBe("restricted");
});

test("absent, relative, missing, and file host roots preserve cwd discovery", async () => {
  const { roots, options } = await fixture();
  const baseline = await resolveConfig({ home: options.home, env: {} });
  for (const value of [
    undefined,
    "relative",
    path.join(roots[1]!, "missing"),
    path.join(roots[1]!, "ast-mcp.toml"),
  ]) {
    const config = await resolveConfig({
      home: options.home,
      env: { CLAUDE_PROJECT_DIR: value },
    });
    expect(config.projectRoot).toBe(baseline.projectRoot);
  }
});

test("registry separates changed Claude launch roots", async () => {
  const { roots, options } = await fixture();
  const registry = new ConfigRegistry();
  try {
    const first = await registry.get({
      home: options.home,
      env: { CLAUDE_PROJECT_DIR: roots[1]! },
    });
    const second = await registry.get({
      home: options.home,
      env: { CLAUDE_PROJECT_DIR: roots[2]! },
    });
    const explicit = await registry.get({
      home: options.home,
      cwd: process.cwd(),
      env: { CLAUDE_PROJECT_DIR: roots[1]! },
    });
    expect(explicit.projectRoot).toBe(process.cwd());
    expect(
      (
        await resolveConfig({
          home: options.home,
          cwd: process.cwd(),
          env: { CLAUDE_PROJECT_DIR: roots[1]! },
        })
      ).projectRoot,
    ).toBe(process.cwd());
    expect(first.projectRoot).toBe(roots[1]!);
    expect(second.projectRoot).toBe(roots[2]!);
  } finally {
    registry.close();
  }
});

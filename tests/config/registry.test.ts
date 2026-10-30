import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { globalConfigPath, type ResolveConfigOptions } from "../../src/config";
import { ConfigRegistry } from "../../src/config/registry";

async function fixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-registry-identity-"),
  );
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  for (const cwd of [first, second]) {
    await mkdir(path.join(cwd, ".git"), { recursive: true });
    await writeFile(path.join(cwd, "ast-mcp.toml"), "version = 2\n");
  }
  return { root, first, second };
}

test("ambient environment changes cannot redirect an existing registry identity during invalidation", async () => {
  const { root, first } = await fixture();
  const registry = new ConfigRegistry();
  const previous = {
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  const original = path.join(root, "original");
  const temporary = path.join(root, "temporary");
  const options = { cwd: first };
  try {
    for (const directory of [original, temporary]) {
      await mkdir(path.join(directory, "ast-mcp"), { recursive: true });
      await writeFile(
        path.join(directory, "ast-mcp", "ast-mcp.toml"),
        "version = 2\n",
      );
    }
    process.env.APPDATA = original;
    process.env.XDG_CONFIG_HOME = original;
    const baseline = await registry.get(options);
    process.env.APPDATA = temporary;
    process.env.XDG_CONFIG_HOME = temporary;
    const reloaded = await registry.reload();
    expect(reloaded[0]!.healthy).toBeTrue();
    expect(reloaded[0]!.config!.sources.global).toBe(baseline.sources.global);
    process.env.APPDATA = original;
    process.env.XDG_CONFIG_HOME = original;
    await rm(temporary, { recursive: true, force: true });
    expect((await registry.get(options)).sources.global).toBe(
      baseline.sources.global,
    );
    await writeFile(
      globalConfigPath(),
      "version = 2\n[telemetry]\nenabled = false\n",
    );
    await registry.reload();
    expect((await registry.get(options)).telemetry.enabled).toBeFalse();
  } finally {
    if (previous.APPDATA === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous.APPDATA;
    if (previous.XDG_CONFIG_HOME === undefined)
      delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry snapshots caller options, environment, and selection arrays before asynchronous resolution", async () => {
  const { root, first, second } = await fixture();
  const registry = new ConfigRegistry();
  const options: ResolveConfigOptions = {
    cwd: first,
    home: path.join(root, "home"),
    platform: process.platform,
    env: {
      APPDATA: path.join(root, "config"),
      XDG_CONFIG_HOME: path.join(root, "config"),
    },
    clientRoots: [first, second],
    requestPaths: [path.join(first, "data.txt")],
  };
  const original = {
    ...options,
    env: { ...options.env },
    clientRoots: [...options.clientRoots!],
    requestPaths: [...options.requestPaths!],
  };
  try {
    const pending = registry.get(options);
    options.cwd = second;
    options.home = path.join(root, "other-home");
    options.platform = process.platform === "win32" ? "linux" : "win32";
    options.env!.AST_MCP_PROJECT_ROOT = second;
    options.env!.APPDATA = path.join(root, "other-config");
    options.env!.XDG_CONFIG_HOME = path.join(root, "other-config");
    options.clientRoots!.splice(0, 2, second);
    options.requestPaths![0] = path.join(second, "data.txt");
    const baseline = await pending;
    expect(baseline.projectRoot).toBe(first);
    const reloaded = await registry.reload();
    expect(reloaded[0]!.healthy).toBeTrue();
    expect(reloaded[0]!.config!.projectRoot).toBe(first);
    expect(reloaded[0]!.config!.sources).toEqual(baseline.sources);
    expect(await registry.get(original)).toBe(reloaded[0]!.config!);
    expect((await registry.get(options)).projectRoot).toBe(second);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("captured implicit cwd survives process drift and retains Claude fallback precedence", async () => {
  const { root, first, second } = await fixture();
  const registry = new ConfigRegistry();
  const previousCwd = process.cwd();
  const options = { env: {}, home: path.join(root, "home") };
  try {
    process.chdir(first);
    const firstLaunch = process.cwd();
    expect((await registry.get(options)).projectRoot).toBe(firstLaunch);
    process.chdir(second);
    const secondLaunch = process.cwd();
    const reloaded = await registry.reload();
    expect(reloaded[0]!.config!.projectRoot).toBe(firstLaunch);
    expect((await registry.get(options)).projectRoot).toBe(secondLaunch);
    const hostOptions = { ...options, env: { CLAUDE_PROJECT_DIR: first } };
    expect((await registry.get(hostOptions)).projectRoot).toBe(first);
    expect(
      (await registry.get({ ...hostOptions, cwd: second })).projectRoot,
    ).toBe(second);
    hostOptions.env.CLAUDE_PROJECT_DIR = second;
    const snapshots = await registry.reload();
    expect(
      snapshots.some((snapshot) => snapshot.config?.projectRoot === first),
    ).toBeTrue();
  } finally {
    process.chdir(previousCwd);
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("relative identity paths retain launch cwd semantics when explicit cwd differs", async () => {
  const { root, first, second } = await fixture();
  const registry = new ConfigRegistry();
  const previousCwd = process.cwd();
  try {
    process.chdir(first);
    const launch = process.cwd();
    const global = path.join(
      launch,
      "relative-config",
      "ast-mcp",
      "ast-mcp.toml",
    );
    await mkdir(path.dirname(global), { recursive: true });
    await writeFile(global, "version = 2\n[telemetry]\nenabled = false\n");
    const options = {
      cwd: second,
      home: "relative-home",
      clientRoots: ["."],
      env: { APPDATA: "relative-config", XDG_CONFIG_HOME: "relative-config" },
    };
    const baseline = await registry.get(options);
    expect(baseline.projectRoot).toBe(launch);
    expect(baseline.sources.global).toBe(global);
    expect(baseline.telemetry.enabled).toBeFalse();
    const homeOnly = await registry.get({ ...options, env: {} });
    const expectedHome = globalConfigPath({
      home: path.join(launch, "relative-home"),
      env: {},
    });
    expect(
      Object.keys(
        (await registry.snapshot({ ...options, env: {} })).fingerprints,
      ),
    ).toContain(expectedHome);
    process.chdir(second);
    const snapshots = await registry.reload();
    expect(snapshots[0]!.config!.projectRoot).toBe(baseline.projectRoot);
    expect(snapshots[0]!.config!.sources.global).toBe(global);
    expect(snapshots[1]!.config!.projectRoot).toBe(homeOnly.projectRoot);
    expect(Object.keys(snapshots[1]!.fingerprints)).toContain(expectedHome);
  } finally {
    process.chdir(previousCwd);
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

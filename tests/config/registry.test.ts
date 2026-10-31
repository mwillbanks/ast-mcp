import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  globalConfigPath,
  type ResolveConfigOptions,
  type ResolvedConfig,
} from "../../src/config";
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

test("reloading changed selections preserves unrelated and unchanged snapshots", async () => {
  const { root, first, second } = await fixture();
  const registry = new ConfigRegistry(60_000);
  const base = { env: {}, home: path.join(root, "home") };
  try {
    const before = await registry.snapshot({ ...base, cwd: first });
    const unrelated = await registry.snapshot({ ...base, cwd: second });
    await writeFile(
      path.join(first, "ast-mcp.toml"),
      "version = 2\n[telemetry]\nenabled = false\n",
    );
    await registry.reload();
    const changed = await registry.snapshot({ ...base, cwd: first });
    expect(changed.generation).toBeGreaterThan(before.generation);
    expect(changed.config!.telemetry.enabled).toBeFalse();
    expect(await registry.snapshot({ ...base, cwd: second })).toBe(unrelated);
    await registry.reload();
    expect(await registry.snapshot({ ...base, cwd: first })).toBe(changed);
    expect(await registry.snapshot({ ...base, cwd: second })).toBe(unrelated);
    registry.invalidate();
    const revoked = await registry.snapshot({ ...base, cwd: second });
    expect(revoked.generation).toBeGreaterThan(unrelated.generation);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit reload absorbs pending debounce and delayed duplicate notifications", async () => {
  const { root, first } = await fixture();
  const registry = new ConfigRegistry(60_000);
  const options = { cwd: first, env: {}, home: path.join(root, "home") };
  const originalTimeout = globalThis.setTimeout;
  const scheduled: Array<() => void> = [];
  const timers = spyOn(globalThis, "setTimeout");
  timers.mockImplementation(((callback: () => void, delay?: number) => {
    if (delay === 60_000) scheduled.push(callback);
    return originalTimeout(callback, delay);
  }) as typeof setTimeout);
  try {
    await registry.snapshot(options);
    await writeFile(
      path.join(first, "ast-mcp.toml"),
      "version = 2\n[telemetry]\nenabled = false\n",
    );
    await registry.reconcile();
    expect(scheduled.length).toBeGreaterThan(0);
    await registry.reload();
    const fresh = await registry.snapshot(options);
    expect(fresh.config!.telemetry.enabled).toBeFalse();
    for (const callback of scheduled) callback();
    expect(await registry.snapshot(options)).toBe(fresh);
    await registry.reconcile();
    await registry.reload();
    expect(await registry.snapshot(options)).toBe(fresh);
  } finally {
    registry.close();
    timers.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("overlapping reloads observe updates made during an earlier resolution", async () => {
  const { root, first } = await fixture();
  const registry = new ConfigRegistry(60_000);
  const options = { cwd: first, env: {}, home: path.join(root, "home") };
  const configPath = path.join(first, "ast-mcp.toml");
  const originalStat = fsPromises.stat;
  let intercept = false;
  let resume!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const metadata = spyOn(fsPromises, "stat");
  metadata.mockImplementation((async (
    ...args: Parameters<typeof fsPromises.stat>
  ) => {
    const result = await Reflect.apply(originalStat, fsPromises, args);
    if (intercept && String(args[0]) === configPath) {
      intercept = false;
      entered();
      await gate;
    }
    return result;
  }) as typeof fsPromises.stat);
  try {
    const initial = await registry.snapshot(options);
    await writeFile(configPath, "version = 2\n[telemetry]\nenabled = false\n");
    intercept = true;
    const earlier = registry.reload();
    await reached;
    await writeFile(
      configPath,
      'version = 2\n[telemetry]\nenabled = true\n[files.patch]\naider_matchers = ["exact"]\n',
    );
    const later = registry.reload();
    resume();
    await Promise.all([earlier, later]);
    const current = await registry.snapshot(options);
    expect(current.healthy).toBeTrue();
    expect(current.generation).toBeGreaterThan(initial.generation);
    expect(current.config!.telemetry.enabled).toBeTrue();
    expect(current.config!.files.patch.aiderMatchers).toEqual(["exact"]);
  } finally {
    resume();
    registry.close();
    metadata.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("reload cannot certify fingerprints newer than its parsed configuration", async () => {
  const { root, first } = await fixture();
  const registry = new ConfigRegistry(60_000);
  const options = { cwd: first, env: {}, home: path.join(root, "home") };
  const configPath = path.join(first, "ast-mcp.toml");
  const originalFile = Bun.file;
  let resume!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let intercept = false;
  let mutateEachRead = false;
  let mutations = 0;
  const files = spyOn(Bun, "file");
  files.mockImplementation(((...args: Parameters<typeof Bun.file>) => {
    const file = Reflect.apply(originalFile, Bun, args);
    if ((!intercept && !mutateEachRead) || String(args[0]) !== configPath)
      return file;
    intercept = false;
    return new Proxy(file, {
      get(target, key) {
        if (key === "text")
          return async () => {
            const parsedSource = await target.text();
            if (mutateEachRead) {
              mutations += 1;
              await writeFile(
                configPath,
                `version = 2\n#${"x".repeat(mutations)}\n`,
              );
            } else {
              entered();
              await gate;
            }
            return parsedSource;
          };
        return Reflect.get(target, key, target);
      },
    });
  }) as typeof Bun.file);
  try {
    await registry.snapshot(options);
    await writeFile(configPath, "version = 2\n[telemetry]\nenabled = false\n");
    intercept = true;
    const pending = registry.reload();
    await reached;
    await writeFile(
      configPath,
      'version = 2\n[telemetry]\nenabled = true\n[files.patch]\naider_matchers = ["exact"]\n',
    );
    resume();
    await pending;
    const current = await registry.snapshot(options);
    expect(current.healthy).toBeTrue();
    expect(current.config!.telemetry.enabled).toBeTrue();
    expect(current.config!.files.patch.aiderMatchers).toEqual(["exact"]);
    await registry.reconcile();
    await registry.reload();
    expect((await registry.snapshot(options)).generation).toBe(
      current.generation,
    );
    mutateEachRead = true;
    await registry.reload();
    expect((await registry.snapshot(options)).healthy).toBeFalse();
    expect(mutations).toBe(3);
    await expect(registry.get(options)).rejects.toThrow(
      "changed during resolution",
    );
    mutateEachRead = false;
    await registry.reload();
    expect((await registry.snapshot(options)).healthy).toBeTrue();
  } finally {
    resume();
    registry.close();
    files.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("manual reload revalidates dependency health with unchanged configuration fingerprints", async () => {
  const { root, first } = await fixture();
  const registry = new ConfigRegistry(60_000);
  const options = { cwd: first, env: {}, home: path.join(root, "home") };
  const formatter = path.join(first, "dprint.json");
  try {
    await writeFile(formatter, "{}");
    await writeFile(
      path.join(first, "ast-mcp.toml"),
      'version = 2\n[formatting]\nenabled = true\nfallback = "dprint"\n',
    );
    const initial = await registry.snapshot(options);
    expect(initial.healthy).toBeTrue();
    await writeFile(formatter, "[");
    await registry.reload();
    const invalid = await registry.snapshot(options);
    expect(invalid.fingerprints).toEqual(initial.fingerprints);
    expect(invalid.healthy).toBeFalse();
    await expect(registry.get(options)).rejects.toThrow("dprint");
    await writeFile(formatter, "{}");
    await registry.reload();
    expect((await registry.snapshot(options)).healthy).toBeTrue();
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
    const canonicalGlobal = await realpath(global);
    expect(baseline.sources.global).toBe(canonicalGlobal);
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
    expect(snapshots[0]!.config!.sources.global).toBe(canonicalGlobal);
    expect(snapshots[1]!.config!.projectRoot).toBe(homeOnly.projectRoot);
    expect(Object.keys(snapshots[1]!.fingerprints)).toContain(expectedHome);
  } finally {
    process.chdir(previousCwd);
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry retains aliased launch identity while reporting canonical configuration sources", async () => {
  const { root, first, second } = await fixture();
  const registry = new ConfigRegistry();
  const alias = path.join(root, "launch-alias");
  try {
    await symlink(
      first,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const global = path.join(
      alias,
      "relative-config",
      "ast-mcp",
      "ast-mcp.toml",
    );
    await mkdir(path.dirname(global), { recursive: true });
    await writeFile(global, "version = 2\n[telemetry]\nenabled = false\n");
    const options = {
      launchCwd: alias,
      cwd: second,
      home: "relative-home",
      clientRoots: ["."],
      env: { APPDATA: "relative-config", XDG_CONFIG_HOME: "relative-config" },
    };
    const baseline = await registry.get(options);
    const canonicalGlobal = await realpath(global);
    expect(canonicalGlobal).not.toBe(global);
    expect(baseline.sources.global).toBe(canonicalGlobal);
    expect(baseline.projectRoot).toBe(alias);
    const reloaded = await registry.reload();
    expect(reloaded[0]!.healthy).toBeTrue();
    expect(reloaded[0]!.config!.sources.global).toBe(canonicalGlobal);
    expect(reloaded[0]!.config!.projectRoot).toBe(alias);
    expect(await registry.get(options)).toBe(reloaded[0]!.config!);
    expect(Object.keys(reloaded[0]!.fingerprints)).toContain(global);
    expect(Object.keys(reloaded[0]!.fingerprints)).toContain(canonicalGlobal);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function reconciledSnapshot(
  registry: ConfigRegistry,
  options: ResolveConfigOptions,
  generation: number,
  accept: (config: Readonly<ResolvedConfig>) => boolean = () => true,
) {
  await registry.reconcile();
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const snapshot = await registry.snapshot(options);
    if (
      snapshot.generation > generation &&
      snapshot.healthy &&
      snapshot.config &&
      accept(snapshot.config)
    )
      return snapshot;
    await registry.reconcile();
    await Bun.sleep(5);
  }
  throw new Error("Registry did not reconcile a changed selection input");
}

test("registry observes prospective Claude directory selection and later configuration creation", async () => {
  const { root, first } = await fixture();
  const registry = new ConfigRegistry(1);
  const host = path.join(root, "prospective-host");
  const options = {
    launchCwd: first,
    env: { CLAUDE_PROJECT_DIR: host },
    home: path.join(root, "home"),
  };
  try {
    const initial = await registry.snapshot(options);
    expect(initial.config!.projectRoot).toBe(first);
    expect(initial.fingerprints[host]).toBe("missing");
    await mkdir(host);
    const directory = await reconciledSnapshot(
      registry,
      options,
      initial.generation,
      (config) => config.projectRoot === host,
    );
    expect(directory.healthy).toBeTrue();
    expect(directory.config!.projectRoot).toBe(host);
    expect(directory.config!.sources.project).toBeUndefined();
    const configPath = path.join(host, "ast-mcp.toml");
    await writeFile(configPath, "version = 2\n[telemetry]\nenabled = false\n");
    const configured = await reconciledSnapshot(
      registry,
      options,
      directory.generation,
      (config) => config.telemetry.enabled === false,
    );
    expect(configured.config!.sources.project).toBe(await realpath(configPath));
    expect(configured.config!.telemetry.enabled).toBeFalse();
    await rm(host, { recursive: true });
    const removed = await reconciledSnapshot(
      registry,
      options,
      configured.generation,
      (config) => config.projectRoot === first,
    );
    expect(removed.config!.projectRoot).toBe(first);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("higher priority selectors exclude prospective Claude roots from reconciliation", async () => {
  const { root, first, second } = await fixture();
  const registry = new ConfigRegistry(1);
  const host = path.join(root, "ignored-host");
  const base = {
    launchCwd: first,
    home: path.join(root, "home"),
    env: { CLAUDE_PROJECT_DIR: host },
  };
  const overrides: ResolveConfigOptions[] = [
    { ...base, cwd: second },
    { ...base, clientRoots: [second] },
    { ...base, env: { ...base.env, AST_MCP_PROJECT_ROOT: second } },
    { ...base, env: { ...base.env, AST_MCP_ROOTS: second } },
    { ...base, env: { CLAUDE_PROJECT_DIR: "relative-host" } },
  ];
  try {
    for (const options of overrides) {
      const snapshot = await registry.snapshot(options);
      expect(snapshot.healthy).toBeTrue();
      expect(snapshot.fingerprints).not.toHaveProperty(host);
      expect(snapshot.config!.projectRoot).toBe(
        options.env!.CLAUDE_PROJECT_DIR === "relative-host" ? first : second,
      );
    }
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry reconciles newly created and removed project discovery boundaries", async () => {
  const { root, first } = await fixture();
  const registry = new ConfigRegistry(1);
  const child = path.join(first, "child");
  await mkdir(child);
  const options = { cwd: child, env: {}, home: path.join(root, "home") };
  try {
    const initial = await registry.snapshot(options);
    expect(initial.config!.sources.project).toBe(
      await realpath(path.join(first, "ast-mcp.toml")),
    );
    const boundary = path.join(child, ".git");
    expect(initial.fingerprints[boundary]).toBe("missing");
    await mkdir(boundary);
    const bounded = await reconciledSnapshot(
      registry,
      options,
      initial.generation,
      (config) => config.sources.project === undefined,
    );
    expect(bounded.config!.sources.project).toBeUndefined();
    await rm(boundary, { recursive: true });
    const reopened = await reconciledSnapshot(
      registry,
      options,
      bounded.generation,
      (config) => config.sources.project === initial.config!.sources.project,
    );
    expect(reopened.config!.sources.project).toBe(
      initial.config!.sources.project,
    );
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry refreshes physical host identity when equal-metadata symlinks retarget", async () => {
  const { root, first, second } = await fixture();
  const registry = new ConfigRegistry(1);
  const host = path.join(root, "host-link");
  const options = {
    launchCwd: first,
    env: { CLAUDE_PROJECT_DIR: host },
    home: path.join(root, "home"),
  };
  try {
    const fixed = new Date("2020-01-01T00:00:00Z");
    await utimes(first, fixed, fixed);
    await utimes(second, fixed, fixed);
    const firstMetadata = await stat(first);
    const secondMetadata = await stat(second);
    expect(firstMetadata.mtimeMs).toBe(secondMetadata.mtimeMs);
    expect(firstMetadata.size).toBe(secondMetadata.size);
    await symlink(
      first,
      host,
      process.platform === "win32" ? "junction" : "dir",
    );
    const initial = await registry.snapshot(options);
    expect(initial.config!.trustedRoots).toContain(await realpath(first));
    await rm(host);
    await symlink(
      second,
      host,
      process.platform === "win32" ? "junction" : "dir",
    );
    const canonicalSecond = await realpath(second);
    const retargeted = await reconciledSnapshot(
      registry,
      options,
      initial.generation,
      (config) => config.trustedRoots.includes(canonicalSecond),
    );
    expect(retargeted.config!.projectRoot).toBe(host);
    expect(retargeted.config!.sources.project).toBe(
      await realpath(path.join(second, "ast-mcp.toml")),
    );
    expect(retargeted.config!.trustedRoots).not.toContain(
      await realpath(first),
    );
    expect(retargeted.fingerprints[host]).not.toBe(initial.fingerprints[host]);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry follows host directory type transitions with captured environment", async () => {
  const { root, first, second } = await fixture();
  const registry = new ConfigRegistry(1);
  const host = path.join(root, "host-type");
  const env = { CLAUDE_PROJECT_DIR: host };
  const options = { launchCwd: first, env, home: path.join(root, "home") };
  const original = { ...options, env: { ...env } };
  try {
    await writeFile(host, "");
    const initial = await registry.snapshot(options);
    expect(initial.config!.projectRoot).toBe(first);
    env.CLAUDE_PROJECT_DIR = second;
    await rm(host);
    await mkdir(host);
    const selected = await reconciledSnapshot(
      registry,
      original,
      initial.generation,
      (config) => config.projectRoot === host,
    );
    expect(selected.fingerprints[host]).not.toBe(initial.fingerprints[host]);
    expect(selected.fingerprints).not.toHaveProperty(second);
    await rm(host, { recursive: true });
    await writeFile(host, "");
    const fallback = await reconciledSnapshot(
      registry,
      original,
      selected.generation,
      (config) => config.projectRoot === first,
    );
    expect(fallback.fingerprints[host]).not.toBe(selected.fingerprints[host]);
    expect(fallback.config!.projectRoot).toBe(first);
    expect((await registry.snapshot(options)).config!.projectRoot).toBe(second);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("periodic reconciliation refreshes captured configuration without an explicit reconcile call", async () => {
  const { root, first } = await fixture();
  const registry = new ConfigRegistry(1, 5);
  const reconcile = spyOn(registry, "reconcile");
  const options = { cwd: first, env: {}, home: path.join(root, "home") };
  try {
    const initial = await registry.snapshot(options);
    await writeFile(
      path.join(first, "ast-mcp.toml"),
      "version = 2\n[telemetry]\nenabled = false\n",
    );
    const deadline = Date.now() + 2000;
    let current = initial;
    while (Date.now() < deadline) {
      current = await registry.snapshot(options);
      if (
        current.generation > initial.generation &&
        current.config?.telemetry.enabled === false &&
        reconcile.mock.calls.length > 0
      )
        break;
      await Bun.sleep(5);
    }
    expect(reconcile).toHaveBeenCalled();
    expect(current.healthy).toBeTrue();
    expect(current.generation).toBeGreaterThan(initial.generation);
    expect(current.config!.telemetry.enabled).toBeFalse();
  } finally {
    registry.close();
    reconcile.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry rejects invalid reloads and recovers while retaining captured identity", async () => {
  const { root, first } = await fixture();
  const registry = new ConfigRegistry();
  const options = { cwd: first, env: {}, home: path.join(root, "home") };
  try {
    const initial = await registry.snapshot(options);
    const configPath = path.join(first, "ast-mcp.toml");
    await writeFile(configPath, "version = [");
    await registry.reload();
    const invalid = await registry.snapshot(options);
    expect(invalid.healthy).toBeFalse();
    expect(invalid.error).toContain("invalid TOML");
    expect(invalid.config).toBe(initial.config);
    await expect(registry.get(options)).rejects.toThrow("invalid TOML");
    await writeFile(configPath, "version = 2\n[telemetry]\nenabled = false\n");
    await registry.reload();
    const recovered = await registry.snapshot(options);
    expect(recovered.healthy).toBeTrue();
    expect(recovered.error).toBeUndefined();
    expect(recovered.key).toBe(initial.key);
    expect(recovered.config!.telemetry.enabled).toBeFalse();
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry evicts inactive identities and safely reloads an evicted configuration", async () => {
  const { root, first, second } = await fixture();
  const registry = new ConfigRegistry(1, 30000, 1);
  const base = { env: {}, home: path.join(root, "home") };
  try {
    const initial = await registry.snapshot({ ...base, cwd: first });
    await registry.snapshot({ ...base, cwd: second });
    await writeFile(
      path.join(first, "ast-mcp.toml"),
      "version = 2\n[telemetry]\nenabled = false\n",
    );
    const replacement = await registry.snapshot({ ...base, cwd: first });
    expect(replacement.config).not.toBe(initial.config);
    expect(replacement.generation).toBe(1);
    expect(replacement.key).toBe(initial.key);
    expect(replacement.config!.telemetry.enabled).toBeFalse();
    expect(await registry.reload()).toHaveLength(1);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary child mutations and Git directory activity preserve configuration generations", async () => {
  const { root, first } = await fixture();
  const registry = new ConfigRegistry(1);
  const home = path.join(root, "home");
  const options = [
    { cwd: first, env: {}, home },
    { launchCwd: first, env: { CLAUDE_PROJECT_DIR: first }, home },
    { launchCwd: first, clientRoots: [first], env: {}, home },
  ];
  try {
    const initial = await Promise.all(
      options.map((option) => registry.snapshot(option)),
    );
    const child = path.join(first, "ordinary.txt");
    const renamed = path.join(first, "renamed.txt");
    const boundary = path.join(first, ".git");
    const verify = async () => {
      await registry.reconcile();
      // Drain watcher-triggered reconciliation and its debounce window.
      await Bun.sleep(20);
      for (const [index, option] of options.entries()) {
        const current = await registry.snapshot(option);
        expect(current.generation).toBe(initial[index]!.generation);
        expect(current.fingerprints).toEqual(initial[index]!.fingerprints);
      }
    };
    await writeFile(child, "ordinary");
    await utimes(first, new Date(1000), new Date(1000));
    await verify();
    await rename(child, renamed);
    await utimes(first, new Date(2000), new Date(2000));
    await verify();
    await rm(renamed);
    await utimes(first, new Date(3000), new Date(3000));
    await verify();
    const gitActivity = path.join(boundary, "ordinary-cache");
    await writeFile(gitActivity, "cache");
    await utimes(boundary, new Date(4000), new Date(4000));
    await verify();
    await rm(gitActivity);
    await utimes(boundary, new Date(5000), new Date(5000));
    await verify();
    await writeFile(
      path.join(first, "ast-mcp.toml"),
      "version = 2\n[telemetry]\nenabled = false\n",
    );
    for (const [index, option] of options.entries()) {
      const changed = await reconciledSnapshot(
        registry,
        option,
        initial[index]!.generation,
        (config) => config.telemetry.enabled === false,
      );
      expect(changed.generation).toBeGreaterThan(initial[index]!.generation);
    }
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Git boundary files retain content metadata in their fingerprints", async () => {
  const { root, first } = await fixture();
  const registry = new ConfigRegistry(1);
  const boundary = path.join(first, ".git");
  const options = { cwd: first, env: {}, home: path.join(root, "home") };
  try {
    await rm(boundary, { recursive: true });
    await writeFile(boundary, "gitdir: ./first-git\n");
    const initial = await registry.snapshot(options);
    await writeFile(boundary, "gitdir: ./second-longer-git\n");
    const changed = await reconciledSnapshot(
      registry,
      options,
      initial.generation,
    );
    expect(changed.fingerprints[boundary]).not.toBe(
      initial.fingerprints[boundary],
    );
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("transient realpath failures retain stat identity and reconcile after lookup recovery", async () => {
  const { root, first } = await fixture();
  const registry = new ConfigRegistry(1);
  const boundary = path.join(first, ".git");
  const options = { cwd: first, env: {}, home: path.join(root, "home") };
  const originalRealpath = fsPromises.realpath;
  const lookup = spyOn(fsPromises, "realpath");
  lookup.mockImplementation(((
    filePath: Parameters<typeof fsPromises.realpath>[0],
    options?: unknown,
  ) => {
    if (String(filePath) === boundary)
      return Promise.reject(
        Object.assign(new Error("transient lookup failure"), {
          code: "ENOENT",
        }),
      );
    return Reflect.apply(originalRealpath, fsPromises, [filePath, options]);
  }) as typeof fsPromises.realpath);
  try {
    const initial = await registry.snapshot(options);
    expect(initial.healthy).toBeTrue();
    expect(initial.fingerprints[boundary]).not.toBe("missing");
    lookup.mockRestore();
    const recovered = await reconciledSnapshot(
      registry,
      options,
      initial.generation,
    );
    expect(recovered.healthy).toBeTrue();
    expect(recovered.fingerprints[boundary]).not.toBe(
      initial.fingerprints[boundary],
    );
    expect(recovered.config!.projectRoot).toBe(first);
  } finally {
    lookup.mockRestore();
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("nonselected root identity changes refresh trust while child activity preserves generations", async () => {
  const { root, first, second } = await fixture();
  const registry = new ConfigRegistry(1);
  const third = path.join(root, "third");
  const alias = path.join(root, "nonselected");
  await mkdir(third);
  await symlink(
    second,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const base = { launchCwd: first, home: path.join(root, "home") };
  const selections: ResolveConfigOptions[] = [
    { ...base, env: {}, clientRoots: [first, alias] },
    { ...base, env: { AST_MCP_ROOTS: [first, alias].join(path.delimiter) } },
  ];
  try {
    const initial = await Promise.all(
      selections.map((options) => registry.snapshot(options)),
    );
    const child = path.join(alias, "ordinary.txt");
    await writeFile(child, "ordinary");
    await utimes(second, new Date(1000), new Date(1000));
    await registry.reconcile();
    await Bun.sleep(20);
    for (const [index, options] of selections.entries())
      expect((await registry.snapshot(options)).generation).toBe(
        initial[index]!.generation,
      );
    await rm(alias);
    await symlink(
      third,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const canonicalThird = await realpath(third);
    for (const [index, options] of selections.entries()) {
      const retargeted = await reconciledSnapshot(
        registry,
        options,
        initial[index]!.generation,
      );
      expect(retargeted.config!.projectRoot).toBe(first);
      expect(retargeted.fingerprints[alias]).not.toBe(
        initial[index]!.fingerprints[alias],
      );
      if (options.clientRoots) {
        expect(retargeted.config!.trustedRoots).toContain(canonicalThird);
        expect(retargeted.config!.trustedRoots).not.toContain(
          await realpath(second),
        );
      }
    }
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("watch events verify fingerprint changes before invalidating a configuration", async () => {
  const { root, first } = await fixture();
  const registry = new ConfigRegistry(1);
  const callbacks = new Map<
    string,
    (event: string, filename: string) => void
  >();
  const watcher = spyOn(fs, "watch");
  watcher.mockImplementation(((
    directory: string,
    callback: (event: string, filename: string) => void,
  ) => {
    callbacks.set(String(directory), callback);
    return { close() {}, unref() {} };
  }) as unknown as typeof fs.watch);
  const options = { cwd: first, env: {}, home: path.join(root, "home") };
  try {
    const initial = await registry.snapshot(options);
    const notify = callbacks.get(first)!;
    expect(notify).toBeFunction();
    await writeFile(path.join(first, ".git", "ordinary-cache"), "cache");
    notify("change", ".git");
    await Bun.sleep(20);
    expect((await registry.snapshot(options)).generation).toBe(
      initial.generation,
    );
    await writeFile(
      path.join(first, "ast-mcp.toml"),
      "version = 2\n[telemetry]\nenabled = false\n",
    );
    notify("change", "ast-mcp.toml");
    const deadline = Date.now() + 2000;
    let current = initial;
    while (Date.now() < deadline) {
      current = await registry.snapshot(options);
      if (current.generation > initial.generation) break;
      await Bun.sleep(5);
    }
    expect(current.healthy).toBeTrue();
    expect(current.generation).toBeGreaterThan(initial.generation);
    expect(current.config!.telemetry.enabled).toBeFalse();
  } finally {
    registry.close();
    watcher.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

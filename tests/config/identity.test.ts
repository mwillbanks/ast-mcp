import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  clearConfigCache,
  globalConfigPath,
  resolveConfig,
} from "../../src/config";
import {
  captureResolutionOptions,
  configurationResolutionKey,
  configurationResolutionOptions,
  configuredSelectionRoots,
  projectConfigurationPath,
} from "../../src/config/identity";
import { ConfigRegistry } from "../../src/config/registry";
import { evaluatePolicyForCheck } from "../../src/runtime/path-policy";

test("configuration identity captures ambient inputs without derived workspace identities", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-identity-")),
  );
  try {
    const checkout = path.join(root, "checkout");
    const alias = path.join(root, "alias");
    await mkdir(checkout);
    await symlink(
      checkout,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const options = {
      clientRoots: [checkout],
      cwd: checkout,
      env: {},
      home: root,
    };
    const key = configurationResolutionKey(options);
    expect(
      configurationResolutionKey({
        ...options,
        requestPaths: [alias],
        cwd: alias,
        revisionId: "revision",
        storageDomainId: "storage",
        workspaceId: "workspace",
      }),
    ).toBe(key);
    expect(
      configurationResolutionKey({
        ...options,
        launchCwd: path.join(root, "global-install"),
        cwd: undefined,
      }),
    ).toBe(key);
    expect(
      configurationResolutionKey({
        ...options,
        launchCwd: path.join(root, "local-install"),
        cwd: undefined,
      }),
    ).toBe(key);
    expect(
      configurationResolutionKey({ cwd: checkout, env: {}, home: root }),
    ).toBe(
      configurationResolutionKey({ launchCwd: checkout, env: {}, home: root }),
    );
    expect(
      configurationResolutionKey({ ...options, platform: "win32" }),
    ).not.toBe(configurationResolutionKey({ ...options, platform: "linux" }));
    expect(
      configurationResolutionKey({
        ...options,
        home: path.join(root, "other"),
      }),
    ).not.toBe(key);
    for (const env of [
      { AST_MCP_DPRINT_CONFIG: "./format.json" },
      { DPRINT_BINARY: "./bin/dprint" },
      { DPRINT_BINARY: "bin\\dprint" },
    ]) {
      expect(
        configurationResolutionKey({ ...options, env, cwd: root }),
      ).not.toBe(configurationResolutionKey({ ...options, env }));
    }
    for (const env of [
      { DPRINT_BINARY: "dprint" },
      { AST_MCP_DPRINT_CONFIG: path.join(root, "format.json") },
    ]) {
      expect(configurationResolutionKey({ ...options, env, cwd: root })).toBe(
        configurationResolutionKey({ ...options, env }),
      );
    }
    expect(
      configurationResolutionKey({
        ...options,
        clientRoots: [checkout, root],
        requestPaths: [path.join(checkout, "value")],
      }),
    ).not.toBe(
      configurationResolutionKey({
        ...options,
        clientRoots: [checkout, root],
        requestPaths: [path.join(root, "other")],
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lexical ancestor configuration selection separates physical checkout aliases", async () => {
  const parent = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-identity-sources-")),
  );
  const registry = new ConfigRegistry(60_000);
  try {
    const realParent = path.join(parent, "real");
    const aliasParent = path.join(parent, "alias");
    const checkout = path.join(realParent, "checkout");
    const alias = path.join(aliasParent, "checkout");
    await mkdir(checkout, { recursive: true });
    await mkdir(aliasParent);
    await symlink(
      checkout,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const realSource = path.join(realParent, "ast-mcp.toml");
    const aliasSource = path.join(aliasParent, "ast-mcp.toml");
    const source = (read: "allow" | "deny") =>
      `version = 2\n[[paths]]\nid = "selected"\npath = ${JSON.stringify(checkout)}\npolicies = { read = "${read}", write = "deny" }\n`;
    await writeFile(realSource, source("allow"));
    await writeFile(aliasSource, source("deny"));
    const options = (root: string) => ({
      clientRoots: [root],
      cwd: root,
      requestPaths: [root],
      env: {},
      home: parent,
    });
    const real = await registry.snapshot(options(checkout));
    const linked = await registry.snapshot(options(alias));
    expect(real.healthy, real.error).toBeTrue();
    expect(linked.healthy, linked.error).toBeTrue();
    expect(real.key).not.toBe(linked.key);
    expect(real.config!.sources.project).toBe(realSource);
    expect(linked.config!.sources.project).toBe(aliasSource);
    expect(
      (
        await evaluatePolicyForCheck(
          real.config!,
          path.join(checkout, "value"),
          "read",
        )
      ).policy,
    ).toBe("allow");
    expect(
      (
        await evaluatePolicyForCheck(
          linked.config!,
          path.join(checkout, "value"),
          "read",
        )
      ).policy,
    ).toBe("deny");

    clearConfigCache();
    const linkedResolved = await resolveConfig(options(alias));
    const realResolved = await resolveConfig(options(checkout));
    expect(linkedResolved.sources.project).toBe(aliasSource);
    expect(realResolved.sources.project).toBe(realSource);
    expect(linkedResolved).not.toBe(realResolved);
    const key = configurationResolutionKey(options(checkout));
    await writeFile(path.join(checkout, "ordinary.txt"), "child");
    await writeFile(realSource, source("deny"));
    expect(configurationResolutionKey(options(checkout))).toBe(key);
    await mkdir(path.join(checkout, ".git"));
    expect(projectConfigurationPath(checkout)).toBeUndefined();
    expect(projectConfigurationPath(alias)).toBeUndefined();
    expect(configurationResolutionKey(options(checkout))).toBe(key);
    // Distinct lexical contexts can acquire different ancestor policies later.
    expect(configurationResolutionKey(options(checkout))).not.toBe(
      configurationResolutionKey(options(alias)),
    );
    const ownSource = path.join(checkout, "ast-mcp.toml");
    await writeFile(
      ownSource,
      'version = 2\n[[paths]]\nid = "ancestor"\npath = ".."\npolicies = { read = "allow", write = "deny" }\n',
    );
    expect(projectConfigurationPath(alias)).toBe(
      path.join(alias, "ast-mcp.toml"),
    );
    expect(configurationResolutionKey(options(checkout))).toBe(key);
    expect(configurationResolutionKey(options(checkout))).not.toBe(
      configurationResolutionKey(options(alias)),
    );
    clearConfigCache();
    const realOwn = await resolveConfig(options(checkout));
    const aliasOwn = await resolveConfig(options(alias));
    expect(realOwn.sources.project).toBe(ownSource);
    expect(aliasOwn.sources.project).toBe(ownSource);
    expect(realOwn.paths[0]!.path).toBe(realParent);
    expect(aliasOwn.paths[0]!.path).toBe(aliasParent);
    const captured = configurationResolutionOptions(realOwn)!;
    captured.clientRoots!.push(alias);
    captured.env!.PORT = "4000";
    expect(configurationResolutionOptions(realOwn)!.clientRoots).toEqual([
      checkout,
    ]);
    expect(configurationResolutionOptions(realOwn)!.env).not.toHaveProperty(
      "PORT",
    );
    expect(configurationResolutionOptions({ ...realOwn })).toBeUndefined();

    const realHome = { ...options(checkout), home: checkout };
    const aliasHome = { ...options(checkout), home: alias };
    const globalSource = globalConfigPath(realHome);
    await mkdir(path.dirname(globalSource), { recursive: true });
    await writeFile(globalSource, "version = 2\n");
    expect(configurationResolutionKey(realHome)).not.toBe(
      configurationResolutionKey(aliasHome),
    );
    clearConfigCache();
    expect((await resolveConfig(realHome)).sources.global).toBe(globalSource);
    expect((await resolveConfig(aliasHome)).sources.global).toBe(globalSource);
  } finally {
    registry.close();
    clearConfigCache();
    await rm(parent, { recursive: true, force: true });
  }
});

test("selection roots and captured paths retain relative resolution and host precedence", () => {
  const cwd = path.resolve("identity-cwd");
  expect(
    configuredSelectionRoots(["trusted"], cwd, {
      AST_MCP_PROJECT_ROOT: "ignored",
    }),
  ).toEqual(["trusted"]);
  expect(
    configuredSelectionRoots([], cwd, { AST_MCP_PROJECT_ROOT: "project" }),
  ).toEqual([path.join(cwd, "project")]);
  expect(
    configuredSelectionRoots([], cwd, {
      AST_MCP_ROOTS: `first${path.delimiter}${path.delimiter}second`,
    }),
  ).toEqual([path.join(cwd, "first"), path.join(cwd, "second")]);
  expect(configuredSelectionRoots([], cwd, {})).toEqual([]);
  const env = {
    XDG_CONFIG_HOME: "xdg",
    APPDATA: "app",
    PORT: "3000",
    IGNORED: "secret",
  };
  const roots = ["relative", pathToFileURL(cwd).href];
  const paths = ["value"];
  const captured = captureResolutionOptions({
    launchCwd: cwd,
    cwd: "project",
    home: "home",
    platform: "linux",
    env,
    clientRoots: roots,
    requestPaths: paths,
  });
  env.PORT = "4000";
  roots.push("later");
  paths.push("later");
  expect(captured).toMatchObject({
    cwd: path.join(cwd, "project"),
    home: path.join(cwd, "home"),
    platform: "linux",
    clientRoots: [path.join(cwd, "relative"), cwd],
    requestPaths: ["value"],
    env: {
      XDG_CONFIG_HOME: path.join(cwd, "xdg"),
      APPDATA: path.join(cwd, "app"),
      PORT: "3000",
    },
  });
  expect(captured.env).not.toHaveProperty("IGNORED");
  const options = {
    launchCwd: cwd,
    env: { CLAUDE_PROJECT_DIR: path.resolve("host") },
  };
  expect(configurationResolutionKey(options)).not.toBe(
    configurationResolutionKey({ ...options, cwd }),
  );
  expect(captureResolutionOptions({}).platform).toBe(process.platform);
});

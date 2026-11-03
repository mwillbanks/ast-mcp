import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  captureResolutionOptions,
  configurationResolutionKey,
  configuredSelectionRoots,
} from "../../src/config/identity";

test("configuration identity captures ambient inputs without derived workspace identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-identity-"));
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
        clientRoots: [alias],
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

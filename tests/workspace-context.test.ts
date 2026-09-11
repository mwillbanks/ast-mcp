import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearConfigCache, resolveConfig, withConfig } from "../src/config.ts";
import { ConfigRegistry } from "../src/config-registry.ts";
import {
  currentWorkspace,
  discoverGitWorkspace,
  resolveStorageDomain,
  WorkspaceRegistry,
  withWorkspaceContext,
} from "../src/intelligence/workspace/index.ts";
import registerWorkspaceTools from "../src/intelligence/workspace/tools.ts";
import {
  intelligenceRoot,
  resolveWritablePath,
  rootForPath,
} from "../src/runtime/paths.ts";
import type { ConfiguredExecution } from "../src/tools/configured.ts";
import { hermeticConfig } from "./support/hermetic-config.ts";

const created: string[] = [];

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("storage placement uses one domain path per canonical repository anchor", async () => {
  const root = await temporary("ast-mcp-workspace-storage-");
  const home = path.join(root, "home");
  const repository = path.join(root, "group", "repository");
  await mkdir(repository, { recursive: true });

  const global = resolveStorageDomain(repository, { kind: "global" }, { home });
  const local = resolveStorageDomain(repository, { kind: "local" }, { home });
  const parent = resolveStorageDomain(
    repository,
    { kind: "parent", levels: 1 },
    { home },
  );
  const explicitPath = path.join(root, "explicit");
  const explicit = resolveStorageDomain(
    repository,
    { kind: "explicit", path: explicitPath },
    { home },
  );

  expect(global.storagePath).toBe(
    path.join(home, ".cache", "ast-mcp", "intelligence"),
  );
  expect(local.storagePath).toBe(
    path.join(repository, ".ast-mcp", "intelligence"),
  );
  expect(parent.storagePath).toBe(
    path.join(root, "group", ".ast-mcp", "intelligence"),
  );
  expect(explicit.storagePath).toBe(explicitPath);
});

test("registry rejects ambiguous and mismatched root selection", async () => {
  const root = await temporary("ast-mcp-workspace-roots-");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await Promise.all([
    mkdir(first, { recursive: true }),
    mkdir(second, { recursive: true }),
  ]);
  const registry = new WorkspaceRegistry();

  expect(await registry.selectDirectory([], [])).toBeUndefined();
  expect(await registry.selectDirectory([first], ["same.ts"])).toBe(
    await realpath(first),
  );
  expect(
    await registry.selectDirectory(
      [root, first],
      [path.join(first, "same.ts")],
    ),
  ).toBe(await realpath(first));
  const missingRoot = path.join(root, "missing");
  expect(await registry.selectDirectory([missingRoot], [])).toBe(missingRoot);
  expect((await discoverGitWorkspace(missingRoot)).isGit).toBe(false);
  await expect(
    registry.selectDirectory([first, second], ["same.ts"]),
  ).rejects.toMatchObject({
    code: "workspace_ambiguous",
  });
  await expect(
    registry.selectDirectory(
      [first, second],
      [path.join(first, "same.ts"), path.join(second, "same.ts")],
    ),
  ).rejects.toMatchObject({ code: "workspace_ambiguous" });
  await expect(
    registry.selectDirectory([first, second], [path.join(root, "other.ts")]),
  ).rejects.toMatchObject({ code: "workspace_mismatch" });

  await expect(
    registry.open({
      configurationGeneration: 1,
      directory: path.join(root, "missing-workspace"),
    }),
  ).rejects.toMatchObject({ code: "workspace_not_found" });

  const workspace = await registry.open({
    configurationGeneration: 1,
    directory: first,
  });
  expect(() =>
    registry.validateRequestPaths(workspace, [path.join(first, "same.ts")]),
  ).not.toThrow();
  expect(() =>
    registry.validateRequestPaths(workspace, [path.join(second, "same.ts")]),
  ).toThrow("Absolute paths must belong");
  expect(registry.request(undefined)).toEqual({});
  expect(
    registry.request({
      revision: { kind: "working" },
      workspaceId: workspace.workspaceId,
    }),
  ).toEqual({
    revision: { kind: "working" },
    workspaceId: workspace.workspaceId,
  });
  expect(registry.workspaceIds()).toEqual([workspace.workspaceId]);
  expect((await registry.status()).workspaces).toHaveLength(1);
  await expect(
    registry.get("workspace:v1:".concat("0".repeat(64))),
  ).rejects.toThrow("Unknown workspaceId");
});

test("workspace tool handlers return structured success and failure results", async () => {
  const root = await temporary("ast-mcp-workspace-tools-");
  const registry = new WorkspaceRegistry();
  const workspace = await registry.open({
    configurationGeneration: 1,
    directory: root,
  });
  type Handler = (
    input: Record<string, unknown>,
    context: unknown,
  ) => Promise<{ isError?: boolean }>;
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _definition: unknown, handler: Handler) =>
      handlers.set(name, handler),
  } as unknown as import("@modelcontextprotocol/server").McpServer;
  const execute = Object.assign(
    async <T>(_args: unknown, operation: () => Promise<T>): Promise<T> =>
      operation(),
    {
      openWorkspace: async () => workspace,
      workspaceStatus: async () => registry.status(workspace.workspaceId),
    },
  ) as ConfiguredExecution;
  registerWorkspaceTools(server, execute);
  expect(
    (await handlers.get("workspace_open")?.({ directory: root }, {}))?.isError,
  ).not.toBe(true);
  expect(
    (
      await handlers.get("workspace_status")?.(
        { workspaceId: workspace.workspaceId },
        {},
      )
    )?.isError,
  ).not.toBe(true);

  const unavailable = new Map<string, Handler>();
  registerWorkspaceTools(
    {
      registerTool: (name: string, _definition: unknown, handler: Handler) =>
        unavailable.set(name, handler),
    } as unknown as import("@modelcontextprotocol/server").McpServer,
    (async <T>(_args: unknown, operation: () => Promise<T>): Promise<T> =>
      operation()) as ConfiguredExecution,
  );
  expect(
    (await unavailable.get("workspace_open")?.({ directory: root }, {}))
      ?.isError,
  ).toBe(true);
  expect((await unavailable.get("workspace_status")?.({}, {}))?.isError).toBe(
    true,
  );
});

test("workspace context is async-local and never changes process routing state", async () => {
  const root = await temporary("ast-mcp-workspace-context-");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await Promise.all([
    mkdir(first, { recursive: true }),
    mkdir(second, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(first, "same.txt"), "first"),
    writeFile(path.join(second, "same.txt"), "second"),
  ]);
  const registry = new WorkspaceRegistry();
  const [firstWorkspace, secondWorkspace] = await Promise.all([
    registry.open({ configurationGeneration: 1, directory: first }),
    registry.open({ configurationGeneration: 1, directory: second }),
  ]);
  const beforeCwd = process.cwd();
  const beforePwd = process.env.PWD;

  const [firstPath, secondPath] = await Promise.all([
    withConfig(hermeticConfig(first), () =>
      withWorkspaceContext(firstWorkspace, async () => {
        await Bun.sleep(10);
        expect(currentWorkspace()?.workspaceId).toBe(
          firstWorkspace.workspaceId,
        );
        return resolveWritablePath("same.txt", "read");
      }),
    ),
    withConfig(hermeticConfig(second), () =>
      withWorkspaceContext(secondWorkspace, async () => {
        await Bun.sleep(1);
        expect(currentWorkspace()?.workspaceId).toBe(
          secondWorkspace.workspaceId,
        );
        return resolveWritablePath("same.txt", "read");
      }),
    ),
  ]);

  expect(firstPath).toBe(path.join(await realpath(first), "same.txt"));
  expect(secondPath).toBe(path.join(await realpath(second), "same.txt"));
  expect(process.cwd()).toBe(beforeCwd);
  expect(process.env.PWD).toBe(beforePwd);
  await withConfig(hermeticConfig(first, { AST_MCP_ALLOW_ANY_PATH: "1" }), () =>
    withWorkspaceContext(firstWorkspace, async () => {
      await expect(
        intelligenceRoot([path.join(second, "same.txt")]),
      ).rejects.toMatchObject({
        code: "workspace_mismatch",
      });
      await expect(
        rootForPath(path.join(second, "same.txt")),
      ).rejects.toMatchObject({
        code: "workspace_mismatch",
      });
      await expect(
        resolveWritablePath(path.join(second, "same.txt"), "read"),
      ).rejects.toThrow("outside configured file-operation roots");
    }),
  );
  await withConfig(
    hermeticConfig(first, { AST_MCP_ALLOW_ANY_PATH: "1" }),
    async () => {
      const unrestricted = path.join(
        path.parse(first).root,
        "ast-mcp-unrestricted",
        "same.txt",
      );
      expect(await rootForPath(unrestricted)).toBe(path.dirname(unrestricted));
    },
  );
});

test("configuration cache keys include workspace, revision, and storage identities", async () => {
  const root = await temporary("ast-mcp-workspace-config-key-");
  const registry = new ConfigRegistry(1, 60_000, 8);
  try {
    const base = hermeticConfig(root);
    const first = await registry.snapshot({
      ...base,
      revisionId: "revision:v1:".concat("1".repeat(64)),
      storageDomainId: "storage-domain:v1:".concat("2".repeat(64)),
      workspaceId: "workspace:v1:".concat("3".repeat(64)),
    });
    const second = await registry.snapshot({
      ...base,
      revisionId: "revision:v1:".concat("4".repeat(64)),
      storageDomainId: "storage-domain:v1:".concat("5".repeat(64)),
      workspaceId: "workspace:v1:".concat("6".repeat(64)),
    });
    expect(first.key).not.toBe(second.key);
    clearConfigCache();
    const firstResolved = await resolveConfig({
      ...base,
      revisionId: "revision:v1:".concat("1".repeat(64)),
      storageDomainId: "storage-domain:v1:".concat("2".repeat(64)),
      workspaceId: "workspace:v1:".concat("3".repeat(64)),
    });
    const secondResolved = await resolveConfig({
      ...base,
      revisionId: "revision:v1:".concat("4".repeat(64)),
      storageDomainId: "storage-domain:v1:".concat("5".repeat(64)),
      workspaceId: "workspace:v1:".concat("6".repeat(64)),
    });
    expect(firstResolved).not.toBe(secondResolved);
  } finally {
    registry.close();
  }
});

test("cached handles reject checkout replacement and removal", async () => {
  const parent = await temporary("ast-mcp-workspace-replacement-");
  const checkout = path.join(parent, "checkout");
  const displaced = path.join(parent, "displaced");
  await mkdir(checkout);
  const registry = new WorkspaceRegistry();
  const workspace = await registry.open({
    configurationGeneration: 1,
    directory: checkout,
  });

  await rename(checkout, displaced);
  await mkdir(checkout);
  await expect(registry.get(workspace.workspaceId)).rejects.toMatchObject({
    code: "workspace_mismatch",
  });
  await rm(checkout, { recursive: true });
  await expect(registry.get(workspace.workspaceId)).rejects.toMatchObject({
    code: "workspace_not_found",
  });
});

test("cached handles validate configuration, revision, and storage coordinates", async () => {
  const root = await temporary("ast-mcp-workspace-coordinate-drift-");
  const registry = new WorkspaceRegistry();
  const workspace = await registry.open({
    configurationGeneration: 3,
    directory: root,
  });
  await expect(
    registry.get(workspace.workspaceId, { configurationGeneration: 4 }),
  ).rejects.toMatchObject({ code: "workspace_mismatch" });
  await expect(
    registry.get(workspace.workspaceId, {
      revisionId: "revision:v1:".concat("0".repeat(64)),
    }),
  ).rejects.toMatchObject({ code: "workspace_mismatch" });
  await expect(
    registry.get(workspace.workspaceId, {
      storageDomainId: "storage-domain:v1:".concat("0".repeat(64)),
    }),
  ).rejects.toMatchObject({ code: "workspace_mismatch" });
});

test("symlink aliases canonicalize and non-Git roots remain usable", async () => {
  const root = await temporary("ast-mcp-workspace-alias-");
  const repository = path.join(root, "repository");
  const alias = path.join(root, "alias");
  await mkdir(repository);
  await symlink(repository, alias, "dir");
  const registry = new WorkspaceRegistry();
  const [direct, linked] = await Promise.all([
    registry.open({ configurationGeneration: 1, directory: repository }),
    registry.open({ configurationGeneration: 1, directory: alias }),
  ]);

  expect(direct.git.isGit).toBe(false);
  expect(linked.checkoutRoot).toBe(direct.checkoutRoot);
  expect(linked.repositoryId).toBe(direct.repositoryId);
  expect(linked.workspaceId).toBe(direct.workspaceId);
});

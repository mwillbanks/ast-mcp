import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import { clearConfigCache, currentConfig, withConfig } from "../src/config.ts";
import { withFencedFileLocks } from "../src/intelligence/mutation/locks.ts";
import {
  discoverGitWorkspace,
  WorkspaceRegistry,
  withWorkspaceContext,
} from "../src/intelligence/workspace/index.ts";
import { canonicalPathWithin } from "../src/runtime/path-utils.ts";
import { resolveWritablePath } from "../src/runtime/paths.ts";
import {
  configuredExecution,
  localExecution,
} from "../src/tools/configured.ts";
import { hermeticConfig } from "./support/hermetic-config.ts";

const created: string[] = [];
let latestRootsChangedHandler: (() => void) | undefined;

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "ast-mcp@example.com",
      GIT_AUTHOR_NAME: "ast-mcp",
      GIT_COMMITTER_EMAIL: "ast-mcp@example.com",
      GIT_COMMITTER_NAME: "ast-mcp",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

function serverForRoot(root: string): McpServer {
  return {
    server: {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({
        roots: [{ name: path.basename(root), uri: pathToFileURL(root).href }],
      }),
      setNotificationHandler: (_method: string, handler: () => void) => {
        latestRootsChangedHandler = handler;
      },
    },
  } as unknown as McpServer;
}

function serverWithoutRoots(): McpServer {
  return {
    server: {
      getClientCapabilities: () => ({}),
      setNotificationHandler: () => undefined,
    },
  } as unknown as McpServer;
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("canonical containment rejects a link that escapes a lexical root", async () => {
  const root = await temporary("ast-mcp-canonical-boundary-");
  const outside = await temporary("ast-mcp-canonical-outside-");
  const alias = path.join(root, "alias");
  await symlink(
    outside,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(
    canonicalPathWithin(root, path.join(alias, "missing.txt")),
  ).toBeFalse();
});

test.skipIf(process.platform !== "win32")(
  "Windows case aliases resolve to one native path and one file lock",
  async () => {
    const root = await temporary("ast-mcp-windows-path-identity-");
    const directory = path.join(root, "LongFolder");
    await mkdir(directory);
    const file = path.join(directory, "Value.txt");
    await writeFile(file, "value\n");
    const [first, second] = await withConfig(hermeticConfig(root), () =>
      Promise.all([
        resolveWritablePath(file),
        resolveWritablePath(file.toUpperCase()),
      ]),
    );
    expect(first.toLowerCase()).toBe(second.toLowerCase());
    expect(
      await withFencedFileLocks(
        [file, file.toUpperCase()],
        async (leases) => leases.length,
      ),
    ).toBe(1);
  },
);

test("simultaneous linked-worktree requests read and mutate only their checkout", async () => {
  const parent = await temporary("ast-mcp-workspace-concurrency-");
  const main = path.join(parent, "main");
  const linked = path.join(parent, "linked");
  await mkdir(main);
  await git(main, ["init", "-b", "main"]);
  await writeFile(path.join(main, "same.txt"), "main\n");
  await git(main, ["add", "same.txt"]);
  await git(main, ["commit", "-m", "base"]);
  await git(main, ["worktree", "add", "-b", "feature", linked]);
  await writeFile(path.join(linked, "same.txt"), "linked\n");

  const registry = new WorkspaceRegistry();
  const [mainWorkspace, linkedWorkspace] = await Promise.all([
    registry.open({ configurationGeneration: 1, directory: main }),
    registry.open({ configurationGeneration: 1, directory: linked }),
  ]);
  expect(mainWorkspace.repositoryId).toBe(linkedWorkspace.repositoryId);
  expect(mainWorkspace.storageDomain.domainId).toBe(
    linkedWorkspace.storageDomain.domainId,
  );
  expect(mainWorkspace.workspaceId).not.toBe(linkedWorkspace.workspaceId);
  const [mainLocal, linkedLocal] = await Promise.all([
    registry.open({
      configurationGeneration: 1,
      directory: main,
      storage: { kind: "local" },
    }),
    registry.open({
      configurationGeneration: 1,
      directory: linked,
      storage: { kind: "local" },
    }),
  ]);
  expect(mainLocal.storageDomain.domainId).toBe(
    linkedLocal.storageDomain.domainId,
  );
  expect(
    mainLocal.storageDomain.storagePath.startsWith(
      mainWorkspace.repositoryRoot,
    ),
  ).toBe(true);

  const [mainPath, linkedPath] = await Promise.all([
    withConfig(hermeticConfig(main), () =>
      withWorkspaceContext(mainWorkspace, async () => {
        await Bun.sleep(8);
        const target = await resolveWritablePath("same.txt", "write");
        await writeFile(target, "main-updated\n");
        return target;
      }),
    ),
    withConfig(hermeticConfig(linked), () =>
      withWorkspaceContext(linkedWorkspace, async () => {
        await Bun.sleep(1);
        const target = await resolveWritablePath("same.txt", "write");
        await writeFile(target, "linked-updated\n");
        return target;
      }),
    ),
  ]);

  expect(mainPath).toBe(path.join(mainWorkspace.checkoutRoot, "same.txt"));
  expect(linkedPath).toBe(path.join(linkedWorkspace.checkoutRoot, "same.txt"));
  expect(await readFile(mainPath, "utf8")).toBe("main-updated\n");
  expect(await readFile(linkedPath, "utf8")).toBe("linked-updated\n");
});

test("local execution preserves direct-test configuration compatibility", async () => {
  const root = await temporary("ast-mcp-workspace-local-execution-");
  expect(
    await localExecution({ filePath: path.join(root, "value.txt") }, async () =>
      currentConfig().then((config) => config.projectRoot),
    ),
  ).toBeString();
});

test("configured execution honors configured placement and explicit overrides", async () => {
  const root = await temporary("ast-mcp-workspace-storage-precedence-");
  await Promise.all([
    mkdir(path.join(root, ".git")),
    writeFile(
      path.join(root, "ast-mcp.toml"),
      [
        "version = 2",
        "[intelligence.storage.placement]",
        'kind = "local"',
        "[[paths]]",
        'id = "workspace"',
        'path = "."',
        'policies = { read = "allow", write = "allow", delete = "deny" }',
        "",
      ].join("\n"),
    ),
  ]);
  clearConfigCache();
  const execute = configuredExecution(serverForRoot(root));
  const configured = await execute.openWorkspace?.({ directory: root });
  expect(configured?.storageDomain.placement).toEqual({ kind: "local" });
  const explicit = await execute.openWorkspace?.({
    directory: root,
    storage: { kind: "global" },
  });
  expect(explicit?.storageDomain.placement).toEqual({ kind: "global" });
});

test("configured execution reopens when configuration changes during discovery", async () => {
  const root = await temporary("ast-mcp-workspace-generation-race-");
  const originalOpen = WorkspaceRegistry.prototype.open;
  let opens = 0;
  WorkspaceRegistry.prototype.open = async function (options) {
    const workspace = await originalOpen.call(this, options);
    opens += 1;
    return opens === 1
      ? {
          ...workspace,
          configurationGeneration: workspace.configurationGeneration + 1,
        }
      : workspace;
  };
  try {
    const execute = configuredExecution(serverForRoot(root));
    expect(await execute.clientRoots?.()).toHaveLength(1);
    expect(await execute.clientRoots?.()).toHaveLength(1);
    execute.refreshRoots?.();
    expect(await execute.clientRoots?.()).toHaveLength(1);
    const workspace = await execute.openWorkspace?.({ directory: root });
    expect(opens).toBe(2);
    expect(workspace?.checkoutRoot).toBe(await realpath(root));
    latestRootsChangedHandler?.();
    expect(await execute.clientRoots?.()).toHaveLength(1);
    try {
      expect(
        (await execute.workspaceStatus?.(workspace?.workspaceId))?.selected
          ?.workspaceId,
      ).toBe(workspace?.workspaceId);
      expect((await execute.workspaceStatus?.())?.workspaces).toHaveLength(1);
    } catch (error) {
      expect(error).toMatchObject({ code: "workspace_mismatch" });
    }
  } finally {
    WorkspaceRegistry.prototype.open = originalOpen;
  }
});

test("workspace_open without client roots uses explicit v2 host authorization", async () => {
  const originalCwd = process.cwd();
  const host = await temporary("ast-mcp-workspace-host-");
  const unauthorized = await temporary("ast-mcp-workspace-unauthorized-");
  await Promise.all([
    mkdir(path.join(host, ".git")),
    writeFile(
      path.join(host, "ast-mcp.toml"),
      [
        "version = 2",
        "[workspace]",
        'roots = ["."]',
        "[[paths]]",
        'id = "workspace"',
        'path = "."',
        'policies = { read = "allow", write = "allow", delete = "deny" }',
        "",
      ].join("\n"),
    ),
  ]);

  process.chdir(host);
  clearConfigCache();
  try {
    const execute = configuredExecution(serverWithoutRoots());
    const configuredRoot = await execute(
      {},
      async () => (await currentConfig()).projectRoot,
    );
    expect(await realpath(configuredRoot)).toBe(await realpath(host));
    await expect(
      execute.openWorkspace?.({ directory: unauthorized }),
    ).rejects.toMatchObject({ code: "path_denied" });

    const local = await execute.openWorkspace?.({ directory: host });
    expect(local?.checkoutRoot).toBe(await realpath(host));
  } finally {
    process.chdir(originalCwd);
    clearConfigCache();
  }
});

test("workspace_open without client roots preserves explicit v1 temp authorization", async () => {
  const originalCwd = process.cwd();
  const host = await temporary("ast-mcp-workspace-v1-host-");
  const authorized = await temporary("ast-mcp-workspace-v1-authorized-");
  await Promise.all([
    mkdir(path.join(host, ".git")),
    mkdir(path.join(authorized, ".git")),
    writeFile(
      path.join(host, "ast-mcp.toml"),
      "version = 1\n[safety]\nallow_temp_directory = true\n",
    ),
    writeFile(path.join(authorized, "ast-mcp.toml"), "version = 1\n"),
  ]);

  process.chdir(host);
  clearConfigCache();
  try {
    const execute = configuredExecution(serverWithoutRoots());
    const workspace = await execute.openWorkspace?.({ directory: authorized });
    expect(workspace?.checkoutRoot).toBe(await realpath(authorized));
  } finally {
    process.chdir(originalCwd);
    clearConfigCache();
  }
});

test("distinct server sessions bind concurrent relative requests independently", async () => {
  const root = await temporary("ast-mcp-workspace-sessions-");
  const firstRoot = path.join(root, "first");
  const secondRoot = path.join(root, "second");
  await Promise.all([
    mkdir(firstRoot, { recursive: true }),
    mkdir(secondRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(firstRoot, "same.txt"), "first\n"),
    writeFile(path.join(secondRoot, "same.txt"), "second\n"),
  ]);
  const first = configuredExecution(serverForRoot(firstRoot));
  const second = configuredExecution(serverForRoot(secondRoot));

  const [firstPath, secondPath] = await Promise.all([
    first({ filePath: "same.txt" }, () =>
      resolveWritablePath("same.txt", "read"),
    ),
    second({ filePath: "same.txt" }, () =>
      resolveWritablePath("same.txt", "read"),
    ),
  ]);

  expect(await readFile(firstPath, "utf8")).toBe("first\n");
  expect(await readFile(secondPath, "utf8")).toBe("second\n");
  expect(firstPath).not.toBe(secondPath);
});

test("moved worktrees and separate Git directories retain explicit identity", async () => {
  const parent = await temporary("ast-mcp-workspace-moved-");
  const main = path.join(parent, "main");
  const initial = path.join(parent, "initial");
  const moved = path.join(parent, "moved");
  await mkdir(main);
  await git(main, ["init", "-b", "main"]);
  await writeFile(path.join(main, "value.txt"), "value\n");
  await git(main, ["add", "."]);
  await git(main, ["commit", "-m", "base"]);
  await git(main, ["worktree", "add", "-b", "moved-branch", initial]);
  const registry = new WorkspaceRegistry();
  const initialWorkspace = await registry.open({
    configurationGeneration: 1,
    directory: initial,
  });
  await git(main, ["worktree", "move", initial, moved]);
  await expect(
    registry.get(initialWorkspace.workspaceId),
  ).rejects.toMatchObject({
    code: "workspace_not_found",
  });
  const movedIdentity = await discoverGitWorkspace(moved);
  expect(path.basename(movedIdentity.checkoutRoot)).toBe("moved");
  expect(movedIdentity.isLinkedWorktree).toBe(true);

  const separateWork = path.join(parent, "separate-work");
  const separateGit = path.join(parent, "separate-metadata");
  await mkdir(separateWork);
  await git(separateWork, ["init", "--separate-git-dir", separateGit]);
  const separateIdentity = await discoverGitWorkspace(separateWork);
  expect(path.basename(separateIdentity.checkoutRoot)).toBe("separate-work");
  expect(path.basename(separateIdentity.commonGitDirectory ?? "")).toBe(
    "separate-metadata",
  );
  expect(separateIdentity.repositoryRoot).toBe(separateIdentity.checkoutRoot);
});

test("nested and moved standalone repositories receive explicit identities", async () => {
  const parent = await temporary("ast-mcp-workspace-nested-");
  const outer = path.join(parent, "outer");
  const nested = path.join(outer, "nested");
  await mkdir(nested, { recursive: true });
  await git(outer, ["init", "-b", "main"]);
  await writeFile(path.join(outer, "outer.txt"), "outer\n");
  await git(outer, ["add", "."]);
  await git(outer, ["commit", "-m", "outer"]);
  await git(nested, ["init", "-b", "main"]);
  await writeFile(path.join(nested, "nested.txt"), "nested\n");
  await git(nested, ["add", "."]);
  await git(nested, ["commit", "-m", "nested"]);

  const registry = new WorkspaceRegistry();
  const [outerWorkspace, nestedWorkspace] = await Promise.all([
    registry.open({ configurationGeneration: 1, directory: outer }),
    registry.open({ configurationGeneration: 1, directory: nested }),
  ]);
  expect(outerWorkspace.repositoryId).not.toBe(nestedWorkspace.repositoryId);

  const movedParent = path.join(parent, "renamed");
  await rename(nested, movedParent);
  const moved = await registry.open({
    configurationGeneration: 1,
    directory: movedParent,
  });
  expect(moved.repositoryId).not.toBe(nestedWorkspace.repositoryId);

  const component = path.join(parent, "component");
  await mkdir(component);
  await git(component, ["init", "-b", "main"]);
  await writeFile(path.join(component, "component.txt"), "component\n");
  await git(component, ["add", "."]);
  await git(component, ["commit", "-m", "component"]);
  await git(outer, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    component,
    "submodule",
  ]);
  const submodule = await registry.open({
    configurationGeneration: 1,
    directory: path.join(outer, "submodule"),
  });
  expect(submodule.repositoryId).not.toBe(outerWorkspace.repositoryId);
  expect(submodule.git.commonGitDirectory).toContain(
    path.join(".git", "modules", "submodule"),
  );
});

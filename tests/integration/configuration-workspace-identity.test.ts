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

import { configRegistry } from "../../src/config/registry";
import type {
  RevisionSelector,
  StoragePlacement,
} from "../../src/intelligence/contracts";
import { WorkspaceRegistry } from "../../src/intelligence/workspace";
import { applyConfigCore } from "../../src/runtime/config-write";
import { hashFilesSafely, readFileSafely } from "../../src/runtime/file-read";
import { sha256 } from "../../src/runtime/hash";
import registerConfigurationTools from "../../src/tools/configuration";
import {
  type ConfiguredExecution,
  configuredExecution,
  type ExecutionOptions,
} from "../../src/tools/configured";

function executor(roots?: string[], options: ExecutionOptions = {}) {
  return configuredExecution(
    {
      server: {
        getClientCapabilities: () => (roots ? { roots: {} } : {}),
        listRoots: async () => ({
          roots:
            roots?.map((root) => ({ uri: pathToFileURL(root).href })) ?? [],
        }),
        setNotificationHandler: () => {},
      },
    } as never,
    undefined,
    options,
  );
}

async function git(cwd: string, args: string[]) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ast-mcp",
      GIT_AUTHOR_EMAIL: "ast-mcp@example.com",
      GIT_COMMITTER_NAME: "ast-mcp",
      GIT_COMMITTER_EMAIL: "ast-mcp@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

interface RepositoryFixture {
  parent: string;
  root: string;
  oid: string;
}

async function withRepository(
  operation: (fixture: RepositoryFixture) => Promise<void>,
): Promise<void> {
  const originalCwd = process.cwd();
  const parent = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-config-workspace-")),
  );
  const root = path.join(parent, "checkout");
  try {
    await mkdir(root);
    await git(root, ["init", "-b", "main"]);
    await writeFile(
      path.join(root, "ast-mcp.toml"),
      "version = 2\n[formatting]\nenabled = false\n",
    );
    await writeFile(path.join(root, "value.txt"), "base\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "base"]);
    const oid = await git(root, ["rev-parse", "HEAD"]);
    process.chdir(root);
    await operation({ parent, root, oid });
  } finally {
    try {
      process.chdir(originalCwd);
    } finally {
      await configRegistry.close();
      await rm(parent, { recursive: true, force: true });
    }
  }
}

for (const rootsEnabled of [false, true]) {
  for (const storageKind of [
    "global",
    "local",
    "parent",
    "explicit",
  ] as const) {
    for (const revisionKind of ["working", "commit"] as const) {
      test(`uneven configuration history preserves open/status/hash/reopen with roots ${rootsEnabled ? "enabled" : "disabled"}, ${storageKind} storage, and ${revisionKind} revision`, async () => {
        await withRepository(async ({ parent, root, oid }) => {
          const roots = rootsEnabled ? [root] : undefined;
          const execute = executor(roots);
          const first = await execute.openWorkspace!({ directory: root });
          const options = {
            clientRoots: roots,
            cwd: root,
            requestPaths: [root],
            revisionId: first.selectedRevision.revisionId,
            storageDomainId: first.storageDomain.domainId,
            workspaceId: first.workspaceId,
          };
          // Populate the former derived-ID cache and advance its history unevenly.
          await configRegistry.get(options);
          for (let round = 0; round < 3; round++) {
            configRegistry.invalidate();
            await configRegistry.get(options);
          }
          await expect(
            execute.workspaceStatus!(first.workspaceId),
          ).rejects.toMatchObject({ code: "workspace_mismatch" });

          const storage: StoragePlacement =
            storageKind === "explicit"
              ? { kind: storageKind, path: path.join(parent, "storage") }
              : storageKind === "parent"
                ? { kind: storageKind, levels: 1 }
                : { kind: storageKind };
          const revision: RevisionSelector =
            revisionKind === "commit"
              ? { kind: revisionKind, oid }
              : { kind: revisionKind };
          const workspace = await execute.openWorkspace!({
            directory: root,
            revision,
            storage,
          });
          expect(
            (await execute.workspaceStatus!(workspace.workspaceId)).selected
              ?.workspaceId,
          ).toBe(workspace.workspaceId);
          const [hash] = await execute(
            { workspaceId: workspace.workspaceId, filePaths: ["value.txt"] },
            () => hashFilesSafely(["value.txt"]),
            undefined,
            "file_hash",
          );
          expect(hash?.sha256).toBe(sha256("base\n"));
          const read = await execute(
            { workspaceId: workspace.workspaceId, filePath: "value.txt" },
            () =>
              readFileSafely(
                {
                  filePath: "value.txt",
                  mode: "text",
                  maxBytes: 64,
                  lines: [0, 2],
                },
                { timeoutMs: 2000 },
              ),
            undefined,
            "file_read",
          );
          expect(read.content).toBe("base\n");
          const same = await execute.openWorkspace!({
            directory: root,
            revision,
            storage,
          });
          expect(same.workspaceId).toBe(workspace.workspaceId);
          expect(same.configurationGeneration).toBe(
            workspace.configurationGeneration,
          );
        });
      });
    }
  }
}

type StatusResult = {
  isError?: boolean;
  structuredContent?: {
    data?: {
      generation: number;
      projectRoot: string;
      sources: { project?: string };
      selectedWorkspace: { workspaceId: string };
    };
    error?: { code: string };
  };
};

async function workspaceConfigurationStatus(
  execute: ConfiguredExecution,
  workspaceId: string,
): Promise<StatusResult> {
  let handler:
    | ((args: { workspaceId: string }) => Promise<StatusResult>)
    | undefined;
  registerConfigurationTools(
    {
      registerTool(
        name: string,
        _definition: unknown,
        callback: typeof handler,
      ) {
        if (name === "config_status") handler = callback;
      },
    } as never,
    execute,
  );
  return handler!({ workspaceId });
}

const selectorEnvironmentNames = [
  "AST_MCP_PROJECT_ROOT",
  "AST_MCP_ROOTS",
  "CLAUDE_PROJECT_DIR",
  "AST_MCP_EMBEDDING_MODEL",
] as const;

async function withSelectorEnvironment(
  operation: () => Promise<void>,
): Promise<void> {
  const previous = selectorEnvironmentNames.map(
    (name) => [name, process.env[name]] as const,
  );
  for (const name of selectorEnvironmentNames) delete process.env[name];
  try {
    await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

for (const selection of [
  "absent",
  "project-environment",
  "roots-environment",
  "ancestor",
] as const) {
  test(`config_status retains workspace_open configuration with ${selection} roots`, async () => {
    await withSelectorEnvironment(() =>
      withRepository(async ({ parent, root }) => {
        if (selection === "project-environment")
          process.env.AST_MCP_PROJECT_ROOT = root;
        if (selection === "roots-environment") process.env.AST_MCP_ROOTS = root;
        const roots = selection === "ancestor" ? [parent] : undefined;
        const execute = executor(roots);
        const workspace = await execute.openWorkspace!({ directory: root });
        const expected = await configRegistry.get({
          clientRoots: roots,
          cwd: root,
          requestPaths: [root],
        });
        const status = await workspaceConfigurationStatus(
          execute,
          workspace.workspaceId,
        );
        expect(status.isError).not.toBeTrue();
        expect(status.structuredContent?.data?.generation).toBe(
          workspace.configurationGeneration,
        );
        expect(status.structuredContent?.data?.projectRoot).toBe(
          expected.projectRoot,
        );
        expect(status.structuredContent?.data?.sources).toEqual(
          expected.sources,
        );
        expect(
          status.structuredContent?.data?.selectedWorkspace.workspaceId,
        ).toBe(workspace.workspaceId);
        process.env.AST_MCP_EMBEDDING_MODEL = "changed/model";
        const stale = await workspaceConfigurationStatus(
          execute,
          workspace.workspaceId,
        );
        expect(stale.structuredContent?.error?.code).toBe("workspace_mismatch");
      }),
    );
  });
}

test("workspace configuration edits report the selected context generation", async () => {
  await withSelectorEnvironment(() =>
    withRepository(async ({ root }) => {
      await writeFile(
        path.join(root, "ast-mcp.toml"),
        "version = 2\n[mcp.configuration]\nrequire_approval = false\n",
      );
      const decoyOptions = {
        clientRoots: [root],
        cwd: root,
        requestPaths: [root],
      };
      await configRegistry.snapshot(decoyOptions);
      const execute = executor();
      const workspace = await execute.openWorkspace!({ directory: root });
      const result = await execute(
        { workspaceId: workspace.workspaceId },
        () => applyConfigCore({ http: { port: 4324 } }),
        undefined,
        "config_core",
      );
      const intended = await configRegistry.snapshot({
        cwd: root,
        requestPaths: [root],
      });
      const decoy = await configRegistry.snapshot(decoyOptions);
      expect(result.generation).toBe(intended.generation);
      expect(result.generation).not.toBe(decoy.generation);
      expect(intended.config?.http.port).toBe(4324);
    }),
  );
});

test("configuration snapshots reject invalidation after workspace operation dispatch", async () => {
  await withSelectorEnvironment(() =>
    withRepository(async ({ root }) => {
      const execute = executor([root]);
      const workspace = await execute.openWorkspace!({ directory: root });
      await expect(
        execute(
          { workspaceId: workspace.workspaceId },
          async () => {
            configRegistry.invalidate();
            await configRegistry.get({
              clientRoots: [root],
              cwd: root,
              requestPaths: [root],
            });
            return execute.configurationSnapshot!();
          },
          undefined,
          "config_status",
        ),
      ).rejects.toMatchObject({ code: "workspace_mismatch" });
    }),
  );
});

test("workspace execution and config_status retain lexical opening configuration", async () => {
  await withSelectorEnvironment(async () => {
    const parent = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "ast-mcp-workspace-lexical-")),
    );
    const originalCwd = process.cwd();
    try {
      const realParent = path.join(parent, "real");
      const aliasParent = path.join(parent, "alias");
      const root = path.join(realParent, "checkout");
      const alias = path.join(aliasParent, "checkout");
      await mkdir(root, { recursive: true });
      await mkdir(aliasParent);
      await symlink(
        root,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      await writeFile(
        path.join(realParent, "ast-mcp.toml"),
        "version = 2\n[formatting]\nfallback = 'reject'\n",
      );
      const aliasSource = path.join(aliasParent, "ast-mcp.toml");
      await writeFile(
        aliasSource,
        "version = 2\n[formatting]\nfallback = 'preserve'\n",
      );
      await writeFile(path.join(root, "value.txt"), "base\n");
      process.chdir(root);
      const workspaceRegistry = new WorkspaceRegistry();
      const opening = executor(undefined, {
        workspaceRegistry,
        requestScoped: true,
      });
      const workspace = await opening.openWorkspace!({ directory: alias });
      // Modern HTTP builds a new configured execution for each request.
      const execute = executor(undefined, {
        workspaceRegistry,
        requestScoped: true,
      });
      await expect(
        executor(undefined, {
          workspaceRegistry: new WorkspaceRegistry(),
          requestScoped: true,
        }).workspaceStatus!(workspace.workspaceId),
      ).rejects.toMatchObject({ code: "workspace_not_found" });
      expect(
        (await execute.workspaceStatus!(workspace.workspaceId)).selected
          ?.workspaceId,
      ).toBe(workspace.workspaceId);
      const status = await workspaceConfigurationStatus(
        execute,
        workspace.workspaceId,
      );
      expect(status.isError).not.toBeTrue();
      expect(status.structuredContent?.data?.sources.project).toBe(aliasSource);
      expect(status.structuredContent?.data?.generation).toBe(
        workspace.configurationGeneration,
      );
      const [hash] = await executor(undefined, {
        workspaceRegistry,
        requestScoped: true,
      })(
        { workspaceId: workspace.workspaceId, filePaths: ["value.txt"] },
        () => hashFilesSafely(["value.txt"]),
        undefined,
        "file_hash",
      );
      expect(hash?.sha256).toBe(sha256("base\n"));
      const result = await executor(undefined, {
        workspaceRegistry,
        requestScoped: true,
      })(
        { workspaceId: workspace.workspaceId, filePath: "value.txt" },
        () =>
          readFileSafely({ filePath: "value.txt", mode: "text", maxBytes: 64 }),
        undefined,
        "file_read",
      );
      expect(result.content).toBe("base\n");
    } finally {
      try {
        process.chdir(originalCwd);
      } finally {
        await configRegistry.close();
        await rm(parent, { recursive: true, force: true });
      }
    }
  });
});

test("concurrent canonical and alias opens share configuration and workspace identity", async () => {
  await withRepository(async ({ parent, root }) => {
    const alias = path.join(parent, "alias");
    await symlink(
      root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const execute = executor([root]);
    const opened = await Promise.all(
      [root, alias].map((directory) => execute.openWorkspace!({ directory })),
    );
    expect(opened[0]!.workspaceId).toBe(opened[1]!.workspaceId);
    expect(opened[0]!.configurationGeneration).toBe(
      opened[1]!.configurationGeneration,
    );
  });
});

test("linked worktrees retain distinct checkout and configuration identities", async () => {
  await withRepository(async ({ parent, root }) => {
    const opened = await executor([root]).openWorkspace!({ directory: root });
    const worktree = path.join(parent, "worktree");
    await git(root, ["worktree", "add", "-b", "linked", worktree]);
    const linked = await executor([worktree]).openWorkspace!({
      directory: worktree,
    });
    expect(linked.checkoutRoot).not.toBe(opened.checkoutRoot);
    expect(linked.configurationGeneration).not.toBe(
      opened.configurationGeneration,
    );
  });
});

test("removed and restored configuration never revives an old workspace handle", async () => {
  await withRepository(async ({ root }) => {
    const execute = executor([root]);
    const options = { clientRoots: [root], cwd: root, requestPaths: [root] };
    const original = await execute.openWorkspace!({ directory: root });
    const initial = await configRegistry.snapshot(options);
    const source = path.join(root, "ast-mcp.toml");
    await rm(source);
    await configRegistry.reload();
    const removed = await configRegistry.snapshot(options);
    expect(removed.healthy, removed.error).toBeTrue();
    expect(removed.key).toBe(initial.key);
    expect(removed.generation).toBeGreaterThan(initial.generation);
    expect(removed.config!.sources.project).toBeUndefined();
    await expect(
      execute.workspaceStatus!(original.workspaceId),
    ).rejects.toMatchObject({
      code: "workspace_mismatch",
    });

    await writeFile(source, "version = 2\n[formatting]\nenabled = false\n");
    await configRegistry.reload();
    const restored = await configRegistry.snapshot(options);
    expect(restored.healthy, restored.error).toBeTrue();
    expect(restored.key).toBe(initial.key);
    expect(restored.config!.sources.project).toBe(
      initial.config!.sources.project,
    );
    expect(restored.generation).toBeGreaterThan(removed.generation);
    await expect(
      execute.workspaceStatus!(original.workspaceId),
    ).rejects.toMatchObject({
      code: "workspace_mismatch",
    });
    const reopened = await execute.openWorkspace!({ directory: root });
    expect(reopened.configurationGeneration).toBe(restored.generation);
    expect(
      (await execute.workspaceStatus!(reopened.workspaceId)).selected
        ?.workspaceId,
    ).toBe(reopened.workspaceId);
  });
});

test("configuration drift invalidates an opened workspace handle", async () => {
  await withRepository(async ({ root }) => {
    const execute = executor([root]);
    const opened = await execute.openWorkspace!({ directory: root });
    await writeFile(
      path.join(root, "ast-mcp.toml"),
      "version = 2\n[formatting]\nenabled = false\n[telemetry]\nenabled = false\n",
    );
    await configRegistry.reconcile();
    await configRegistry.reload();
    const changed = await configRegistry.get({
      clientRoots: [root],
      cwd: root,
      requestPaths: [root],
    });
    expect(changed.generation).toBeGreaterThan(opened.configurationGeneration);
    await expect(
      execute.workspaceStatus!(opened.workspaceId),
    ).rejects.toMatchObject({ code: "workspace_mismatch" });
  });
});

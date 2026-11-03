import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { configRegistry } from "../../src/config/registry";
import type { StoragePlacement } from "../../src/intelligence/contracts";
import { hashFilesSafely } from "../../src/runtime/file-read";
import { sha256 } from "../../src/runtime/hash";
import { configuredExecution } from "../../src/tools/configured";

function executor(roots?: string[]) {
  return configuredExecution({
    server: {
      getClientCapabilities: () => (roots ? { roots: {} } : {}),
      listRoots: async () => ({
        roots: roots?.map((root) => ({ uri: pathToFileURL(root).href })) ?? [],
      }),
      setNotificationHandler: () => {},
    },
  } as never);
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

test("uneven configuration histories preserve open, status, and hash across revisions and storage", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-config-workspace-"),
  );
  const root = path.join(parent, "checkout");
  const originalCwd = process.cwd();
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
    const placements: StoragePlacement[] = [
      { kind: "global" },
      { kind: "local" },
      { kind: "parent", levels: 1 },
      { kind: "explicit", path: path.join(parent, "storage") },
    ];
    for (const roots of [undefined, [root]]) {
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
      for (const storage of placements) {
        for (const revision of [
          { kind: "working" as const },
          { kind: "commit" as const, oid },
        ]) {
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
          const same = await execute.openWorkspace!({
            directory: root,
            revision,
            storage,
          });
          expect(same.workspaceId).toBe(workspace.workspaceId);
          expect(same.configurationGeneration).toBe(
            workspace.configurationGeneration,
          );
        }
      }
    }
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
    const worktree = path.join(parent, "worktree");
    await git(root, ["worktree", "add", "-b", "linked", worktree]);
    const linked = await executor([worktree]).openWorkspace!({
      directory: worktree,
    });
    expect(linked.checkoutRoot).not.toBe(opened[0]!.checkoutRoot);
    expect(linked.configurationGeneration).not.toBe(
      opened[0]!.configurationGeneration,
    );
    await writeFile(
      path.join(root, "ast-mcp.toml"),
      "version = 2\n[formatting]\nenabled = false\n[telemetry]\nenabled = false\n",
    );
    await configRegistry.reconcile();
    await configRegistry.get({
      clientRoots: [root],
      cwd: root,
      requestPaths: [root],
    });
    await expect(
      execute.workspaceStatus!(opened[0]!.workspaceId),
    ).rejects.toMatchObject({ code: "workspace_mismatch" });
  } finally {
    process.chdir(originalCwd);
    await rm(parent, { recursive: true, force: true });
  }
});

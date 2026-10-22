import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverGitWorkspace,
  gitIndexFingerprint,
  gitDirtyOverlayId,
  runGitRaw,
  WorkspaceRegistry,
} from "../../../src/intelligence/workspace/index.ts";

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-workspace-validation-"),
  );
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("registry rejects relative and file roots and detects checkout replacement", async () => {
  const root = await temporary();
  const registry = new WorkspaceRegistry();
  await expect(
    registry.open({ configurationGeneration: 1, directory: "." }),
  ).rejects.toMatchObject({ code: "workspace_mismatch" });
  const file = path.join(root, "file");
  await writeFile(file, "original");
  await expect(
    registry.open({ configurationGeneration: 1, directory: file }),
  ).rejects.toMatchObject({ code: "workspace_not_found" });
  const checkout = path.join(root, "checkout");
  await mkdir(checkout);
  const workspace = await registry.open({
    configurationGeneration: 1,
    directory: checkout,
  });
  await rename(checkout, path.join(root, "retained"));
  await writeFile(checkout, "replacement");
  await expect(registry.get(workspace.workspaceId)).rejects.toMatchObject({
    code: "workspace_not_found",
  });
  expect(await registry.workspaceIds()).toEqual([workspace.workspaceId]);
});

test("Git operations reject cancellation and bounded output without returning truncated bytes", async () => {
  const root = await temporary();
  await expect(
    runGitRaw(root, ["--version"], AbortSignal.abort("cancelled")),
  ).rejects.toThrow("Git operation was aborted");
  await expect(
    runGitRaw(root, ["--version"], undefined, undefined, 1),
  ).rejects.toMatchObject({ code: "git_output_limit_exceeded" });
  expect((await runGitRaw(root, ["--version"])).code).toBe(0);
});

test.skipIf(process.platform === "win32")(
  "index and working identities track symbolic link targets",
  async () => {
    const root = await temporary();
    expect((await runGitRaw(root, ["init"])).code).toBe(0);
    const link = path.join(root, "intent-link");
    await symlink("first-target", link);
    await writeFile(path.join(root, "other-intent"), "pending bytes");
    expect(
      (
        await runGitRaw(root, [
          "add",
          "--intent-to-add",
          "intent-link",
          "other-intent",
        ])
      ).code,
    ).toBe(0);
    const git = await discoverGitWorkspace(root);
    const first = await gitIndexFingerprint(git);
    const workspace = await new WorkspaceRegistry().open({
      configurationGeneration: 1,
      directory: root,
    });
    const overlay = () =>
      gitDirtyOverlayId(
        git,
        workspace.repositoryId,
        workspace.selectedRevision.revisionId,
      );
    const working = await overlay();
    await rm(link);
    await symlink("second-target", link);
    expect(await gitIndexFingerprint(git)).not.toBe(first);
    expect(await overlay()).not.toBe(working);
  },
);

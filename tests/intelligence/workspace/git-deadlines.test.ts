import { beforeEach, expect, spyOn, test } from "bun:test";

import { createMockTime } from "../../support/mock-time.ts";
beforeEach(() => {
  createMockTime();
});
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverGitWorkspace,
  gitDirtyOverlayId,
  gitWorkingState,
  runGitRaw,
  withWorkspaceGitContext,
} from "../../../src/intelligence/workspace/git.ts";

test("an expired Git context rejects before spawning a process", async () => {
  const spawn = spyOn(Bun, "spawn");
  try {
    await expect(
      withWorkspaceGitContext({ timeoutMs: 0 }, () =>
        runGitRaw(process.cwd(), ["status"]),
      ),
    ).rejects.toMatchObject({ code: "workspace_git_failure" });
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});

test("persistent guard databases do not change workspace state or overlays", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-guard-state-"));
  try {
    expect((await runGitRaw(root, ["init"])).code).toBe(0);
    const git = await discoverGitWorkspace(root);
    for (const name of [
      ".value.ts.ast-mcp.lock",
      ".value.ts.ast-mcp.lock.pending-00000000-0000-4000-8000-000000000000",
      ".value.ts.ast-mcp.lock.stale-00000000-0000-4000-8000-000000000000",
      ".value.ts.ast-mcp.lock.sqlite",
      ".value.ts.ast-mcp.lock.sqlite-journal",
      ".ast-mcp-checkout.lock.sqlite",
      ".ast-mcp-storage-writer.sqlite-wal",
      ".ast-mcp-export.lock.sqlite-shm",
    ])
      await writeFile(path.join(root, name), "internal");
    expect(await gitWorkingState(git)).toMatchObject({
      dirty: false,
      untracked: false,
    });
    expect(
      await gitDirtyOverlayId(
        git,
        "repository:v1:" + "a".repeat(64),
        "revision:v1:" + "b".repeat(64),
      ),
    ).toBeNull();
    await writeFile(
      path.join(root, ".ast-mcp.locknotes.ts"),
      "export const userFile = true;",
    );
    expect(await gitWorkingState(git)).toMatchObject({
      dirty: true,
      untracked: true,
    });
    expect(
      await gitDirtyOverlayId(
        git,
        "repository:v1:" + "a".repeat(64),
        "revision:v1:" + "b".repeat(64),
      ),
    ).not.toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

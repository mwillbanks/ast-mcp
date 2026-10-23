import { expect, spyOn, test } from "bun:test";

import {
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

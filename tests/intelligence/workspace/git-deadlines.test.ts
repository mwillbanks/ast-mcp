import { expect, spyOn, test } from "bun:test";

import {
  runGitRaw,
  withWorkspaceGitContext,
} from "../../../src/intelligence/workspace/git.ts";

test.each(["deadline", "abort"] as const)(
  "Git context %s terminates and joins the child",
  async (kind) => {
    const original = Bun.spawn;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      child = original(
        [process.execPath, "--eval", "setInterval(() => {}, 1000)"],
        {
          stdout: "pipe",
          stderr: "pipe",
          detached: process.platform !== "win32",
        },
      );
      return child;
    });
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    try {
      const pending = withWorkspaceGitContext(
        {
          signal: controller.signal,
          timeoutMs: kind === "deadline" ? 20 : 5000,
        },
        () => runGitRaw(process.cwd(), ["status"]),
      );
      if (kind === "abort") controller.abort(reason);
      if (kind === "abort") await expect(pending).rejects.toBe(reason);
      else
        await expect(pending).rejects.toMatchObject({
          code: "workspace_git_failure",
        });
      expect(child).toBeDefined();
      expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    } finally {
      spawn.mockRestore();
      child?.kill("SIGKILL");
      if (child) await child.exited;
    }
  },
);

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

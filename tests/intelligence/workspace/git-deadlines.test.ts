import { beforeEach, expect, spyOn, test } from "bun:test";

import { createMockTime, deferred } from "../../support/mock-time.ts";
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

test.each(["abort", "overflow"] as const)(
  "Git %s reaps descendants after its process leader exits",
  async (mode) => {
    const reading = deferred();
    const controller = new AbortController();
    const reason = new Error("Git caller cancelled");
    let stdout!: ReadableStreamDefaultController<Uint8Array>;
    let stderr!: ReadableStreamDefaultController<Uint8Array>;
    const child = {
      exitCode: 0,
      exited: Promise.resolve(0),
      pid: 12345,
      kill() {},
      stdout: new ReadableStream<Uint8Array>({
        start(output) {
          stdout = output;
        },
        pull() {
          reading.resolve();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(output) {
          stderr = output;
        },
      }),
    };
    const close = () => {
      stdout.close();
      stderr.close();
    };
    const spawn = spyOn(Bun, "spawn")
      .mockReturnValueOnce(child as never)
      .mockImplementation(() => {
        close();
        return { exitCode: 0, exited: Promise.resolve(0) } as never;
      });
    const kill = spyOn(process, "kill").mockImplementation(() => {
      close();
      return true;
    });
    try {
      const pending = runGitRaw(
        process.cwd(),
        ["status"],
        controller.signal,
        undefined,
        1,
      );
      void pending.catch(() => {});
      await reading.promise;
      if (mode === "abort") {
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);
      } else {
        stdout.enqueue(new Uint8Array(2));
        await expect(pending).rejects.toMatchObject({
          code: "git_output_limit_exceeded",
        });
      }
      if (process.platform === "win32")
        expect(spawn.mock.calls[1]?.[0]).toEqual([
          "taskkill.exe",
          "/PID",
          "12345",
          "/T",
          "/F",
        ]);
      else expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
    } finally {
      kill.mockRestore();
      spawn.mockRestore();
    }
  },
);

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

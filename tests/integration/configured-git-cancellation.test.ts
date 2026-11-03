import { expect, spyOn, test } from "bun:test";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import { runGitRaw } from "../../src/intelligence/workspace/git";
import { WorkspaceRegistry } from "../../src/intelligence/workspace/registry";
import { configuredExecution } from "../../src/tools/configured";
test("configured workspace discovery passes request cancellation to Git subprocesses", async () => {
  const registry = new WorkspaceRegistry();
  const started = Promise.withResolvers<void>();
  const spawn = Bun.spawn.bind(Bun);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const intercepted = spyOn(Bun, "spawn").mockImplementation(((
    ...args: Parameters<typeof Bun.spawn>
  ) => {
    if (Array.isArray(args[0]) && args[0][0] === "git") {
      child = spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
      });
      started.resolve();
      return child;
    }
    return spawn(...args);
  }) as typeof Bun.spawn);
  const select = spyOn(registry, "selectDirectory").mockImplementation(
    async () => {
      await runGitRaw(process.cwd(), ["status"]);
      return undefined;
    },
  );
  const server = {
    server: {
      getClientCapabilities: () => ({}),
      setNotificationHandler: () => {},
    },
  } as unknown as McpServer;
  const execute = configuredExecution(server, undefined, {
    workspaceRegistry: registry,
  });
  const abort = new AbortController();
  const failure = new Error("host cancelled discovery");
  const request = execute(
    {},
    async () => {
      throw new Error("operation must not start");
    },
    { mcpReq: { signal: abort.signal } } as ServerContext,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started.promise,
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Git did not start")), 3000);
      }),
    ]);
    abort.abort(failure);
    await expect(request).rejects.toBe(failure);
    expect(await child!.exited).not.toBe(0);
  } finally {
    clearTimeout(timer);
    abort.abort(failure);
    child?.kill();
    if (child) await child.exited;
    await request.catch(() => undefined);
    intercepted.mockRestore();
    select.mockRestore();
  }
});

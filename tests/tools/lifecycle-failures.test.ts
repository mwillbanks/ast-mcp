import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withConfig } from "../../src/config";
import {
  withMutationLifecycle,
  type MutationLifecycle,
} from "../../src/intelligence/mutation/index.ts";
import { acquireFileLock } from "../../src/intelligence/mutation/locks.ts";
import { mutationTransactionLockPath } from "../../src/intelligence/mutation/service.ts";
import { LanceIntelligenceStore } from "../../src/intelligence/storage/store.ts";
import { withWorkspaceContext } from "../../src/intelligence/workspace/context.ts";
import { WorkspaceRegistry } from "../../src/intelligence/workspace/registry.ts";
import * as attributes from "../../src/runtime/attributes";
import registerLifecycleTools from "../../src/tools/lifecycle.ts";
import { hermeticConfig } from "../support/hermetic-config";

type Handler = (
  input: Record<string, unknown>,
) => Promise<{ isError?: boolean; structuredContent?: unknown }>;

async function fixture(signal?: AbortSignal) {
  const root = await mkdtemp(join(tmpdir(), "ast-lifecycle-contract-"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "ast-mcp.toml"), "version = 2\n");
  const first = join(root, "first.txt");
  const second = join(root, "second.txt");
  await writeFile(first, "first");
  await writeFile(second, "second");
  const handlers = new Map<string, Handler>();
  registerLifecycleTools(
    {
      registerTool(name: string, _definition: unknown, handler: Handler) {
        handlers.set(name, handler);
      },
    } as never,
    async (_args, operation) =>
      withConfig(hermeticConfig(root), () => operation(signal)),
  );
  const hash = (text: string) =>
    new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const files = {
    [first]: { expectedSha256: hash("first"), chattr: { chmod: 0o600 } },
    [second]: { expectedSha256: hash("second"), chattr: { chmod: 0o600 } },
  };
  return { root, first, second, files, handlers };
}

test("attribute batches restore earlier files when completion or application fails", async () => {
  for (const failurePoint of ["apply", "complete"] as const) {
    const { root, first, second, files, handlers } = await fixture();
    const events: string[] = [];
    const before = await Promise.all([stat(first), stat(second)]);
    const lifecycle: MutationLifecycle = {
      begin: async (plan) => {
        events.push("begin");
        expect(plan.files).toHaveLength(2);
      },
      committed: async (_id, file) => {
        events.push("commit:" + file.filePath);
      },
      complete: async () => {
        events.push("complete");
        throw new Error("refresh failed");
      },
      failed: async () => {
        events.push("failed");
        throw new Error("journal unavailable");
      },
      rolledBack: async () => {
        events.push("rollback");
      },
    };
    if (failurePoint === "apply") files[second]!.chattr.chmod = -1;
    try {
      const result = await withMutationLifecycle(lifecycle, () =>
        handlers.get("file_chattr")!({ files }),
      );
      expect(result.isError).toBe(true);
      expect(events).toContain("failed");
      expect(events.at(-1)).toBe("rollback");
      if (process.platform !== "win32") {
        expect((await stat(first)).mode & 0o777).toBe(before[0]!.mode & 0o777);
        expect((await stat(second)).mode & 0o777).toBe(before[1]!.mode & 0o777);
      }
      expect(await Bun.file(first).text()).toBe("first");
      expect(await Bun.file(second).text()).toBe("second");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("attribute rollback failures surface aggregate failure without claiming rollback", async () => {
  const { root, first, second, files, handlers } = await fixture();
  const original = attributes.applyFileChattr;
  let calls = 0;
  let rolledBack = false;
  const lifecycle: MutationLifecycle = {
    begin: async () => {},
    committed: async () => {},
    complete: async () => null,
    failed: async () => {},
    rolledBack: async () => {
      rolledBack = true;
    },
  };
  const injected = spyOn(attributes, "applyFileChattr").mockImplementation(
    async (...args) => {
      calls++;
      if (calls === 2) throw new Error("second mutation failed");
      if (calls === 3) throw new Error("first restoration failed");
      return original(...args);
    },
  );
  try {
    const result = await withMutationLifecycle(lifecycle, () =>
      handlers.get("file_chattr")!({ files }),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { message: "file_chattr failed and rollback was incomplete" },
    });
    expect(rolledBack).toBe(false);
    expect(calls).toBe(3);
    expect(await Bun.file(first).text()).toBe("first");
    expect(await Bun.file(second).text()).toBe("second");
  } finally {
    injected.mockRestore();
    await chmod(first, 0o600);
    await rm(root, { force: true, recursive: true });
  }
});

test("attribute rollback preserves files changed by another writer", async () => {
  const { root, first, files, handlers } = await fixture();
  const original = attributes.applyFileChattr;
  let calls = 0;
  let rolledBack = false;
  const lifecycle: MutationLifecycle = {
    begin: async () => {},
    committed: async () => {},
    complete: async () => null,
    failed: async () => {},
    rolledBack: async () => {
      rolledBack = true;
    },
  };
  const injected = spyOn(attributes, "applyFileChattr").mockImplementation(
    async (...args) => {
      calls++;
      if (calls === 2) {
        await writeFile(first, "concurrent writer");
        throw new Error("second mutation failed");
      }
      return original(...args);
    },
  );
  try {
    const result = await withMutationLifecycle(lifecycle, () =>
      handlers.get("file_chattr")!({ files }),
    );
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { message: "file_chattr failed and rollback was incomplete" },
    });
    expect(await Bun.file(first).text()).toBe("concurrent writer");
    expect(rolledBack).toBe(false);
    expect(calls).toBe(3);
  } finally {
    injected.mockRestore();
    await rm(root, { force: true, recursive: true });
  }
});

test("successful lifecycle batches retain workspace identity and hash-guard moves and deletion", async () => {
  const { root, first, second, files, handlers } = await fixture();
  const selected = await new WorkspaceRegistry().open({
    configurationGeneration: 1,
    directory: root,
    storage: { kind: "explicit", path: join(root, "storage") },
  });
  const events: string[] = [];
  const lifecycle: MutationLifecycle = {
    begin: async (plan) => {
      expect(plan.workspace?.workspaceId).toBe(selected.workspaceId);
      expect(plan.operationId).toBeTruthy();
      events.push(plan.tool);
    },
    committed: async () => {},
    complete: async () => null,
    failed: async () => {},
    rolledBack: async () => {},
  };
  try {
    await withWorkspaceContext(selected, () =>
      withMutationLifecycle(lifecycle, async () => {
        const attributed = await handlers.get("file_chattr")!({ files });
        expect(attributed.isError).not.toBe(true);
        if (process.platform !== "win32")
          expect((await stat(second)).mode & 0o777).toBe(0o600);
        const destination = join(root, "moved.txt");
        const moved = await handlers.get("file_rename")!({
          files: {
            [first]: {
              destination,
              expectedSha256: files[first]!.expectedSha256,
            },
          },
        });
        expect(moved.isError).not.toBe(true);
        expect(await Bun.file(first).exists()).toBe(false);
        expect(await Bun.file(destination).text()).toBe("first");
        const deleted = await handlers.get("file_delete")!({
          files: {
            [destination]: { expectedSha256: files[first]!.expectedSha256 },
          },
        });
        expect(deleted.isError).not.toBe(true);
        expect(await Bun.file(destination).exists()).toBe(false);
      }),
    );
    expect(events).toEqual(["file_chattr", "file_rename", "file_delete"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rename handlers preserve execution failures in the public envelope", async () => {
  const handlers = new Map<string, Handler>();
  registerLifecycleTools(
    {
      registerTool(name: string, _definition: unknown, handler: Handler) {
        handlers.set(name, handler);
      },
    } as never,
    async () => {
      throw new Error("workspace unavailable");
    },
  );
  const result = await handlers.get("file_rename")!({ files: {} });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    ok: false,
    error: { message: "workspace unavailable" },
  });
});

test.each(["file_chattr", "file_delete", "file_rename"] as const)(
  "%s cancels checkout admission before recovery or filesystem changes",
  async (tool) => {
    const abort = new AbortController();
    const { root, first, second, files, handlers } = await fixture(
      abort.signal,
    );
    const workspace = await new WorkspaceRegistry().open({
      configurationGeneration: 1,
      directory: root,
      storage: { kind: "explicit", path: join(root, "storage") },
    });
    const owner = await acquireFileLock(
      await mutationTransactionLockPath(root),
    );
    const before = await stat(first);
    const open = spyOn(LanceIntelligenceStore, "open");
    const destination = join(root, "renamed.txt");
    const request =
      tool === "file_chattr"
        ? files
        : {
            [first]: {
              expectedSha256: files[first]!.expectedSha256,
              ...(tool === "file_rename" ? { destination } : {}),
            },
          };
    const waiting = Promise.withResolvers<void>();
    const originalExec = Database.prototype.exec;
    const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
      this: Database,
      ...args: Parameters<typeof originalExec>
    ) {
      try {
        return originalExec.apply(this, args);
      } catch (error) {
        if (
          args[0] === "BEGIN IMMEDIATE" &&
          (error as { code?: string }).code === "SQLITE_BUSY"
        )
          waiting.resolve();
        throw error;
      }
    });
    let operation: ReturnType<Handler> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      operation = withWorkspaceContext(workspace, () =>
        handlers.get(tool)!({ files: request }),
      );
      await Promise.race([
        waiting.promise,
        operation.then(() => {
          throw new Error("Tool completed before checkout admission waited");
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("Checkout lock contention was not observed")),
            5000,
          );
        }),
      ]);
      clearTimeout(timeout);
      abort.abort(new Error("caller cancelled"));
      const result = await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error("Checkout admission ignored caller cancellation"),
              ),
            1000,
          );
        }),
      ]);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "lock_aborted" },
      });
      expect(open).not.toHaveBeenCalled();
      expect(await Bun.file(first).text()).toBe("first");
      expect(await Bun.file(second).text()).toBe("second");
      expect(await Bun.file(destination).exists()).toBe(false);
      if (process.platform !== "win32")
        expect((await stat(first)).mode & 0o777).toBe(before.mode & 0o777);
      await owner.fence();
    } finally {
      if (timeout) clearTimeout(timeout);
      exec.mockRestore();
      await owner.release();
      await operation;
      open.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);

import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveConfig, withResolvedConfig } from "../../src/config";
import { renameFilesSafely } from "../../src/runtime/file-rename";
import { readFileSnapshot } from "../../src/runtime/file-snapshot";
import { sha256 } from "../../src/runtime/hash";
import {
  resolveIntelligencePath,
  resolveWritablePath,
  resolveWorkspacePath,
} from "../../src/runtime/paths";
import { readSubprocessOutput } from "../../src/runtime/subprocess";
import { hermeticConfig } from "../support/hermetic-config";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => fs.rm(folder, { recursive: true, force: true })),
  );
});

async function isolatedConfig(folder: string) {
  await fs.writeFile(path.join(folder, "ast-mcp.toml"), "version = 1\n");
  return resolveConfig(
    hermeticConfig(folder, {
      AST_MCP_ROOTS: folder,
      AST_MCP_ALLOW_EXTERNAL_ROOTS: "1",
    }),
  );
}

test("public paths reject coordination databases and reserved directory descendants", async () => {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-reserved-paths-"),
  );
  folders.push(folder);
  const config = await isolatedConfig(folder);
  await withResolvedConfig(config, async () => {
    for (const relative of [
      ".value.ts.ast-mcp.lock",
      ".value.ts.ast-mcp.lock.pending-00000000-0000-4000-8000-000000000000",
      ".value.ts.ast-mcp.lock.stale-00000000-0000-4000-8000-000000000000",
      ".ast-mcp-storage-writer.sqlite",
      "ast-mcp.toml.config-commit.sqlite-journal",
      ".ast-mcp-locks/owner.sqlite",
      ".ast-mcp-mutation-locks/owner.sqlite",
      ".git/ast-mcp-locks/owner.sqlite",
    ]) {
      const target = path.join(folder, relative);
      for (const resolve of [
        (value: string) => resolveWritablePath(value, "read"),
        resolveWritablePath,
        resolveIntelligencePath,
        resolveWorkspacePath,
      ])
        await expect(resolve(target)).rejects.toMatchObject({
          code: "coordination_artifact_reserved",
          retryable: false,
        });
    }
    const ordinary = path.join(folder, "ordinary.ts");
    await fs.writeFile(ordinary, "export const value = 1;");
    expect(await resolveWritablePath(ordinary, "read")).toBe(
      await fs.realpath(ordinary),
    );
  });
});

test.each(["ast-mcp-locks", ".ast-mcp-locks", ".ast-mcp-mutation-locks"])(
  "public paths allow workspace roots below %s ancestors",
  async (ancestor) => {
    const outer = await fs.mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-root-ancestor-"),
    );
    folders.push(outer);
    const folder = path.join(outer, ancestor, "project");
    await fs.mkdir(path.join(folder, "ast-mcp-locks"), { recursive: true });
    const config = await isolatedConfig(folder);
    config.safety.allowTempDirectory = false;
    await withResolvedConfig(config, async () => {
      for (const relative of ["ordinary.ts", "ast-mcp-locks/ordinary.ts"]) {
        const target = path.join(folder, relative);
        await fs.writeFile(target, "export const value = 1;");
        for (const resolve of [
          (value: string) => resolveWritablePath(value, "read"),
          resolveWritablePath,
          resolveIntelligencePath,
          resolveWorkspacePath,
        ]) {
          expect(await resolve(target)).toBe(await fs.realpath(target));
          expect(await resolve(relative)).toBe(await fs.realpath(target));
        }
      }
      for (const relative of [
        ".ast-mcp-locks/owner.sqlite",
        ".ast-mcp-mutation-locks/owner.sqlite",
        ".git/ast-mcp-locks/owner.sqlite",
      ])
        await expect(
          resolveWritablePath(path.join(folder, relative)),
        ).rejects.toMatchObject({
          code: "coordination_artifact_reserved",
        });
    });
  },
);

test.each([".git", ".git/ast-mcp-locks"])(
  "public paths preserve Git guard protection with root %s",
  async (relativeRoot) => {
    const outer = await fs.mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-metadata-root-"),
    );
    folders.push(outer);
    const folder = path.join(outer, relativeRoot);
    await fs.mkdir(folder, { recursive: true });
    const target = path.join(outer, ".git", "ast-mcp-locks", "owner.sqlite");
    const config = await isolatedConfig(folder);
    config.workspace.roots = [folder];
    config.paths = [];
    config.safety.allowTempDirectory = false;
    await withResolvedConfig(config, async () => {
      for (const resolve of [
        (value: string) => resolveWritablePath(value, "read"),
        resolveWritablePath,
        resolveIntelligencePath,
        resolveWorkspacePath,
      ])
        for (const value of [target, path.relative(folder, target)])
          await expect(resolve(value)).rejects.toMatchObject({
            code: "coordination_artifact_reserved",
          });
    });
  },
);

test.skipIf(process.platform === "win32")(
  "public paths reject symlink aliases to coordination files",
  async () => {
    const folder = await fs.mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-reserved-alias-"),
    );
    folders.push(folder);
    const config = await isolatedConfig(folder);
    const target = path.join(folder, ".ast-mcp-storage-writer.sqlite");
    await fs.writeFile(target, "reserved");
    const alias = path.join(folder, "ordinary.ts");
    await fs.symlink(target, alias);
    await withResolvedConfig(
      {
        ...config,
        paths: [],
        safety: { ...config.safety, followSymlinks: true },
      },
      async () => {
        await expect(resolveWritablePath(alias, "read")).rejects.toMatchObject({
          code: "coordination_artifact_reserved",
        });
      },
    );
  },
);

test("rename verification failure removes the newly linked destination", async () => {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-rename-verification-"),
  );
  folders.push(folder);
  const config = await isolatedConfig(folder);
  await withResolvedConfig(config, async () => {
    const source = path.join(folder, "source.txt");
    const destination = path.join(folder, "destination.txt");
    await fs.writeFile(source, "original");
    const actualLstat = fs.lstat;
    const inspect = spyOn(fs, "lstat").mockImplementation((async (
      filePath: Parameters<typeof fs.lstat>[0],
    ) => {
      const result = await actualLstat(filePath);
      if (path.basename(String(filePath)) === "destination.txt")
        throw new Error("post-link verification failed");
      return result;
    }) as typeof fs.lstat);
    try {
      await expect(
        renameFilesSafely({
          [source]: {
            destination,
            expectedSha256: new Bun.CryptoHasher("sha256")
              .update("original")
              .digest("hex"),
          },
        }),
      ).rejects.toThrow("post-link verification failed");
    } finally {
      inspect.mockRestore();
    }
    expect(await fs.readFile(source, "utf8")).toBe("original");
    await expect(fs.lstat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

test("snapshot keeps one open file when its path is replaced during capture", async () => {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-snapshot-race-"),
  );
  folders.push(folder);
  const file = path.join(folder, "source.txt");
  await fs.writeFile(file, "before", { mode: 0o640 });
  const actual = fs.open;
  const read = spyOn(fs, "open").mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await actual(...args);
      try {
        await fs.rename(file, file + ".original");
        await fs.writeFile(file, "after replacement");
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      }
    },
  );
  try {
    const snapshot = await readFileSnapshot(file);
    expect(read).toHaveBeenCalledTimes(1);
    expect(snapshot.content.toString()).toBe("before");
    if (process.platform !== "win32") expect(snapshot.mode & 0o777).toBe(0o640);
    expect(await fs.readFile(file, "utf8")).toBe("after replacement");
    expect(snapshot.sha256).toBe(sha256(snapshot.content));
  } finally {
    read.mockRestore();
  }
});

test("rename cancellation after linking restores the source without residual destinations", async () => {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-rename-abort-"),
  );
  folders.push(folder);
  const config = await isolatedConfig(folder);
  await withResolvedConfig(config, async () => {
    const source = path.join(folder, "source.txt");
    const destination = path.join(folder, "destination.txt");
    await fs.writeFile(source, "original");
    const abort = new AbortController();
    const failure = new Error("cancelled during link");
    const actualLink = fs.link;
    const link = spyOn(fs, "link").mockImplementation(
      async (source, target) => {
        await actualLink(source, target);
        if (path.basename(String(target)) === "destination.txt")
          abort.abort(failure);
      },
    );
    try {
      await expect(
        renameFilesSafely(
          { [source]: { destination, expectedSha256: sha256("original") } },
          abort.signal,
        ),
      ).rejects.toBe(failure);
    } finally {
      link.mockRestore();
    }
    expect(await fs.readFile(source, "utf8")).toBe("original");
    await expect(fs.lstat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

for (const before of [true, false])
  test(`subprocess output rejects ${before ? "prior" : "in-flight"} cancellation without returning partial bytes`, async () => {
    const abort = new AbortController();
    const failure = new Error("request cancelled");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(new TextEncoder().encode("partial"));
      },
      cancel() {
        cancelled = true;
      },
    });
    if (before) abort.abort(failure);
    const operation = readSubprocessOutput(
      stream,
      abort.signal,
      async () => {},
    );
    if (!before) abort.abort(failure);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          operation,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Cancellation did not settle output")),
              1000,
            );
          }),
        ]),
      ).rejects.toBe(failure);
      expect(stream.locked).toBe(false);
      if (!before) expect(cancelled).toBe(true);
    } finally {
      clearTimeout(timer);
      if (!cancelled) controller.close();
      await operation.catch(() => undefined);
    }
  });

test("snapshot rejects prior cancellation before opening an absent path", async () => {
  const abort = new AbortController();
  const failure = new Error("cancelled");
  abort.abort(failure);
  await expect(
    readFileSnapshot("/missing/snapshot-fixture", abort.signal),
  ).rejects.toBe(failure);
});
test.skipIf(process.platform === "win32")(
  "snapshot rejects a FIFO without waiting for a writer",
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-snapshot-fifo-"),
    );
    folders.push(root);
    const fifo = path.join(root, "pipe");
    const create = Bun.spawn(["mkfifo", fifo], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await create.exited).toBe(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          readFileSnapshot(fifo),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("FIFO snapshot blocked")),
              1000,
            );
          }),
        ]),
      ).rejects.toMatchObject({ code: "file_not_regular" });
    } finally {
      clearTimeout(timer);
    }
  },
);
test("snapshot reads regular file bytes and rejects directories", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-snapshot-regular-"),
  );
  folders.push(root);
  const file = path.join(root, "entry.txt");
  await fs.writeFile(file, "contents");
  expect((await readFileSnapshot(file)).content.toString()).toBe("contents");
  await expect(readFileSnapshot(root)).rejects.toMatchObject({
    code: "file_not_regular",
  });
});

import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeFilesSafely } from "../../src/patch/engine";
import * as formatting from "../../src/runtime/format";
import {
  ensureParentDirectories,
  removeCreatedDirectories,
} from "../../src/runtime/parent-directories";
import * as paths from "../../src/runtime/paths";

const exists = (filePath: string) =>
  fs.lstat(filePath).then(
    () => true,
    () => false,
  );
const roots: string[] = [];
const originalRoots = process.env.AST_MCP_ROOTS;
const originalExternalRoots = process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;

async function temporaryRoot() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ast-mcp-parents-")),
  );
  roots.push(root);
  await fs.writeFile(path.join(root, "ast-mcp.toml"), "version = 1\n");
  process.env.AST_MCP_ROOTS = root;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  if (originalRoots === undefined) delete process.env.AST_MCP_ROOTS;
  else process.env.AST_MCP_ROOTS = originalRoots;
  if (originalExternalRoots === undefined)
    delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  else process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = originalExternalRoots;
});

test("owned nested parents are removed in reverse order and shared parents remain", async () => {
  const root = await temporaryRoot();
  const created: string[] = [];
  await ensureParentDirectories(path.join(root, "new/deep/a.txt"), created);
  await ensureParentDirectories(path.join(root, "new/deep/b.txt"), created);
  expect(created).toEqual([
    path.join(root, "new"),
    path.join(root, "new/deep"),
  ]);
  await removeCreatedDirectories(created);
  expect(await exists(path.join(root, "new"))).toBe(false);
  expect(await exists(root)).toBe(true);
});

test("ownership is recorded before post-mkdir validation throws", async () => {
  const root = await temporaryRoot();
  const target = path.join(root, "new/a.txt");
  const created: string[] = [];
  const actual = paths.resolveWritablePath;
  let failed = false;
  const resolve = spyOn(paths, "resolveWritablePath").mockImplementation(
    async (filePath, operation) => {
      if (
        !failed &&
        filePath === target &&
        (await exists(path.dirname(target)))
      ) {
        failed = true;
        throw new Error("post-mkdir policy changed");
      }
      return actual(filePath, operation);
    },
  );
  try {
    await expect(ensureParentDirectories(target, created)).rejects.toThrow(
      "post-mkdir policy changed",
    );
    expect(created).toEqual([path.dirname(target)]);
    await removeCreatedDirectories(created);
    expect(await exists(path.dirname(target))).toBe(false);
  } finally {
    resolve.mockRestore();
  }
});

test("cleanup preserves substituted directories and concurrent contents", async () => {
  const root = await temporaryRoot();
  const created: string[] = [];
  const directory = path.join(root, "new");
  await ensureParentDirectories(path.join(directory, "a.txt"), created);
  await fs.rename(directory, path.join(root, "original"));
  await fs.mkdir(directory);
  await removeCreatedDirectories(created);
  expect(await exists(directory)).toBe(true);
  const other: string[] = [];
  await ensureParentDirectories(path.join(root, "populated/a.txt"), other);
  await fs.writeFile(path.join(root, "populated/concurrent.txt"), "preserve");
  await removeCreatedDirectories(other);
  expect(
    await fs.readFile(path.join(root, "populated/concurrent.txt"), "utf8"),
  ).toBe("preserve");
});

test("cleanup preserves substituted symlinks", async () => {
  const root = await temporaryRoot();
  const created: string[] = [];
  const directory = path.join(root, "new");
  await ensureParentDirectories(path.join(directory, "a.txt"), created);
  await fs.rename(directory, path.join(root, "original"));
  await fs.symlink(path.join(root, "original"), directory, "dir");
  await removeCreatedDirectories(created);
  expect((await fs.lstat(directory)).isSymbolicLink()).toBe(true);
});

test("denied parent creation has no side effects", async () => {
  const root = await temporaryRoot();
  const parent = path.join(root, "denied");
  const actual = paths.resolveWritablePath;
  const resolve = spyOn(paths, "resolveWritablePath").mockImplementation(
    async (filePath, operation) => {
      if (filePath === parent)
        throw Object.assign(new Error("parent denied"), {
          code: "path_denied",
        });
      return actual(filePath, operation);
    },
  );
  try {
    await expect(
      ensureParentDirectories(path.join(parent, "a.txt"), []),
    ).rejects.toThrow("parent denied");
    expect(await exists(parent)).toBe(false);
  } finally {
    resolve.mockRestore();
  }
});

test("cancellation during creation leaves a complete cleanup ledger", async () => {
  const root = await temporaryRoot();
  const created: string[] = [];
  const controller = new AbortController();
  let calls = 0;
  await expect(
    ensureParentDirectories(
      path.join(root, "new/deep/a.txt"),
      created,
      async () => {
        if (++calls === 2) controller.abort();
        controller.signal.throwIfAborted();
      },
    ),
  ).rejects.toThrow();
  expect(created).toHaveLength(1);
  await removeCreatedDirectories(created);
  expect(await exists(path.join(root, "new"))).toBe(false);
});

test("write batch rollback cleans the original ownership ledger", async () => {
  const root = await temporaryRoot();
  const first = path.join(root, "new/deep/first.txt");
  const second = path.join(root, "other/second.txt");
  const actual = fs.rename.bind(fs);
  const rename = spyOn(fs, "rename").mockImplementation(
    async (source, destination) => {
      if (destination.toString() === second)
        throw new Error("second commit failed");
      return actual(source, destination);
    },
  );
  try {
    await expect(
      writeFilesSafely({
        [first]: { content: "first" },
        [second]: { content: "second" },
      }),
    ).rejects.toThrow("second commit failed");
    expect(await exists(path.join(root, "new"))).toBe(false);
    expect(await exists(path.join(root, "other"))).toBe(false);
  } finally {
    rename.mockRestore();
  }
});

test("formatter failure removes parents created during write preflight", async () => {
  const root = await temporaryRoot();
  const target = path.join(root, "new/deep/a.txt");
  const format = spyOn(formatting, "formatContent").mockRejectedValue(
    new Error("formatter failed"),
  );
  try {
    await expect(
      writeFilesSafely({ [target]: { content: "text" } }),
    ).rejects.toThrow("formatter failed");
    expect(await exists(path.join(root, "new"))).toBe(false);
  } finally {
    format.mockRestore();
  }
});

test("cleanup failures report affected paths", async () => {
  const root = await temporaryRoot();
  const created: string[] = [];
  await ensureParentDirectories(path.join(root, "new/a.txt"), created);
  const actual = fs.rmdir.bind(fs);
  const rmdir = spyOn(fs, "rmdir").mockImplementation(async (directory) => {
    if (directory.toString() === created[0])
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return actual(directory);
  });
  try {
    await expect(removeCreatedDirectories(created)).rejects.toMatchObject({
      details: { affectedPaths: created },
    });
  } finally {
    rmdir.mockRestore();
  }
});

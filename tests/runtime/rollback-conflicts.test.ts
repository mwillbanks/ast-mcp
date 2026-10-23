import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as mutations from "../../src/intelligence/mutation";
import { deleteFilesSafely } from "../../src/runtime/file-delete";
import { renameFilesSafely } from "../../src/runtime/file-rename";
import { sha256 } from "../../src/runtime/hash";
const roots: string[] = [];
const previous = {
  AST_MCP_ROOTS: process.env.AST_MCP_ROOTS,
  AST_MCP_ALLOW_EXTERNAL_ROOTS: process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS,
};
afterEach(async () => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-rollback-conflict-"),
  );
  roots.push(root);
  process.env.AST_MCP_ROOTS = root;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  await fs.writeFile(path.join(root, "ast-mcp.toml"), "version = 1\n");
  return root;
}
test("rename cleanup preserves a destination replaced during post-link verification", async () => {
  const root = await fixture(),
    source = path.join(root, "source.txt"),
    destination = path.join(root, "destination.txt");
  await fs.writeFile(source, "original");
  const actual = fs.link;
  const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
    await actual(from, to);
    if (path.basename(String(to)) === path.basename(destination)) {
      await fs.unlink(destination);
      await fs.writeFile(destination, "concurrent");
    }
  });
  try {
    await expect(
      renameFilesSafely({
        [source]: { destination, expectedSha256: sha256("original") },
      }),
    ).rejects.toThrow("cleaning up");
  } finally {
    link.mockRestore();
  }
  expect(await fs.readFile(source, "utf8")).toBe("original");
  expect(await fs.readFile(destination, "utf8")).toBe("concurrent");
});
test("rename rollback preserves modified moved bytes and reports incomplete recovery", async () => {
  const root = await fixture(),
    first = path.join(root, "first.txt"),
    second = path.join(root, "second.txt"),
    firstDestination = path.join(root, "first-dest.txt"),
    secondDestination = path.join(root, "second-dest.txt");
  await fs.writeFile(first, "first");
  await fs.writeFile(second, "second");
  const actual = fs.link;
  const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
    if (path.basename(String(to)) === path.basename(secondDestination)) {
      await fs.writeFile(firstDestination, "concurrent");
      throw new Error("second move failed");
    }
    await actual(from, to);
  });
  try {
    await expect(
      renameFilesSafely({
        [first]: {
          destination: firstDestination,
          expectedSha256: sha256("first"),
        },
        [second]: {
          destination: secondDestination,
          expectedSha256: sha256("second"),
        },
      }),
    ).rejects.toThrow("rollback was incomplete");
  } finally {
    link.mockRestore();
  }
  expect(await fs.readFile(firstDestination, "utf8")).toBe("concurrent");
  expect(await fs.readFile(second, "utf8")).toBe("second");
  await expect(fs.lstat(first)).rejects.toMatchObject({ code: "ENOENT" });
});
test("delete rechecks captured source bytes before unlinking", async () => {
  const root = await fixture(),
    file = path.join(root, "entry.txt");
  await fs.writeFile(file, "original");
  const actual = mutations.beginMutation;
  const begin = spyOn(mutations, "beginMutation").mockImplementation(
    async (...args) => {
      await fs.writeFile(file, "concurrent");
      return actual(...args);
    },
  );
  try {
    await expect(
      deleteFilesSafely({ [file]: { expectedSha256: sha256("original") } }),
    ).rejects.toThrow();
  } finally {
    begin.mockRestore();
  }
  expect(await fs.readFile(file, "utf8")).toBe("concurrent");
});

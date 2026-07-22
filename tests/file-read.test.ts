import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  hashFilesSafely,
  readFileSafely,
  readFilesSafely,
} from "../src/runtime/file-read";

const folders: string[] = [];
const repositoryRoot = path.resolve(import.meta.dir, "..");

function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

async function temporaryFolder() {
  const folder = await mkdtemp(path.join(repositoryRoot, ".tmp-file-read-"));
  folders.push(folder);
  return folder;
}

afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

test("file_read batches bounded slices with a streaming whole-file hash", async () => {
  const folder = await temporaryFolder();
  const firstPath = path.join(folder, "first.xml");
  const secondPath = path.join(folder, "second.txt");
  const first = "zero\none\ntwo\nthree\n";
  const second = "alpha\nbeta\n";
  await Promise.all([
    writeFile(firstPath, first),
    writeFile(secondPath, second),
  ]);

  const results = await readFilesSafely([
    { filePath: firstPath, lines: [1, 3] },
    { filePath: secondPath },
  ]);

  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({
    content: "one\ntwo\n",
    hasMore: true,
    lines: { requested: [1, 3], returned: [1, 3] },
    sha256: sha256(first),
    size: Buffer.byteLength(first),
    truncated: false,
  });
  expect(results[1]).toMatchObject({
    content: second,
    hasMore: false,
    lines: { requested: [0, 100], returned: [0, 2] },
    sha256: sha256(second),
    size: Buffer.byteLength(second),
    truncated: false,
  });
});

test("file_read rejects AST-capable files and routes to intelligence tools", async () => {
  const folder = await temporaryFolder();
  const filePath = path.join(folder, "value.ts");
  await writeFile(filePath, "export const value = 1;\n");

  await expect(readFileSafely({ filePath })).rejects.toThrow(
    "AST-capable files must use map, show, search, context, or run",
  );
});

test("file_hash streams AST-capable files without returning content", async () => {
  const folder = await temporaryFolder();
  const filePath = path.join(folder, "value.ts");
  const content = "export const value = 1;\n";
  await writeFile(filePath, content);

  const [result] = await hashFilesSafely([filePath]);

  expect(result).toEqual({
    filePath,
    sha256: sha256(content),
    size: Buffer.byteLength(content),
  });
  expect(result).not.toHaveProperty("content");
});

test("file_read caps a giant line without buffering the whole file", async () => {
  const folder = await temporaryFolder();
  const filePath = path.join(folder, "giant.xml");
  const content = Buffer.alloc(2 * 1024 * 1024, 97);
  await writeFile(filePath, content);

  const result = await readFileSafely({
    filePath,
    lines: [0, 1],
    maxBytes: 1024,
  });

  expect(Buffer.byteLength(result.content)).toBe(1024);
  expect(result.content).toBe("a".repeat(1024));
  expect(result.hasMore).toBeTrue();
  expect(result.truncated).toBeTrue();
  expect(result.sha256).toBe(sha256(content));
  expect(result.size).toBe(content.byteLength);
});

test("file_read rejects unbounded requests before opening content", async () => {
  const folder = await temporaryFolder();
  const filePath = path.join(folder, "value.xml");
  await writeFile(filePath, "value\n");

  await expect(readFileSafely({ filePath, lines: [0, 1001] })).rejects.toThrow(
    "capped at 1000 lines",
  );
  await expect(
    readFileSafely({ filePath, maxBytes: 1024 * 1024 + 1 }),
  ).rejects.toThrow("maxBytes must be between");
  await expect(readFilesSafely([])).rejects.toThrow(
    "requires between 1 and 50 files",
  );
});

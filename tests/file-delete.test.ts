import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { deleteFilesSafely } from "../src/runtime/file-delete";
import { sha256 } from "../src/runtime/hash";

let root = "";

afterEach(async () => {
  delete process.env.AST_MCP_ROOTS;
  delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  if (root) await rm(root, { force: true, recursive: true });
  root = "";
});

async function temporaryRoot() {
  root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-delete-"));
  process.env.AST_MCP_ROOTS = root;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  return root;
}

test("file_delete verifies hashes and cleans empty ancestors", async () => {
  const folder = await temporaryRoot();
  const filePath = path.join(folder, "nested", "deeper", "note.txt");
  const content = "delete me\n";
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);

  const result = await deleteFilesSafely({
    [filePath]: { expectedSha256: sha256(content) },
  });

  expect(
    await readFile(filePath, "utf8").catch(() => undefined),
  ).toBeUndefined();
  expect(result.removedDirectories).toEqual([
    path.join(await realpath(folder), "nested"),
    path.join(await realpath(folder), "nested", "deeper"),
  ]);
});

test("file_delete keeps completed deletion successful when cleanup races", async () => {
  const folder = await temporaryRoot();
  const filePath = path.join(folder, "nested", "note.txt");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "delete me\n");
  const cleanupRace = Object.assign(new Error("directory became non-empty"), {
    code: "ENOTEMPTY",
  });
  const rmdir = spyOn(fsPromises, "rmdir").mockRejectedValueOnce(cleanupRace);
  try {
    const result = await deleteFilesSafely({
      [filePath]: { expectedSha256: sha256("delete me\n") },
    });
    expect(await Bun.file(filePath).exists()).toBeFalse();
    expect(result.removedDirectories).toEqual([]);
  } finally {
    rmdir.mockRestore();
  }
});

test("file_delete rejects stale hashes without deleting the target", async () => {
  const folder = await temporaryRoot();
  const filePath = path.join(folder, "note.txt");
  await writeFile(filePath, "current\n");

  await expect(
    deleteFilesSafely({ [filePath]: { expectedSha256: sha256("stale\n") } }),
  ).rejects.toThrow("Stale file context");
  expect(await readFile(filePath, "utf8")).toBe("current\n");
});

test("file_delete verifies byte-accurate hashes for cache artifacts", async () => {
  const folder = await temporaryRoot();
  const chunks = path.join(folder, ".ast-mcp", "intelligence", "chunks.bin");
  const embeddings = path.join(
    folder,
    ".ast-mcp",
    "intelligence",
    "embeddings.bin",
  );
  const chunkContent = new Uint8Array([0, 255, 254, 1, 128]);
  const embeddingContent = new Uint8Array([255, 0, 129, 2]);
  await mkdir(path.dirname(chunks), { recursive: true });
  await writeFile(chunks, chunkContent);
  await writeFile(embeddings, embeddingContent);

  await deleteFilesSafely({
    [chunks]: { expectedSha256: sha256(chunkContent) },
    [embeddings]: { expectedSha256: sha256(embeddingContent) },
  });

  expect(await readFile(chunks).catch(() => undefined)).toBeUndefined();
  expect(await readFile(embeddings).catch(() => undefined)).toBeUndefined();
});

test("file_delete rejects referenced source unless explicitly overridden", async () => {
  const folder = await temporaryRoot();
  const source = path.join(folder, "source.ts");
  const importer = path.join(folder, "importer.ts");
  await writeFile(source, "export const source = 1;\n");
  await writeFile(
    importer,
    'import { source } from "./source";\nconsole.log(source);\n',
  );

  const content = await readFile(source, "utf8");
  await expect(
    deleteFilesSafely({ [source]: { expectedSha256: sha256(content) } }),
  ).rejects.toThrow("referenced by");
  await deleteFilesSafely({
    [source]: { expectedSha256: sha256(content), forceReferences: true },
  });
  expect(await readFile(source, "utf8").catch(() => undefined)).toBeUndefined();
});

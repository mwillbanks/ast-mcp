import { afterEach, expect, test } from "bun:test";
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

test("file_delete rejects stale hashes without deleting the target", async () => {
  const folder = await temporaryRoot();
  const filePath = path.join(folder, "note.txt");
  await writeFile(filePath, "current\n");

  await expect(
    deleteFilesSafely({ [filePath]: { expectedSha256: sha256("stale\n") } }),
  ).rejects.toThrow("Stale file context");
  expect(await readFile(filePath, "utf8")).toBe("current\n");
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

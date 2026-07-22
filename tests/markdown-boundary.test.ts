import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { patchFile } from "../src/patch/engine";
import { readFileSafely } from "../src/runtime/file-read";

const folders: string[] = [];
const repositoryRoot = path.resolve(import.meta.dir, "..");

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

test("Markdown uses AST inspection but the guarded Aider rewrite route", async () => {
  const folder = await mkdtemp(
    path.join(repositoryRoot, ".tmp-markdown-boundary-"),
  );
  folders.push(folder);
  const filePath = path.join(folder, "notes.md");
  const original = "# Notes\n\nOld paragraph.\n";
  await writeFile(filePath, original);

  await expect(readFileSafely({ filePath })).rejects.toThrow(
    "AST-capable files must use map, show, search, context, or run",
  );

  const result = await patchFile({
    aiderBlock: {
      replace: "New paragraph.",
      search: "Old paragraph.",
    },
    expectedSha256: sha256(original),
    filePath,
    patchStrategy: "aider_block",
  });

  expect(result.strategy).toBe("aider_block");
  expect(await readFile(filePath, "utf8")).toBe("# Notes\n\nNew paragraph.\n");
});

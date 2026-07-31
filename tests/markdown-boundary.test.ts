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

test("Markdown supports agent-selected reads and guarded Aider rewrites", async () => {
  const folder = await mkdtemp(
    path.join(repositoryRoot, ".tmp-markdown-boundary-"),
  );
  folders.push(folder);
  const filePath = path.join(folder, "notes.md");
  const original = "# Notes\n\nOld paragraph.\n";
  await writeFile(filePath, original);

  expect((await readFileSafely({ filePath })).resolvedMode).toBe("ast");
  expect((await readFileSafely({ filePath, mode: "text" })).content).toBe(
    original,
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

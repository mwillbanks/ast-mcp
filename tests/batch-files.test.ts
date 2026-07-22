import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { patchFiles, writeFilesSafely } from "../src/patch/engine";

const folders: string[] = [];
process.env.AST_MCP_ROOTS = process.cwd();
process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

test("patchFiles applies ordered aider blocks to one file under one guard", async () => {
  const folder = await mkdtemp(path.join(process.cwd(), ".tmp-batch-"));
  folders.push(folder);
  const file = path.join(folder, "notes.txt");
  const original = "alpha\nbeta\n";
  await writeFile(file, original);

  const result = await patchFiles({
    [file]: {
      aiderBlocks: [
        { replace: "one", search: "alpha" },
        { replace: "two", search: "beta" },
      ],
      expectedSha256: sha256(original),
      patchStrategy: "aider_block",
    },
  });

  expect(Object.keys(result.files as Record<string, unknown>)).toHaveLength(1);
  expect(await readFile(file, "utf8")).toBe("one\ntwo\n");
  await expect(
    patchFiles({
      [file]: {
        expectedSha256: sha256(await readFile(file, "utf8")),
        patchStrategy: "aider_block",
      },
    }),
  ).rejects.toThrow("requires aiderBlocks");
});

test("patchFiles applies multiple AST rules to one file atomically", async () => {
  const folder = await mkdtemp(path.join(process.cwd(), ".tmp-batch-"));
  folders.push(folder);
  const file = path.join(folder, "values.ts");
  const original = "const value = 1;\n";
  await writeFile(file, original);

  await patchFiles({
    [file]: {
      astRules: [
        { fix: "const $A = 2", pattern: "const $A = $B" },
        { fix: "const $A = 3", pattern: "const $A = 2" },
      ],
      expectedSha256: sha256(original),
      patchStrategy: "ast",
    },
  });

  expect(await readFile(file, "utf8")).toContain("value = 3");
  const updated = await readFile(file, "utf8");
  await expect(
    patchFiles({
      [file]: {
        astRules: [
          {
            expectedMatches: 2,
            fix: `const ${["$", "A"].join("")} = 4`,
            pattern: `const ${["$", "A"].join("")} = ${["$", "B"].join("")}`,
          },
        ],
        expectedSha256: sha256(updated),
        patchStrategy: "ast",
      },
    }),
  ).rejects.toThrow("expected 2");

  await expect(
    patchFiles({
      [file]: {
        astRules: [{ fix: "replacement", pattern: "__NO_MATCH__" }],
        expectedSha256: sha256(updated),
        patchStrategy: "ast",
      },
    }),
  ).rejects.toThrow("expected 1");
});

test("batch mutation rejects empty maps", async () => {
  await expect(patchFiles({})).rejects.toThrow("between 1");
  await expect(writeFilesSafely({})).rejects.toThrow("between 1");
});

test("writeFilesSafely writes a keyed batch", async () => {
  const folder = await mkdtemp(path.join(process.cwd(), ".tmp-batch-"));
  folders.push(folder);
  const first = path.join(folder, "first.txt");
  const second = path.join(folder, "second.txt");

  const result = await writeFilesSafely({
    [first]: { content: "first\n" },
    [second]: { content: "second\n" },
  });

  expect(Object.keys(result.files as Record<string, unknown>).sort()).toEqual(
    [first, second].sort(),
  );
  expect(await readFile(first, "utf8")).toBe("first\n");
  expect(await readFile(second, "utf8")).toBe("second\n");
});

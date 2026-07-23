import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renameFilesSafely } from "../src/runtime/file-rename";

const roots: string[] = [];
const originalRoots = process.env.AST_MCP_ROOTS;
const originalExternalRoots = process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-rename-"));
  roots.push(root);
  process.env.AST_MCP_ROOTS = root;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
  if (originalRoots === undefined) delete process.env.AST_MCP_ROOTS;
  else process.env.AST_MCP_ROOTS = originalRoots;
  if (originalExternalRoots === undefined)
    delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  else process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = originalExternalRoots;
});

test("file_rename atomically batches hash-guarded file moves", async () => {
  const root = await temporaryRoot();
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  const firstDestination = path.join(root, "renamed-first.txt");
  const secondDestination = path.join(root, "renamed-second.txt");
  await writeFile(first, "first\n");
  await writeFile(second, "second\n");

  const result = await renameFilesSafely({
    [first]: { destination: firstDestination, expectedSha256: hash("first\n") },
    [second]: {
      destination: secondDestination,
      expectedSha256: hash("second\n"),
    },
  });

  expect(Object.values(result.files)).toHaveLength(2);
  expect(await readFile(firstDestination, "utf8")).toBe("first\n");
  expect(await readFile(secondDestination, "utf8")).toBe("second\n");
});

test("file_rename rejects stale context before moving any file", async () => {
  const root = await temporaryRoot();
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  const firstDestination = path.join(root, "renamed-first.txt");
  const secondDestination = path.join(root, "renamed-second.txt");
  await writeFile(first, "first\n");
  await writeFile(second, "second\n");

  await expect(
    renameFilesSafely({
      [first]: {
        destination: firstDestination,
        expectedSha256: hash("first\n"),
      },
      [second]: {
        destination: secondDestination,
        expectedSha256: hash("stale\n"),
      },
    }),
  ).rejects.toThrow("Stale file context");
  expect(await readFile(first, "utf8")).toBe("first\n");
  expect(await readFile(second, "utf8")).toBe("second\n");
});

test("file_rename refuses an existing destination", async () => {
  const root = await temporaryRoot();
  const source = path.join(root, "source.txt");
  const destination = path.join(root, "destination.txt");
  await writeFile(source, "source\n");
  await writeFile(destination, "destination\n");

  await expect(
    renameFilesSafely({
      [source]: { destination, expectedSha256: hash("source\n") },
    }),
  ).rejects.toThrow("destination already exists");
  expect(await readFile(source, "utf8")).toBe("source\n");
});

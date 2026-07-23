import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renameFilesSafely } from "../src/runtime/file-rename";

const created: string[] = [];
const originalRoots = process.env.AST_MCP_ROOTS;
const originalExternalRoots = process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;

function digest(value: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function root() {
  const value = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-rename-adversarial-"),
  );
  created.push(value);
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  return value;
}

afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((value) => rm(value, { force: true, recursive: true })),
  );
  if (originalRoots === undefined) delete process.env.AST_MCP_ROOTS;
  else process.env.AST_MCP_ROOTS = originalRoots;
  if (originalExternalRoots === undefined)
    delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  else process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = originalExternalRoots;
});

test("file_rename rejects duplicate destinations without mutating sources", async () => {
  const folder = await root();
  process.env.AST_MCP_ROOTS = folder;
  const first = path.join(folder, "first.txt");
  const second = path.join(folder, "second.txt");
  const destination = path.join(folder, "destination.txt");
  await writeFile(first, "first");
  await writeFile(second, "second");

  await expect(
    renameFilesSafely({
      [first]: { destination, expectedSha256: digest("first") },
      [second]: { destination, expectedSha256: digest("second") },
    }),
  ).rejects.toThrow("destinations must be unique");
  expect(await readFile(first, "utf8")).toBe("first");
  expect(await readFile(second, "utf8")).toBe("second");
});

test("file_rename uses byte hashes for binary files", async () => {
  const folder = await root();
  process.env.AST_MCP_ROOTS = folder;
  const source = path.join(folder, "source.bin");
  const destination = path.join(folder, "destination.bin");
  const payload = new Uint8Array([0, 255, 128, 1, 2]);
  await writeFile(source, payload);

  await renameFilesSafely({
    [source]: { destination, expectedSha256: digest(payload) },
  });

  expect(await readFile(destination)).toEqual(Buffer.from(payload));
});

test("file_rename rejects cross-root moves", async () => {
  const firstRoot = await root();
  const secondRoot = await root();
  process.env.AST_MCP_ROOTS = [firstRoot, secondRoot].join(path.delimiter);
  const source = path.join(firstRoot, "source.txt");
  const destination = path.join(secondRoot, "destination.txt");
  await writeFile(source, "source");

  await expect(
    renameFilesSafely({
      [source]: { destination, expectedSha256: digest("source") },
    }),
  ).rejects.toThrow("must share a root");
});

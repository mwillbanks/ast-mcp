import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ParserWorkerPool } from "../../src/intelligence/parser/index.ts";
import { deleteFilesSafely } from "../../src/runtime/file-delete";
import { sha256 } from "../../src/runtime/hash";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.AST_MCP_ROOTS;
  delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function root() {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-delete-batch-")),
  );
  roots.push(directory);
  await writeFile(path.join(directory, "ast-mcp.toml"), "version = 1\n");
  process.env.AST_MCP_ROOTS = roots.join(path.delimiter);
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  return directory;
}

const source = "export const value = 1;\n";
function request() {
  return { expectedSha256: sha256(source) };
}

test("delete batch inventories its root once and parses each external candidate once", async () => {
  const directory = await root();
  const a = path.join(directory, "a.ts");
  const b = path.join(directory, "b.ts");
  await writeFile(a, source);
  await writeFile(b, source);
  await mkdir(path.join(directory, "nested"));
  await writeFile(path.join(directory, "nested", "consumer.ts"), source);
  const inventory = spyOn(fs, "opendir");
  const parse = spyOn(ParserWorkerPool.prototype, "parse");
  try {
    await deleteFilesSafely({ [a]: request(), [b]: request() });
    expect(inventory.mock.calls.map(([directory]) => directory).sort()).toEqual(
      [directory, path.join(directory, "nested")].sort(),
    );
    expect(parse).toHaveBeenCalledTimes(1);
  } finally {
    inventory.mockRestore();
    parse.mockRestore();
  }
});

test("delete batch checks later targets and preserves all files on external references", async () => {
  const directory = await root();
  const a = path.join(directory, "a.ts");
  const b = path.join(directory, "b.ts");
  await writeFile(a, source);
  await writeFile(b, source);
  await writeFile(
    path.join(directory, "consumer.ts"),
    'import { value } from "./b";\nconsole.log(value);\n',
  );
  await expect(
    deleteFilesSafely({ [a]: request(), [b]: request() }),
  ).rejects.toThrow("referenced by consumer.ts");
  expect(await Bun.file(a).exists()).toBeTrue();
  expect(await Bun.file(b).exists()).toBeTrue();
});

test("delete batch excludes internal importers and bypasses advisory parsing explicitly", async () => {
  const directory = await root();
  const a = path.join(directory, "a.ts");
  const b = path.join(directory, "b.ts");
  const importing = 'import { value } from "./b";\nconsole.log(value);\n';
  await writeFile(a, importing);
  await writeFile(b, source);
  const parse = spyOn(ParserWorkerPool.prototype, "parse");
  try {
    await deleteFilesSafely({
      [a]: { expectedSha256: sha256(importing) },
      [b]: request(),
    });
    expect(parse).not.toHaveBeenCalled();
    await writeFile(b, source);
    await writeFile(path.join(directory, "broken.ts"), "export const = ;");
    const result = await deleteFilesSafely({
      [b]: { ...request(), forceReferences: true },
    });
    expect(parse).not.toHaveBeenCalled();
    expect(result.files[b]).toMatchObject({
      referenceVerificationBypassed: true,
    });
  } finally {
    parse.mockRestore();
  }
});

test("delete batch inventories each configured root once", async () => {
  const first = await root();
  const second = await root();
  const a = path.join(first, "a.ts");
  const b = path.join(second, "b.ts");
  await writeFile(a, source);
  await writeFile(b, source);
  await writeFile(path.join(first, "other.ts"), source);
  await writeFile(path.join(second, "other.ts"), source);
  const inventory = spyOn(fs, "opendir");
  const parse = spyOn(ParserWorkerPool.prototype, "parse");
  try {
    await deleteFilesSafely({ [a]: request(), [b]: request() });
    expect(inventory.mock.calls.map(([directory]) => directory).sort()).toEqual(
      [first, second].sort(),
    );
    expect(parse).toHaveBeenCalledTimes(2);
  } finally {
    inventory.mockRestore();
    parse.mockRestore();
  }
});

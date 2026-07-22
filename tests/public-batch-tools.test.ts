import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

test("public file tools execute keyed read, hash, write, and patch batches", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const folder = await mkdtemp(path.join(root, ".tmp-public-batch-"));
  const notes = path.join(folder, "notes.md");
  const first = path.join(folder, "first.txt");
  const second = path.join(folder, "second.txt");
  const originalNotes = "alpha\nbeta\n";
  await writeFile(notes, originalNotes);

  const client = new Client({ name: "public-batch-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.resolve(root, "src/index.ts")],
    command: "bun",
    cwd: root,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);

    const written = await client.callTool({
      arguments: {
        [first]: { content: "first\n" },
        [second]: { content: "second\n" },
      },
      name: "file_write",
    });
    expect(written.isError).not.toBeTrue();

    const read = await client.callTool({
      arguments: {
        files: [
          { filePath: first, lines: [0, 2] },
          { filePath: second, lines: [0, 2] },
        ],
      },
      name: "file_read",
    });
    expect(read.isError).not.toBeTrue();

    const hashes = await client.callTool({
      arguments: { filePaths: [first, second] },
      name: "file_hash",
    });
    expect(hashes.isError).not.toBeTrue();

    const patched = await client.callTool({
      arguments: {
        [notes]: {
          aiderBlocks: [
            { replace: "one", search: "alpha" },
            { replace: "two", search: "beta" },
          ],
          expectedSha256: sha256(originalNotes),
          patchStrategy: "aider_block",
        },
      },
      name: "file_patch",
    });
    expect(patched.isError).not.toBeTrue();
    expect(await readFile(notes, "utf8")).toBe("one\ntwo\n");

    const rejected = await client.callTool({
      arguments: {
        files: [{ filePath: path.join(root, "src/server.ts") }],
      },
      name: "file_read",
    });
    expect(rejected.isError).toBeTrue();
  } finally {
    await client.close();
    await rm(folder, { force: true, recursive: true });
  }
});

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import registerFileTools from "../src/tools/files";

type RegisteredTool = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

test("file tool handlers execute keyed batches without transport indirection", async () => {
  const folder = await mkdtemp(path.join(process.cwd(), ".tmp-file-tools-"));
  const registered = new Map<string, RegisteredTool>();
  const definitions = new Map<string, unknown>();
  const server = {
    registerTool(name: string, _definition: unknown, handler: RegisteredTool) {
      registered.set(name, handler);
      definitions.set(name, _definition);
    },
  };

  try {
    registerFileTools(server as never);
    const first = path.join(folder, "first.txt");
    const second = path.join(folder, "second.txt");
    const notes = path.join(folder, "notes.md");
    const writeSchema = (
      definitions.get("file_write") as {
        inputSchema: { safeParse: (value: unknown) => { success: boolean } };
      }
    ).inputSchema;
    const patchSchema = (
      definitions.get("file_patch") as {
        inputSchema: { safeParse: (value: unknown) => { success: boolean } };
      }
    ).inputSchema;
    expect(
      writeSchema.safeParse({ [first]: { content: "x" } }).success,
    ).toBeTrue();
    expect(
      patchSchema.safeParse({
        [notes]: {
          aiderBlocks: [{ replace: "x", search: "alpha" }],
          expectedSha256: "0".repeat(64),
          patchStrategy: "aider_block",
        },
      }).success,
    ).toBeTrue();
    await writeFile(notes, "alpha\nbeta\n");

    const written = await (registered.get("file_write") as RegisteredTool)({
      [first]: { content: "first\n" },
      [second]: { content: "second\n" },
    });
    expect(written.isError).not.toBeTrue();

    const read = await (registered.get("file_read") as RegisteredTool)({
      files: [
        { filePath: first, lines: [0, 2] },
        { filePath: second, lines: [0, 2] },
      ],
    });
    expect(read.isError).not.toBeTrue();

    const hashed = await (registered.get("file_hash") as RegisteredTool)({
      filePaths: [first, second],
    });
    expect(hashed.isError).not.toBeTrue();

    const hashFailure = await (registered.get("file_hash") as RegisteredTool)({
      filePaths: ["/etc/hosts"],
    });
    expect(hashFailure.isError).toBeTrue();

    const writeFailure = await (registered.get("file_write") as RegisteredTool)(
      {
        [path.join(process.cwd(), "src/server.ts")]: { content: "x" },
      },
    );
    expect(writeFailure.isError).toBeTrue();

    const original = await readFile(notes, "utf8");
    const patched = await (registered.get("file_patch") as RegisteredTool)({
      [notes]: {
        aiderBlocks: [
          { replace: "one", search: "alpha" },
          { replace: "two", search: "beta" },
        ],
        expectedSha256: createHash("sha256").update(original).digest("hex"),
        patchStrategy: "aider_block",
      },
    });
    expect(patched.isError).not.toBeTrue();
    expect(await readFile(notes, "utf8")).toBe("one\ntwo\n");

    const rejected = await (registered.get("file_read") as RegisteredTool)({
      files: [{ filePath: path.join(process.cwd(), "src/server.ts") }],
    });
    expect(rejected.isError).toBeTrue();
  } finally {
    await rm(folder, { force: true, recursive: true });
  }
}, 15_000);

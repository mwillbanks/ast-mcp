import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  structuredUpstreamToolResult,
  toolFailure,
} from "../src/helpers/mcp-schema";
import registerFileTools from "../src/tools/files";

type RegisteredTool = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

test("upstream tool results preserve structured success and failure", () => {
  const success = structuredUpstreamToolResult(
    { content: [{ text: "ok", type: "text" }] },
    "map",
  );
  expect(success).toMatchObject({ structuredContent: { ok: true } });

  const failure = structuredUpstreamToolResult(
    {
      content: [{ type: "image" }, { text: "upstream failed", type: "text" }],
      isError: true,
    },
    "map",
  );
  expect(failure).toMatchObject({
    isError: true,
    structuredContent: {
      error: {
        code: "upstream_tool_error",
        message: "upstream failed",
        suggestedNextCall: "map",
      },
      ok: false,
    },
  });
  expect(
    structuredUpstreamToolResult(
      { content: [{ type: "text" }], isError: true },
      "show",
    ),
  ).toMatchObject({
    structuredContent: { error: { message: "Upstream tool failed" } },
  });
  expect(
    toolFailure(new Error("Stale file context: expected abc, found def")),
  ).toMatchObject({
    structuredContent: {
      error: {
        code: "stale_or_missing_hash",
        retryable: true,
        suggestedNextCall: "file_hash",
      },
    },
  });
  expect(
    toolFailure(
      new Error(
        "file_patch requires expectedSha256 while safety.require_hash is enabled",
      ),
    ),
  ).toMatchObject({
    structuredContent: { error: { code: "stale_or_missing_hash" } },
  });
});

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
    const readSchema = (
      definitions.get("file_read") as {
        inputSchema: { safeParse: (value: unknown) => { success: boolean } };
      }
    ).inputSchema;
    expect(
      writeSchema.safeParse({ files: { [first]: { content: "x" } } }).success,
    ).toBeTrue();
    expect(
      patchSchema.safeParse({
        files: {
          [notes]: {
            aiderBlocks: [{ replace: "x", search: "alpha" }],
            expectedSha256: "0".repeat(64),
            patchStrategy: "aider_block",
          },
        },
      }).success,
    ).toBeTrue();
    expect(
      readSchema.safeParse({
        files: [{ filePath: notes, range: { end: 2, start: 0 } }],
      }).success,
    ).toBeTrue();
    expect(
      readSchema.safeParse({
        files: [
          { filePath: notes, lines: [0, 2], range: { end: 2, start: 0 } },
        ],
      }).success,
    ).toBeFalse();
    expect(
      patchSchema.safeParse({
        files: {
          [notes]: { previewReceipt: "8dcdf7de-8954-4a1b-88c4-aa3085741c50" },
        },
      }).success,
    ).toBeTrue();
    expect(
      patchSchema.safeParse({ files: { [notes]: {} } }).success,
    ).toBeFalse();
    expect(
      patchSchema.safeParse({
        files: {
          [notes]: {
            patchStrategy: "aider_block",
            previewReceipt: "8dcdf7de-8954-4a1b-88c4-aa3085741c50",
          },
        },
      }).success,
    ).toBeFalse();
    await writeFile(notes, "alpha\nbeta\n");

    const written = await (registered.get("file_write") as RegisteredTool)({
      files: {
        [first]: { content: "first\n" },
        [second]: { content: "second\n" },
      },
    });
    if (written.isError)
      throw new Error(
        written.content.map((item) => item.text ?? "").join("\n"),
      );
    expect(written.isError).not.toBeTrue();

    const read = await (registered.get("file_read") as RegisteredTool)({
      files: [
        { filePath: first, range: { end: 2, start: 0 } },
        { filePath: second, lines: [0, 2] },
      ],
    });
    expect(read.isError).not.toBeTrue();

    const hashed = await (registered.get("file_hash") as RegisteredTool)({
      filePaths: [first, second],
    });
    const capabilities = await (
      registered.get("file_capabilities") as RegisteredTool
    )({ filePaths: [notes] });
    expect(hashed.isError).not.toBeTrue();
    expect(capabilities.isError).not.toBeTrue();

    const hashFailure = await (registered.get("file_hash") as RegisteredTool)({
      filePaths: ["/etc/hosts"],
    });
    expect(hashFailure.isError).toBeTrue();

    const writeFailure = await (registered.get("file_write") as RegisteredTool)(
      {
        files: {
          [path.join(process.cwd(), "src/server.ts")]: { content: "x" },
        },
      },
    );
    expect(writeFailure.isError).toBeTrue();

    const original = await readFile(notes, "utf8");
    const patched = await (registered.get("file_patch") as RegisteredTool)({
      files: {
        [notes]: {
          aiderBlocks: [
            { replace: "one", search: "alpha" },
            { replace: "two", search: "beta" },
          ],
          expectedSha256: createHash("sha256").update(original).digest("hex"),
          patchStrategy: "aider_block",
        },
      },
    });
    if (patched.isError)
      throw new Error(
        patched.content.map((item) => item.text ?? "").join("\n"),
      );
    expect(patched.isError).not.toBeTrue();
    expect(await readFile(notes, "utf8")).toBe("one\ntwo\n");

    const astRead = await (registered.get("file_read") as RegisteredTool)({
      files: [{ filePath: path.join(process.cwd(), "src/server.ts") }],
    });
    const textRead = await (registered.get("file_read") as RegisteredTool)({
      files: [
        { filePath: path.join(process.cwd(), "src/server.ts"), mode: "text" },
      ],
    });
    expect(astRead.isError).not.toBeTrue();
    expect(textRead.isError).not.toBeTrue();
  } finally {
    await rm(folder, { force: true, recursive: true });
  }
}, 15_000);

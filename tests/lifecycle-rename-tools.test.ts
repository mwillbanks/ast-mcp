import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import registerLifecycleTools from "../src/tools/lifecycle";

test("registers lifecycle tools with keyed batch schemas", () => {
  const definitions = new Map<string, unknown>();
  registerLifecycleTools({
    registerTool(name: string, definition: unknown) {
      definitions.set(name, definition);
    },
  } as never);

  const schema = (name: string) =>
    (
      definitions.get(name) as {
        inputSchema: { safeParse: (value: unknown) => { success: boolean } };
      }
    ).inputSchema;

  expect(
    schema("file_rename").safeParse({
      "source.txt": {
        destination: "renamed.txt",
        expectedSha256: "a".repeat(64),
      },
    }).success,
  ).toBeTrue();
  for (const name of ["file_chattr", "file_delete", "file_rename"])
    expect(schema(name).safeParse({}).success).toBeFalse();
});

test("lifecycle handlers execute successful and failed requests", async () => {
  type ToolResult = {
    content: Array<{ text?: string; type: string }>;
    isError?: boolean;
  };
  type ToolHandler = (requests: Record<string, unknown>) => Promise<ToolResult>;
  const handlers = new Map<string, ToolHandler>();
  registerLifecycleTools({
    registerTool(name: string, _definition: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
    },
  } as never);
  const handler = (name: string) => {
    const registered = handlers.get(name);
    if (!registered) throw new Error(`missing lifecycle handler: ${name}`);
    return registered;
  };
  const success = (result: ToolResult) => {
    if (result.isError)
      throw new Error(result.content[0]?.text ?? "tool failed");
    return result;
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-lifecycle-"));
  const previousRoots = process.env.AST_MCP_ROOTS;
  const previousExternalRoots = process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  process.env.AST_MCP_ROOTS = root;
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  try {
    const attributesPath = path.join(root, "attributes.txt");
    await writeFile(attributesPath, "attributes");
    const changed = success(
      await handler("file_chattr")({
        [attributesPath]: {
          chattr: { chmod: 0o600 },
          expectedSha256: digest("attributes"),
        },
      }),
    );
    expect(changed.isError).toBeUndefined();
    expect(changed.content[0]?.text).toContain(attributesPath);

    const stale = await handler("file_chattr")({
      [attributesPath]: {
        chattr: { chmod: 0o600 },
        expectedSha256: "0".repeat(64),
      },
    });
    expect(stale.isError).toBeTrue();
    expect(stale.content[0]?.text).toContain("Stale file context");

    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await writeFile(source, "rename");
    const renamed = success(
      await handler("file_rename")({
        [source]: { destination, expectedSha256: digest("rename") },
      }),
    );
    expect(renamed.isError).toBeUndefined();
    expect(await readFile(destination, "utf8")).toBe("rename");

    const deleted = success(
      await handler("file_delete")({
        [destination]: { expectedSha256: digest("rename") },
      }),
    );
    expect(deleted.isError).toBeUndefined();
    expect(deleted.content[0]?.text).toContain(destination);
    const missing = await handler("file_delete")({
      [destination]: { expectedSha256: digest("rename") },
    });
    expect(missing.isError).toBeTrue();
  } finally {
    if (previousRoots === undefined) delete process.env.AST_MCP_ROOTS;
    else process.env.AST_MCP_ROOTS = previousRoots;
    if (previousExternalRoots === undefined)
      delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
    else process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = previousExternalRoots;
    await rm(root, { force: true, recursive: true });
  }
});

import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addAbortSignal, PassThrough } from "node:stream";

import { deleteFilesSafely } from "../../src/runtime/file-delete";
import { sha256 } from "../../src/runtime/hash";
test("delete reference preflight cancels a stalled stream without deleting target bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-delete-stream-"));
  const previous = {
    AST_MCP_ROOTS: process.env.AST_MCP_ROOTS,
    AST_MCP_ALLOW_EXTERNAL_ROOTS: process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS,
  };
  process.env.AST_MCP_ROOTS = root;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  await writeFile(path.join(root, "ast-mcp.toml"), "version = 1\n");
  const target = path.join(root, "target.ts");
  const candidate = path.join(root, "other.ts");
  await writeFile(target, "export const target = 1;");
  await writeFile(candidate, "export const other = 2;");
  const abort = new AbortController();
  const started = Promise.withResolvers<void>();
  const stream = new PassThrough();
  const actual = fs.createReadStream;
  const create = spyOn(fs, "createReadStream").mockImplementation(
    (file, options) => {
      if (path.basename(String(file)) !== "other.ts")
        return actual(file, options);
      addAbortSignal((options as { signal: AbortSignal }).signal, stream);
      started.resolve();
      return stream as unknown as ReturnType<typeof fs.createReadStream>;
    },
  );
  const operation = deleteFilesSafely(
    { [target]: { expectedSha256: sha256("export const target = 1;") } },
    abort.signal,
  );
  const failure = new Error("delete cancelled");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started.promise,
      operation.then(() => {
        throw new Error("Delete completed before reference read");
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Reference read never started")),
          2000,
        );
      }),
    ]);
    abort.abort(failure);
    await expect(operation).rejects.toBe(failure);
    expect(stream.destroyed).toBe(true);
    expect(await readFile(target, "utf8")).toBe("export const target = 1;");
  } finally {
    clearTimeout(timeout);
    abort.abort(failure);
    stream.destroy();
    await operation.catch(() => undefined);
    create.mockRestore();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

import { afterEach, expect, spyOn, test } from "bun:test";
import * as streamFs from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { renameFilesSafely } from "../../src/runtime/file-rename";
import { readFileSnapshot } from "../../src/runtime/file-snapshot";
import { sha256 } from "../../src/runtime/hash";
import { readSubprocessOutput } from "../../src/runtime/subprocess";

const folders: string[] = [];
const originalRoots = process.env.AST_MCP_ROOTS;
const originalExternalRoots = process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => fs.rm(folder, { recursive: true, force: true })),
  );
  if (originalRoots === undefined) delete process.env.AST_MCP_ROOTS;
  else process.env.AST_MCP_ROOTS = originalRoots;
  if (originalExternalRoots === undefined)
    delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  else process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = originalExternalRoots;
});

test("rename verification failure removes the newly linked destination", async () => {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-rename-verification-"),
  );
  folders.push(folder);
  process.env.AST_MCP_ROOTS = folder;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  await fs.writeFile(path.join(folder, "ast-mcp.toml"), "version = 1\n");
  const source = path.join(folder, "source.txt");
  const destination = path.join(folder, "destination.txt");
  await fs.writeFile(source, "original");
  const actualLstat = fs.lstat;
  const inspect = spyOn(fs, "lstat").mockImplementation((async (
    filePath: Parameters<typeof fs.lstat>[0],
  ) => {
    const result = await actualLstat(filePath);
    if (path.basename(String(filePath)) === "destination.txt")
      throw new Error("post-link verification failed");
    return result;
  }) as typeof fs.lstat);
  try {
    await expect(
      renameFilesSafely({
        [source]: {
          destination,
          expectedSha256: new Bun.CryptoHasher("sha256")
            .update("original")
            .digest("hex"),
        },
      }),
    ).rejects.toThrow("post-link verification failed");
  } finally {
    inspect.mockRestore();
  }
  expect(await fs.readFile(source, "utf8")).toBe("original");
  await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

test("snapshot digest matches rollback bytes when the file changes during capture", async () => {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-snapshot-race-"),
  );
  folders.push(folder);
  const file = path.join(folder, "source.txt");
  await fs.writeFile(file, "before");
  const read = spyOn(streamFs, "createReadStream").mockImplementation(() => {
    streamFs.writeFileSync(file, "after");
    return Readable.from([Buffer.from("before")]) as ReturnType<
      typeof streamFs.createReadStream
    >;
  });
  try {
    const snapshot = await readFileSnapshot(file);
    expect(snapshot.sha256).toBe(sha256(snapshot.content));
  } finally {
    read.mockRestore();
  }
});

test("rename cancellation after linking restores the source without residual destinations", async () => {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-rename-abort-"),
  );
  folders.push(folder);
  process.env.AST_MCP_ROOTS = folder;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  await fs.writeFile(path.join(folder, "ast-mcp.toml"), "version = 1\n");
  const source = path.join(folder, "source.txt");
  const destination = path.join(folder, "destination.txt");
  await fs.writeFile(source, "original");
  const abort = new AbortController();
  const failure = new Error("cancelled during link");
  const actualLink = fs.link;
  const link = spyOn(fs, "link").mockImplementation(async (source, target) => {
    await actualLink(source, target);
    if (path.basename(String(target)) === "destination.txt")
      abort.abort(failure);
  });
  try {
    await expect(
      renameFilesSafely(
        { [source]: { destination, expectedSha256: sha256("original") } },
        abort.signal,
      ),
    ).rejects.toBe(failure);
  } finally {
    link.mockRestore();
  }
  expect(await fs.readFile(source, "utf8")).toBe("original");
  await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

for (const before of [true, false])
  test(`subprocess output rejects ${before ? "prior" : "in-flight"} cancellation without returning partial bytes`, async () => {
    const abort = new AbortController();
    const failure = new Error("request cancelled");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(new TextEncoder().encode("partial"));
      },
      cancel() {
        cancelled = true;
      },
    });
    if (before) abort.abort(failure);
    const operation = readSubprocessOutput(
      stream,
      abort.signal,
      async () => {},
    );
    if (!before) abort.abort(failure);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          operation,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Cancellation did not settle output")),
              1000,
            );
          }),
        ]),
      ).rejects.toBe(failure);
      expect(stream.locked).toBe(false);
      if (!before) expect(cancelled).toBe(true);
    } finally {
      clearTimeout(timer);
      if (!cancelled) controller.close();
      await operation.catch(() => undefined);
    }
  });

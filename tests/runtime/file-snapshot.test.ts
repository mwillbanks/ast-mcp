import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readFileSnapshot } from "../../src/runtime/file-snapshot";
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});
test("snapshot rejects prior cancellation before opening an absent path", async () => {
  const abort = new AbortController();
  const failure = new Error("cancelled");
  abort.abort(failure);
  await expect(
    readFileSnapshot("/missing/snapshot-fixture", abort.signal),
  ).rejects.toBe(failure);
});
test.skipIf(process.platform === "win32")(
  "snapshot rejects a FIFO without waiting for a writer",
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-snapshot-fifo-"),
    );
    folders.push(root);
    const fifo = path.join(root, "pipe");
    const create = Bun.spawn(["mkfifo", fifo], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await create.exited).toBe(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          readFileSnapshot(fifo),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("FIFO snapshot blocked")),
              1000,
            );
          }),
        ]),
      ).rejects.toMatchObject({ code: "file_not_regular" });
    } finally {
      clearTimeout(timer);
    }
  },
);
test("snapshot reads regular file bytes and rejects directories", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-snapshot-regular-"),
  );
  folders.push(root);
  const file = path.join(root, "entry.txt");
  await writeFile(file, "contents");
  expect((await readFileSnapshot(file)).content.toString()).toBe("contents");
  await expect(readFileSnapshot(root)).rejects.toMatchObject({
    code: "file_not_regular",
  });
});

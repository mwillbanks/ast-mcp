import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readFileSnapshot } from "../../src/runtime/file-snapshot";

test.skipIf(process.platform === "win32")(
  "snapshot rejects a FIFO without waiting for a writer",
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-snapshot-fifo-"),
    );
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
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

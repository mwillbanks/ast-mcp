import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { writeFileSafely } from "../src/patch/engine";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

test("rejects a stale hash before replacing unsupported content", async () => {
  const folder = await mkdtemp(path.join(process.cwd(), ".tmp-stale-write-"));
  folders.push(folder);
  const filePath = path.join(folder, "notes.txt");
  await writeFile(filePath, "current\n");

  await expect(
    writeFileSafely({
      content: "replacement\n",
      expectedSha256: "0".repeat(64),
      filePath,
    }),
  ).rejects.toThrow("Stale file context");
});

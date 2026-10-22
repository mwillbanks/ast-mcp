import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { withConfig } from "../../src/config";
import { patchFile, writeFileSafely } from "../../src/patch/engine";
import { sha256 } from "../../src/runtime/hash";
import { hermeticConfig } from "../support/hermetic-config";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

test("single-file patches validate and commit the expected candidate", async () => {
  const folder = await mkdtemp(path.join(process.cwd(), ".tmp-single-patch-"));
  folders.push(folder);
  const filePath = path.join(folder, "value.ts");
  const original = "export const answer = 1;\n";
  await writeFile(filePath, original);
  await withConfig(hermeticConfig(folder), async () => {
    const result = await patchFile({
      filePath,
      expectedSha256: sha256(original),
      patchStrategy: "aider_block",
      aiderBlock: { search: "answer = 1", replace: "answer = 2" },
    });
    const expected = "export const answer = 2;\n";
    expect(result.sha256).toBe(sha256(expected));
    expect(await Bun.file(filePath).text()).toBe(expected);
    await expect(
      patchFile({
        filePath,
        expectedSha256: sha256(original),
        patchStrategy: "aider_block",
        aiderBlock: { search: "answer = 2", replace: "answer = 3" },
      }),
    ).rejects.toThrow("Stale file context");
    expect(await Bun.file(filePath).text()).toBe(expected);
  });
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

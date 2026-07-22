import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { patchFile, writeFileSafely } from "../src/patch/engine";
import { sha256 } from "../src/runtime/hash";
import { withFileLock, withFileLocks } from "../src/runtime/locks";

const folders: string[] = [];
afterEach(async () => {
  delete process.env.AST_MCP_ROOTS;
  delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});
async function root() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-engine-"));
  folders.push(folder);
  process.env.AST_MCP_ROOTS = folder;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  return folder;
}

describe("write state machine", () => {
  test("creates and SHA-guards files", async () => {
    const folder = await root();
    const file = path.join(folder, "note.txt");
    const created = await writeFileSafely({
      content: "# title\n",
      filePath: file,
    });
    expect(created.created).toBeTrue();
    await expect(
      writeFileSafely({ content: "# changed\n", filePath: file }),
    ).rejects.toThrow("requires expectedSha256");
    await writeFileSafely({
      content: "# changed\n",
      expectedSha256: sha256(await readFile(file, "utf8")),
      filePath: file,
    });
    expect(await readFile(file, "utf8")).toContain("changed");
  });
  test("routes unsupported files to aider blocks", async () => {
    const folder = await root();
    const file = path.join(folder, "data.txt");
    await writeFile(file, "alpha\nbeta\n");
    const hash = sha256(await readFile(file, "utf8"));
    await expect(
      patchFile({
        astRule: { fix: "gamma", pattern: "beta" },
        expectedSha256: hash,
        filePath: file,
        patchStrategy: "ast",
      }),
    ).rejects.toThrow("aider_block");
    const result = await patchFile({
      aiderBlock: { replace: "gamma", search: "beta" },
      expectedSha256: hash,
      filePath: file,
      patchStrategy: "aider_block",
    });
    expect(result.strategy).toBe("aider_block");
  });
  test("rejects paths outside roots and stale hashes", async () => {
    const folder = await root();
    const file = path.join(folder, "value.ts");
    await writeFile(file, "const value = 1\n");
    await expect(
      patchFile({
        astRule: { fix: "replacement", pattern: "value" },
        expectedSha256: "0".repeat(64),
        filePath: file,
        patchStrategy: "ast",
      }),
    ).rejects.toThrow("Stale");
    await expect(
      writeFileSafely({
        content: "x",
        filePath: path.join(os.tmpdir(), "outside.md"),
      }),
    ).rejects.toThrow("outside");
  });

  test("serializes in-process and cross-process file locks", async () => {
    const folder = await root();
    const file = path.join(folder, "value.txt");
    const externalLock = path.join(folder, ".value.txt.ast-mcp.lock");
    await writeFile(externalLock, "held");
    const release = setTimeout(() => {
      void rm(externalLock, { force: true });
    }, 20);
    try {
      expect(await withFileLock(file, async () => "locked")).toBe("locked");
    } finally {
      clearTimeout(release);
      await rm(externalLock, { force: true });
    }
    const second = path.join(folder, "second.txt");
    expect(
      await withFileLocks([second, file, second], async () => "multi-locked"),
    ).toBe("multi-locked");
    expect(
      await withFileLock(
        path.join(folder, "missing", "value.txt"),
        async () => "no",
      ),
    ).toBe("no");
  });
});

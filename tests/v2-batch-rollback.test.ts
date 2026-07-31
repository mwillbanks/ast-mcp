import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withConfig } from "../src/config";
import { patchFiles, writeFilesSafely } from "../src/patch/engine";
import { sha256 } from "../src/runtime/hash";

async function configuredRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(root, ".git"));
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    [
      "version = 2",
      "[formatting]",
      "enabled = false",
      'fallback = "preserve"',
      "[[paths]]",
      'id = "workspace"',
      'path = "."',
      'policies = { read = "allow", write = "allow", delete = "allow" }',
      "",
    ].join("\n"),
  );
  return root;
}

function options(root: string) {
  return {
    cwd: root,
    env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
  };
}

test("batch preflight cleans preview receipts when a later entry fails", async () => {
  const root = await configuredRoot("ast-mcp-preview-cleanup-");
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  await writeFile(first, "first\n");
  await writeFile(second, "second\n");
  try {
    await expect(
      withConfig(options(root), () =>
        patchFiles({
          [first]: {
            aiderBlocks: [{ replace: "preview", search: "first" }],
            expectedSha256: sha256("first\n"),
            patchStrategy: "aider_block",
            preview: true,
          },
          [second]: {
            aiderBlocks: [{ replace: "changed", search: "second" }],
            expectedSha256: "0".repeat(64),
            patchStrategy: "aider_block",
          },
        }),
      ),
    ).rejects.toThrow("Stale file context");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("patch and write batches roll back earlier commits after a commit-time source change", async () => {
  const root = await configuredRoot("ast-mcp-batch-rollback-");
  const first = path.join(root, "first.txt");
  const blocked = path.join(root, "blocked");
  const second = path.join(blocked, "second.deny");
  const created = path.join(root, "created.txt");
  await mkdir(blocked);
  await writeFile(first, "first-before\n");
  await writeFile(second, "second-before\n");
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    [
      "version = 2",
      "[formatting]",
      "enabled = true",
      'fallback = "preserve"',
      "[[formatting.formatters]]",
      'id = "change-source-after-lock"',
      "enabled = true",
      'extensions = [".deny"]',
      'command = "/usr/bin/truncate"',
      'args = ["-s", "0", "{source_file}"]',
      'mode = "stdout"',
      "[[paths]]",
      'id = "workspace"',
      'path = "."',
      'policies = { read = "allow", write = "allow", delete = "allow" }',
      "",
    ].join("\n"),
  );
  try {
    await expect(
      withConfig(options(root), () =>
        patchFiles({
          [first]: {
            aiderBlocks: [{ replace: "first-after", search: "first-before" }],
            expectedSha256: sha256("first-before\n"),
            patchStrategy: "aider_block",
          },
          [second]: {
            aiderBlocks: [{ replace: "second-after", search: "second-before" }],
            expectedSha256: sha256("second-before\n"),
            patchStrategy: "aider_block",
          },
        }),
      ),
    ).rejects.toThrow("Stale file context");
    expect(await readFile(first, "utf8")).toBe("first-before\n");

    await writeFile(second, "second-before\n");
    await expect(
      withConfig(options(root), () =>
        writeFilesSafely({
          [created]: { content: "created\n" },
          [second]: {
            content: "second-written\n",
            expectedSha256: sha256("second-before\n"),
          },
        }),
      ),
    ).rejects.toThrow("Stale file context");
    expect(
      await stat(created).then(
        () => true,
        () => false,
      ),
    ).toBeFalse();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("write results are finalized before restrictive metadata is committed", async () => {
  const root = await configuredRoot("ast-mcp-write-finalized-");
  const target = path.join(root, "private.txt");
  try {
    const result = await withConfig(options(root), () =>
      writeFilesSafely({
        [target]: { chattr: { chmod: 0 }, content: "private\n" },
      }),
    );
    expect((result.files as Record<string, unknown>)[target]).toMatchObject({
      chattr: { chmod: 0 },
      sha256: sha256("private\n"),
    });
    expect((await stat(target)).mode & 0o777).toBe(0);
  } finally {
    await chmod(target, 0o600).catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

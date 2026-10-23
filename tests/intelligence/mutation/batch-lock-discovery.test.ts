import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  lockPathIdentity,
  withFencedFileLocks,
} from "../../../src/intelligence/mutation/locks.ts";
import { sha256 } from "../../../src/runtime/hash.ts";

async function fixture() {
  return fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ast-mcp-batch-discovery-")),
  );
}

test("batch discovers each shared ancestor marker once and retains distinct file databases", async () => {
  const root = await fixture();
  const source = path.join(root, "src", "deep");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(path.join(root, ".git"));
  const files = Array.from({ length: 12 }, (_, index) =>
    path.join(source, `file-${index}.ts`),
  );
  const counts = new Map<string, number>();
  const original = fs.lstat;
  const stat = spyOn(fs, "lstat").mockImplementation((async (
    ...args: Parameters<typeof fs.lstat>
  ) => {
    const target = String(args[0]);
    if (
      path.basename(target) === ".git" ||
      path.basename(target) === "ast-mcp.toml"
    )
      counts.set(target, (counts.get(target) ?? 0) + 1);
    return original(...args);
  }) as typeof fs.lstat);
  try {
    await withFencedFileLocks(files, async (leases) => {
      expect(leases).toHaveLength(files.length);
      for (const lease of leases) await lease.fence();
    });
    expect(counts.get(path.join(root, ".git"))).toBe(1);
    expect(counts.get(path.join(source, ".git"))).toBe(1);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
    const databases = (
      await fs.readdir(path.join(root, ".git", "ast-mcp-locks"))
    ).filter((name) => name.endsWith(".sqlite"));
    expect(databases.sort()).toEqual(
      files.map((file) => `${sha256(lockPathIdentity(file))}.sqlite`).sort(),
    );
  } finally {
    stat.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch preserves linked-worktree and nested repository boundaries and deduplicates aliases", async () => {
  const root = await fixture();
  const checkout = path.join(root, "checkout");
  const metadata = path.join(root, "metadata");
  const nested = path.join(checkout, "nested");
  await fs.mkdir(path.join(nested, ".git"), { recursive: true });
  await fs.mkdir(metadata);
  await fs.writeFile(path.join(checkout, ".git"), "gitdir: ../metadata\n");
  const alias = path.join(root, "alias");
  await fs.symlink(
    checkout,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const files = [
    path.join(checkout, "a.ts"),
    path.join(checkout, "b.ts"),
    path.join(nested, "c.ts"),
  ];
  let pointerReads = 0;
  const original = fs.open;
  const opened = spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]) === path.join(checkout, ".git")) pointerReads++;
    return original(...args);
  });
  try {
    await withFencedFileLocks(
      [...files, path.join(alias, "a.ts")],
      async (leases) => {
        expect(leases).toHaveLength(3);
        for (const lease of leases) await lease.fence();
      },
    );
    expect(pointerReads).toBe(1);
    expect(
      (await fs.readdir(path.join(metadata, "ast-mcp-locks"))).filter((name) =>
        name.endsWith(".sqlite"),
      ),
    ).toHaveLength(2);
    expect(
      (await fs.readdir(path.join(nested, ".git", "ast-mcp-locks"))).filter(
        (name) => name.endsWith(".sqlite"),
      ),
    ).toHaveLength(1);
  } finally {
    opened.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("subsequent batches revalidate changed configuration and Git markers", async () => {
  const root = await fixture();
  const child = path.join(root, "child");
  await fs.mkdir(child);
  await fs.writeFile(path.join(root, "ast-mcp.toml"), "");
  const file = path.join(child, "a.ts");
  try {
    await withFencedFileLocks([file], async () => {});
    expect(
      (await fs.readdir(path.join(root, ".ast-mcp-locks"))).filter((name) =>
        name.endsWith(".sqlite"),
      ),
    ).toHaveLength(1);
    await fs.writeFile(path.join(child, "ast-mcp.toml"), "");
    await withFencedFileLocks([file], async () => {});
    expect(
      (await fs.readdir(path.join(child, ".ast-mcp-locks"))).filter((name) =>
        name.endsWith(".sqlite"),
      ),
    ).toHaveLength(1);
    await fs.mkdir(path.join(child, ".git"));
    await withFencedFileLocks([file], async () => {});
    expect(
      (await fs.readdir(path.join(child, ".git", "ast-mcp-locks"))).filter(
        (name) => name.endsWith(".sqlite"),
      ),
    ).toHaveLength(1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cancelled batch skips discovery and preserves explicit database selection", async () => {
  const root = await fixture();
  const marker = path.join(root, ".git");
  await fs.writeFile(marker, "invalid pointer");
  try {
    await expect(
      withFencedFileLocks([path.join(root, "a.ts")], async () => {}, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "lock_aborted" });
    await withFencedFileLocks(
      [path.join(root, "a.ts")],
      async (leases) => {
        await leases[0]!.fence();
      },
      { sharedDatabasePath: path.join(root, "explicit.sqlite") },
    );
    expect(await fs.readFile(marker, "utf8")).toBe("invalid pointer");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

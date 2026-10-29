import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { deleteFilesSafely } from "../../src/runtime/file-delete";
import { sha256 } from "../../src/runtime/hash";
import * as mutationLocks from "../../src/runtime/locks";
import { withFileLock } from "../../src/runtime/locks";

let root = "";

afterEach(async () => {
  delete process.env.AST_MCP_ROOTS;
  delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  if (root) await rm(root, { force: true, recursive: true });
  root = "";
});

async function temporaryRoot() {
  root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-delete-"));
  await writeFile(path.join(root, "ast-mcp.toml"), "version = 1\n");
  process.env.AST_MCP_ROOTS = root;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  return root;
}

test("file_delete verifies hashes and cleans empty ancestors", async () => {
  const folder = await temporaryRoot();
  const filePath = path.join(folder, "nested", "deeper", "note.txt");
  const content = "delete me\n";
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);

  const result = await deleteFilesSafely({
    [filePath]: { expectedSha256: sha256(content) },
  });

  expect(
    await readFile(filePath, "utf8").catch(() => undefined),
  ).toBeUndefined();
  expect(result.removedDirectories).toEqual([
    path.join(await realpath(folder), "nested"),
    path.join(await realpath(folder), "nested", "deeper"),
  ]);
});

test("file_delete cleans empty directories beginning with two dots", async () => {
  const folder = await temporaryRoot();
  const filePath = path.join(folder, "..cache", "deeper", "note.txt");
  const content = "delete me\n";
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);

  const result = await deleteFilesSafely({
    [filePath]: { expectedSha256: sha256(content) },
  });

  expect(result.removedDirectories).toEqual([
    path.join(await realpath(folder), "..cache"),
    path.join(await realpath(folder), "..cache", "deeper"),
  ]);
});

test("file_delete keeps completed deletion successful when cleanup races", async () => {
  const folder = await temporaryRoot();
  const filePath = path.join(folder, "nested", "note.txt");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "delete me\n");
  const cleanupRace = Object.assign(new Error("directory became non-empty"), {
    code: "ENOTEMPTY",
  });
  const actualRmdir = fsPromises.rmdir;
  const cleanupDirectory = await realpath(path.dirname(filePath));
  const rmdir = spyOn(fsPromises, "rmdir").mockImplementation(
    async (directory) => {
      if (String(directory) === cleanupDirectory) throw cleanupRace;
      return actualRmdir(directory);
    },
  );
  try {
    const result = await deleteFilesSafely({
      [filePath]: { expectedSha256: sha256("delete me\n") },
    });
    expect(await Bun.file(filePath).exists()).toBeFalse();
    expect(result.removedDirectories).toEqual([]);
  } finally {
    rmdir.mockRestore();
  }
});

test("file_delete cancels while waiting for a held mutation lease", async () => {
  const folder = await temporaryRoot();
  const filePath = path.join(folder, "contended.txt");
  const content = "preserved\n";
  await writeFile(filePath, content);
  const canonical = await realpath(filePath);
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const releaseHolder = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withFileLock(canonical, async () => {
    acquired();
    await releaseHolder;
  });
  await held;
  const controller = new AbortController();
  const waiting = Promise.withResolvers<void>();
  const originalLocks = mutationLocks.withFileLocks;
  const locks = spyOn(mutationLocks, "withFileLocks").mockImplementation(((
    ...args: Parameters<typeof originalLocks>
  ) => {
    const pending = originalLocks(...args);
    if (args[2]?.signal === controller.signal) {
      expect(args[0]).toEqual([canonical]);
      // The real queue registers its cancellation listener before returning.
      waiting.resolve();
    }
    return pending;
  }) as typeof originalLocks);
  const deletion = deleteFilesSafely(
    { [filePath]: { expectedSha256: sha256(content) } },
    controller.signal,
  );
  try {
    await Promise.race([
      waiting.promise,
      Bun.sleep(5_000).then(() => {
        throw new Error("Deletion did not reach mutation lease acquisition");
      }),
    ]);
    controller.abort();
    await expect(
      Promise.race([
        deletion,
        Bun.sleep(500).then(() => {
          throw new Error("Deletion still waits for the held lease");
        }),
      ]),
    ).rejects.toMatchObject({ code: "lock_aborted" });
    expect(await readFile(filePath, "utf8")).toBe(content);
  } finally {
    release();
    await holder;
    await deletion.catch(() => undefined);
    locks.mockRestore();
  }
});

test("file_delete reports committed deletion when cleanup lease remains held", async () => {
  const folder = await temporaryRoot();
  const canonical = await realpath(folder);
  const filePath = path.join(folder, "nested", "note.txt");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "delete me\n");
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const releaseHolder = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withFileLock(
    path.join(canonical, ".ast-mcp-directory-cleanup"),
    async () => {
      acquired();
      await releaseHolder;
    },
  );
  await held;
  const started = performance.now();
  try {
    const result = await deleteFilesSafely({
      [filePath]: { expectedSha256: sha256("delete me\n") },
    });
    expect(result.cleanup).toEqual({
      status: "deferred",
      code: "lock_deadline",
    });
    expect(result.removedDirectories).toEqual([]);
    expect(await Bun.file(filePath).exists()).toBeFalse();
    expect(await fsPromises.stat(path.dirname(filePath))).toBeDefined();
    expect(performance.now() - started).toBeLessThan(2_000);
  } finally {
    release();
    await holder;
  }
});

test("file_delete reports cleanup errors after successful target deletion", async () => {
  const folder = await temporaryRoot();
  for (const code of ["EACCES", "EPERM", "lock_fenced", "unexpected_failure"]) {
    const filePath = path.join(folder, code, "note.txt");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "delete me\n");
    const cleanupError = Object.assign(new Error("private cleanup path"), {
      code,
    });
    const actualRmdir = fsPromises.rmdir;
    const cleanupDirectory = await realpath(path.dirname(filePath));
    const rmdir = spyOn(fsPromises, "rmdir").mockImplementation(
      async (directory) => {
        if (String(directory) === cleanupDirectory) throw cleanupError;
        return actualRmdir(directory);
      },
    );
    try {
      const result = await deleteFilesSafely({
        [filePath]: { expectedSha256: sha256("delete me\n") },
      });
      expect(result.cleanup).toEqual({
        status: "failed",
        code: code === "unexpected_failure" ? "cleanup_failed" : code,
      });
      expect(result.removedDirectories).toEqual([]);
      expect(await Bun.file(filePath).exists()).toBeFalse();
      expect(JSON.stringify(result)).not.toContain("private cleanup path");
    } finally {
      rmdir.mockRestore();
    }
  }
});

test("file_delete rejects stale hashes without deleting the target", async () => {
  const folder = await temporaryRoot();
  const filePath = path.join(folder, "note.txt");
  await writeFile(filePath, "current\n");

  await expect(
    deleteFilesSafely({ [filePath]: { expectedSha256: sha256("stale\n") } }),
  ).rejects.toThrow("Stale file context");
  expect(await readFile(filePath, "utf8")).toBe("current\n");
});

test("file_delete verifies byte-accurate hashes for cache artifacts", async () => {
  const folder = await temporaryRoot();
  const chunks = path.join(folder, ".ast-mcp", "intelligence", "chunks.bin");
  const embeddings = path.join(
    folder,
    ".ast-mcp",
    "intelligence",
    "embeddings.bin",
  );
  const chunkContent = new Uint8Array([0, 255, 254, 1, 128]);
  const embeddingContent = new Uint8Array([255, 0, 129, 2]);
  await mkdir(path.dirname(chunks), { recursive: true });
  await writeFile(chunks, chunkContent);
  await writeFile(embeddings, embeddingContent);

  await deleteFilesSafely({
    [chunks]: { expectedSha256: sha256(chunkContent) },
    [embeddings]: { expectedSha256: sha256(embeddingContent) },
  });

  expect(await readFile(chunks).catch(() => undefined)).toBeUndefined();
  expect(await readFile(embeddings).catch(() => undefined)).toBeUndefined();
});

test("file_delete rejects referenced source unless explicitly overridden", async () => {
  const folder = await temporaryRoot();
  const source = path.join(folder, "source.ts");
  const importer = path.join(folder, "importer.ts");
  await writeFile(source, "export const source = 1;\n");
  await writeFile(
    importer,
    'import { source } from "./source";\nconsole.log(source);\n',
  );

  const content = await readFile(source, "utf8");
  await expect(
    deleteFilesSafely({ [source]: { expectedSha256: sha256(content) } }),
  ).rejects.toThrow("referenced by");
  await deleteFilesSafely({
    [source]: { expectedSha256: sha256(content), forceReferences: true },
  });
  expect(await readFile(source, "utf8").catch(() => undefined)).toBeUndefined();
});

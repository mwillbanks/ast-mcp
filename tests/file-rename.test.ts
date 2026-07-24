import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renameFilesSafely } from "../src/runtime/file-rename";

const roots: string[] = [];
const originalRoots = process.env.AST_MCP_ROOTS;
const originalExternalRoots = process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-rename-"));
  roots.push(root);
  process.env.AST_MCP_ROOTS = root;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
  if (originalRoots === undefined) delete process.env.AST_MCP_ROOTS;
  else process.env.AST_MCP_ROOTS = originalRoots;
  if (originalExternalRoots === undefined)
    delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  else process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = originalExternalRoots;
});

test("file_rename atomically batches hash-guarded file moves", async () => {
  const root = await temporaryRoot();
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  const firstDestination = path.join(root, "renamed-first.txt");
  const secondDestination = path.join(root, "renamed-second.txt");
  await writeFile(first, "first\n");
  await writeFile(second, "second\n");

  const result = await renameFilesSafely({
    [first]: { destination: firstDestination, expectedSha256: hash("first\n") },
    [second]: {
      destination: secondDestination,
      expectedSha256: hash("second\n"),
    },
  });

  expect(Object.values(result.files)).toHaveLength(2);
  expect(await readFile(firstDestination, "utf8")).toBe("first\n");
  expect(await readFile(secondDestination, "utf8")).toBe("second\n");
});

test("file_rename rejects stale context before moving any file", async () => {
  const root = await temporaryRoot();
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  const firstDestination = path.join(root, "renamed-first.txt");
  const secondDestination = path.join(root, "renamed-second.txt");
  await writeFile(first, "first\n");
  await writeFile(second, "second\n");

  await expect(
    renameFilesSafely({
      [first]: {
        destination: firstDestination,
        expectedSha256: hash("first\n"),
      },
      [second]: {
        destination: secondDestination,
        expectedSha256: hash("stale\n"),
      },
    }),
  ).rejects.toThrow("Stale file context");
  expect(await readFile(first, "utf8")).toBe("first\n");
  expect(await readFile(second, "utf8")).toBe("second\n");
});

test("file_rename refuses an existing destination", async () => {
  const root = await temporaryRoot();
  const source = path.join(root, "source.txt");
  const destination = path.join(root, "destination.txt");
  await writeFile(source, "source\n");
  await writeFile(destination, "destination\n");

  await expect(
    renameFilesSafely({
      [source]: { destination, expectedSha256: hash("source\n") },
    }),
  ).rejects.toThrow("destination already exists");
  expect(await readFile(source, "utf8")).toBe("source\n");
});

test("file_rename reports probe failures and probe cleanup failures", async () => {
  const root = await temporaryRoot();
  const source = path.join(root, "source.txt");
  const destination = path.join(root, "destination.txt");
  await writeFile(source, "source\n");

  const link = spyOn(fsPromises, "link").mockRejectedValueOnce(
    new Error("link unavailable"),
  );
  try {
    await expect(
      renameFilesSafely({
        [source]: { destination, expectedSha256: hash("source\n") },
      }),
    ).rejects.toThrow("requires hard-link support");
  } finally {
    link.mockRestore();
  }

  const unlink = spyOn(fsPromises, "unlink").mockRejectedValueOnce(
    new Error("probe cleanup failed"),
  );
  try {
    await expect(
      renameFilesSafely({
        [source]: { destination, expectedSha256: hash("source\n") },
      }),
    ).rejects.toThrow("residual probe");
  } finally {
    unlink.mockRestore();
  }
});

test("file_rename cleans the current destination after source unlink failure", async () => {
  const root = await temporaryRoot();
  const source = path.join(root, "source.txt");
  const destination = path.join(root, "destination.txt");
  await writeFile(source, "source\n");
  const actualUnlink = fsPromises.unlink.bind(fsPromises);
  let calls = 0;
  const unlink = spyOn(fsPromises, "unlink").mockImplementation(
    async (file) => {
      calls += 1;
      if (calls === 2) throw new Error("source unlink failed");
      return actualUnlink(file);
    },
  );
  try {
    await expect(
      renameFilesSafely({
        [source]: { destination, expectedSha256: hash("source\n") },
      }),
    ).rejects.toThrow("source unlink failed");
    expect(await readFile(source, "utf8")).toBe("source\n");
    await expect(readFile(destination, "utf8")).rejects.toThrow();
  } finally {
    unlink.mockRestore();
  }
});

test("file_rename reports current cleanup and rollback failures", async () => {
  const cleanupRoot = await temporaryRoot();
  const cleanupSource = path.join(cleanupRoot, "source.txt");
  const cleanupDestination = path.join(cleanupRoot, "destination.txt");
  await writeFile(cleanupSource, "source\n");
  const actualUnlink = fsPromises.unlink.bind(fsPromises);
  let cleanupCalls = 0;
  const cleanupUnlink = spyOn(fsPromises, "unlink").mockImplementation(
    async (file) => {
      cleanupCalls += 1;
      if (cleanupCalls === 2) throw new Error("source unlink failed");
      if (cleanupCalls === 3) throw new Error("destination cleanup failed");
      return actualUnlink(file);
    },
  );
  try {
    await expect(
      renameFilesSafely({
        [cleanupSource]: {
          destination: cleanupDestination,
          expectedSha256: hash("source\n"),
        },
      }),
    ).rejects.toThrow("cleaning up the current destination");
  } finally {
    cleanupUnlink.mockRestore();
  }

  const rollbackRoot = await temporaryRoot();
  const first = path.join(rollbackRoot, "first.txt");
  const second = path.join(rollbackRoot, "second.txt");
  const firstDestination = path.join(rollbackRoot, "first-new.txt");
  const secondDestination = path.join(rollbackRoot, "second-new.txt");
  await writeFile(first, "first\n");
  await writeFile(second, "second\n");
  let rollbackCalls = 0;
  const rollbackUnlink = spyOn(fsPromises, "unlink").mockImplementation(
    async (file) => {
      rollbackCalls += 1;
      if (rollbackCalls === 4) throw new Error("second unlink failed");
      if (rollbackCalls === 6) throw new Error("rollback unlink failed");
      return actualUnlink(file);
    },
  );
  try {
    await expect(
      renameFilesSafely({
        [first]: {
          destination: firstDestination,
          expectedSha256: hash("first\n"),
        },
        [second]: {
          destination: secondDestination,
          expectedSha256: hash("second\n"),
        },
      }),
    ).rejects.toThrow("rollback was incomplete");
  } finally {
    rollbackUnlink.mockRestore();
  }
});

test("file_rename rejects directories and duplicate resolved sources", async () => {
  const root = await temporaryRoot();
  const directory = path.join(root, "directory");
  await fsPromises.mkdir(directory);
  await expect(
    renameFilesSafely({
      [directory]: {
        destination: path.join(root, "directory-new"),
        expectedSha256: "0".repeat(64),
      },
    }),
  ).rejects.toThrow("accepts files only");

  const source = path.join(root, "source.txt");
  await writeFile(source, "source\n");
  await fsPromises.mkdir(path.join(root, "nested"));
  const canonicalSource = await fsPromises.realpath(source);
  await expect(
    renameFilesSafely({
      [canonicalSource]: {
        destination: path.join(root, "first-destination.txt"),
        expectedSha256: hash("source\n"),
      },
      [`${path.dirname(canonicalSource)}/nested/../source.txt`]: {
        destination: path.join(root, "second-destination.txt"),
        expectedSha256: hash("source\n"),
      },
    }),
  ).rejects.toThrow("source appears more than once");
});

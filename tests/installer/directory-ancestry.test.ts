import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createdDirectoryAncestors,
  type DirectoryIdentity,
} from "../../src/installer/directory-ancestry";
import {
  withInstallerFileTransaction,
  writeInstallerFile,
} from "../../src/installer/transaction";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
const identity = (real: string, ino: number, dev = 1): DirectoryIdentity => ({
  real,
  ino,
  dev,
});

for (const scenario of [
  {
    name: "POSIX spelling",
    paths: path.posix,
    directory: "/workspace/new/deep",
    first: "/workspace/new",
    canonical: "/workspace/new",
    ino: 10,
  },
  {
    name: "Windows drive and component case",
    paths: path.win32,
    directory: String.raw`C:\Workspace\new\deep`,
    first: String.raw`c:\workspace\NEW`,
    canonical: String.raw`C:\Workspace\new`,
    ino: 10,
  },
  {
    name: "Windows junction alias",
    paths: path.win32,
    directory: String.raw`C:\Junction\new\deep`,
    first: String.raw`C:\Actual\new`,
    canonical: String.raw`C:\Actual\new`,
    ino: 10,
  },
  {
    name: "Windows extended path alias",
    paths: path.win32,
    directory: String.raw`\\?\C:\workspace\new\deep`,
    first: String.raw`C:\workspace\new`,
    canonical: String.raw`C:\workspace\new`,
    ino: 10,
  },
  {
    name: "Windows UNC case",
    paths: path.win32,
    directory: String.raw`\\server\share\New\deep`,
    first: String.raw`\\SERVER\SHARE\new`,
    canonical: String.raw`\\server\share\New`,
    ino: 10,
  },
  {
    name: "Windows short account alias",
    paths: path.win32,
    directory: String.raw`C:\Users\runneradmin\AppData\new\deep`,
    first: String.raw`C:\Users\RUNNER~1\AppData\new`,
    canonical: String.raw`C:\Users\runneradmin\AppData\new`,
    ino: 10,
  },
  {
    name: "Windows canonical fallback without inode IDs",
    paths: path.win32,
    directory: String.raw`C:\Users\runneradmin\AppData\new\deep`,
    first: String.raw`C:\Users\RUNNER~1\AppData\new`,
    canonical: String.raw`C:\Users\runneradmin\AppData\new`,
    ino: 0,
  },
  {
    name: "POSIX canonical fallback without inode IDs",
    paths: path.posix,
    directory: "/alias/new/deep",
    first: "/actual/new",
    canonical: "/actual/new",
    ino: 0,
  },
]) {
  test(
    "recursive mkdir cleanup proves " +
      scenario.name +
      " by directory identity",
    () => {
      const { paths, directory, first, canonical, ino } = scenario;
      const parent = paths.dirname(directory);
      const reads: string[] = [];
      const candidates = createdDirectoryAncestors(directory, first, {
        paths,
        inspect: (file) => {
          reads.push(file);
          if (file === paths.resolve(first) || file === parent)
            return identity(canonical, ino);
          expect(file).toBe(paths.resolve(directory));
          return identity(paths.join(canonical, "deep"), 11);
        },
      });
      expect([...candidates.keys()]).toEqual([
        paths.resolve(directory),
        parent,
      ]);
      expect(candidates.has(paths.dirname(parent))).toBe(false);
      expect(reads).toHaveLength(3);
    },
  );
}

test("canonical fallback respects Windows case while rejecting different devices and identifiers", () => {
  const paths = path.win32;
  const directory = String.raw`C:\workspace\new`;
  const first = String.raw`c:\WORKSPACE\NEW`;
  const result = createdDirectoryAncestors(directory, first, {
    paths,
    inspect: (file) => identity(file, 0),
  });
  expect([...result.keys()]).toEqual([directory]);
  for (const mismatch of ["device", "inode", "location"] as const) {
    let reads = 0;
    expect(() =>
      createdDirectoryAncestors(directory, first, {
        paths,
        inspect: (file) => {
          reads += 1;
          if (file === first)
            return identity(
              String.raw`C:\other`,
              mismatch === "location" ? 0 : 10,
              1,
            );
          return identity(
            file,
            mismatch === "location" ? 0 : mismatch === "inode" ? 11 : 10,
            mismatch === "device" ? 2 : 1,
          );
        },
      }),
    ).toThrow("refusing cleanup ownership");
    expect(reads).toBeLessThanOrEqual(3);
  }
});

for (const paths of [path.posix, path.win32]) {
  test(
    "unproven " +
      (paths === path.win32 ? "Windows" : "POSIX") +
      " ancestry stops before root without returning cleanup candidates",
    () => {
      const directory = paths.resolve(
        paths === path.win32
          ? String.raw`C:\workspace\new\deep`
          : "/workspace/new/deep",
      );
      const first = paths.resolve(
        paths === path.win32 ? String.raw`C:\unrelated` : "/unrelated",
      );
      const existing = new Map([["preexisting", identity(first, 99)]]);
      const reads: string[] = [];
      expect(() => {
        const candidates = createdDirectoryAncestors(directory, first, {
          paths,
          inspect: (file) => {
            reads.push(file);
            return identity(file, file === first ? 99 : 10);
          },
        });
        for (const [file, info] of candidates) existing.set(file, info);
      }).toThrow("refusing cleanup ownership");
      expect([...existing.keys()]).toEqual(["preexisting"]);
      expect(reads).toHaveLength(4);
      expect(reads).not.toContain(paths.parse(directory).root);
      expect(() =>
        createdDirectoryAncestors(paths.parse(directory).root, first, {
          paths,
          inspect: (file) => identity(file, 10),
        }),
      ).toThrow("refusing cleanup ownership");
    },
  );
}

test("malformed ancestor adapters terminate on cycles and on the initial path-length bound", () => {
  for (const cycle of [true, false]) {
    let reads = 0;
    expect(() =>
      createdDirectoryAncestors("/new", "/boundary", {
        paths: {
          resolve: (file) => file,
          relative: path.posix.relative,
          dirname: (file) =>
            cycle ? (file === "/new" ? "/other" : "/new") : file + "/parent",
        },
        inspect: (file) => {
          reads += 1;
          return identity(file, file === "/boundary" ? 99 : 10);
        },
      }),
    ).toThrow("refusing cleanup ownership");
    expect(reads).toBeLessThanOrEqual("/new".length + 2);
  }
});

test("real filesystem ancestry rejects non-directory boundaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-mcp-ancestry-"));
  roots.push(root);
  const directory = path.join(root, "new", "deep");
  await fs.mkdir(directory, { recursive: true });
  const created = createdDirectoryAncestors(directory, path.join(root, "new"));
  expect([...created.keys()]).toEqual([directory, path.join(root, "new")]);
  const file = path.join(root, "file");
  await fs.writeFile(file, "user content");
  expect(() => createdDirectoryAncestors(directory, file)).toThrow(
    "must be a directory",
  );
});

test("an unprovable mkdir return value never authorizes cleanup of preexisting directories", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ast-mcp-mkdir-boundary-")),
  );
  roots.push(root);
  const unrelated = path.join(root, "preexisting");
  await fs.mkdir(unrelated);
  const marker = path.join(unrelated, "keep");
  await fs.writeFile(marker, "user content");
  const actual = fs.mkdir;
  const mkdir = spyOn(fs, "mkdir").mockImplementation((async (
    ...args: Parameters<typeof fs.mkdir>
  ) => {
    await actual(...args);
    return unrelated;
  }) as typeof fs.mkdir);
  const directory = path.join(root, "new", "deep");
  try {
    await expect(
      withInstallerFileTransaction(() =>
        writeInstallerFile(path.join(directory, "file"), "managed"),
      ),
    ).rejects.toThrow("refusing cleanup ownership");
    expect(await fs.readFile(marker, "utf8")).toBe("user content");
    expect((await fs.stat(directory)).isDirectory()).toBe(true);
    await expect(fs.stat(path.join(directory, "file"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    mkdir.mockRestore();
  }
});

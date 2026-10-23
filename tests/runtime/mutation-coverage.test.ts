import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { withConfig } from "../../src/config";
import { renameFilesSafely } from "../../src/runtime/file-rename";
import { sha256 } from "../../src/runtime/hash";
import {
  ensureParentDirectories,
  removeCreatedDirectories,
  revalidateWritePath,
} from "../../src/runtime/parent-directories";
import * as paths from "../../src/runtime/paths";
import { hermeticConfig } from "../support/hermetic-config";

async function fixture(operation: (root: string) => Promise<void>) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "ast-mutation-coverage-")),
  );
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(
    path.join(root, "ast-mcp.toml"),
    'version = 2\n[[paths]]\nid = "fixture"\npath = "."\npolicies = { read = "allow", write = "allow", delete = "allow" }\n',
  );
  try {
    await withConfig(hermeticConfig(root), () => operation(root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("parent revalidation rejects changed canonical destinations before creation", async () => {
  await fixture(async (root) => {
    const target = path.join(root, "missing", "file.txt");
    const original = paths.resolveWritablePath;
    const resolve = spyOn(paths, "resolveWritablePath").mockImplementation(
      async (file, operation) =>
        file === target
          ? path.join(root, "substituted", "file.txt")
          : original(file, operation),
    );
    const created: string[] = [];
    try {
      await expect(revalidateWritePath(target)).rejects.toMatchObject({
        code: "mutation_path_changed",
        retryable: true,
      });
      await expect(
        ensureParentDirectories(target, created),
      ).rejects.toMatchObject({ code: "mutation_path_changed" });
      expect(created).toEqual([]);
      expect(await fs.readdir(root)).not.toContain("missing");
    } finally {
      resolve.mockRestore();
    }
  });
});

test("parent creation rejects a regular file in place of a directory", async () => {
  await fixture(async (root) => {
    const parent = path.join(root, "blocked");
    await fs.writeFile(parent, "preserve");
    const created: string[] = [];
    await expect(
      ensureParentDirectories(path.join(parent, "file.txt"), created),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(created).toEqual([]);
    expect(await fs.readFile(parent, "utf8")).toBe("preserve");
  });
});

test.each(["directory", "file"] as const)(
  "parent creation preserves a racing %s on EEXIST",
  async (kind) => {
    await fixture(async (root) => {
      const parent = path.join(root, "racing");
      const created: string[] = [];
      const originalMkdir = fs.mkdir;
      const make = spyOn(fs, "mkdir").mockImplementation((async (
        ...args: Parameters<typeof fs.mkdir>
      ) => {
        if (String(args[0]) === parent) {
          if (kind === "directory") await originalMkdir(parent);
          else await fs.writeFile(parent, "concurrent");
        }
        return originalMkdir(...args);
      }) as typeof fs.mkdir);
      try {
        const operation = ensureParentDirectories(
          path.join(parent, "file.txt"),
          created,
        );
        if (kind === "directory") await operation;
        else await expect(operation).rejects.toMatchObject({ code: "EEXIST" });
        expect(created).toEqual([]);
        await removeCreatedDirectories(created);
        expect((await fs.lstat(parent)).isDirectory()).toBe(
          kind === "directory",
        );
        if (kind === "file")
          expect(await fs.readFile(parent, "utf8")).toBe("concurrent");
      } finally {
        make.mockRestore();
      }
    });
  },
);

test("rename rechecks a changed canonical source before link side effects", async () => {
  await fixture(async (root) => {
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await fs.writeFile(source, "source");
    const original = paths.resolveWritablePath;
    let sourceChecks = 0;
    const resolve = spyOn(paths, "resolveWritablePath").mockImplementation(
      async (file, operation) => {
        if (file === source && operation === "delete" && ++sourceChecks > 1)
          return path.join(root, "changed-source.txt");
        return original(file, operation);
      },
    );
    try {
      await expect(
        renameFilesSafely({
          [source]: { destination, expectedSha256: sha256("source") },
        }),
      ).rejects.toMatchObject({ code: "mutation_path_changed" });
      expect(sourceChecks).toBeGreaterThan(1);
      expect(await fs.readFile(source, "utf8")).toBe("source");
      expect(await fs.readdir(root)).not.toContain("destination.txt");
      expect(
        (await fs.readdir(root)).filter((name) =>
          name.includes("rename-probe"),
        ),
      ).toEqual([]);
    } finally {
      resolve.mockRestore();
    }
  });
});

test.each(["same-path", "source-alias", "destination-alias"] as const)(
  "rename rejects canonical endpoint conflict: %s",
  async (conflict) => {
    await fixture(async (root) => {
      const source = path.join(root, "source.txt");
      const second = path.join(root, "second.txt");
      const destination = path.join(root, "destination.txt");
      await fs.writeFile(source, "source");
      await fs.writeFile(second, "source");
      const requests =
        conflict === "same-path"
          ? { [source]: { destination: source } }
          : conflict === "source-alias"
            ? {
                [source]: { destination },
                [root + path.sep + "." + path.sep + "source.txt"]: {
                  destination: path.join(root, "other.txt"),
                },
              }
            : {
                [source]: { destination },
                [second]: {
                  destination:
                    root + path.sep + "." + path.sep + "destination.txt",
                },
              };
      await expect(renameFilesSafely(requests)).rejects.toThrow(
        conflict === "same-path" ? "must differ" : "appears more than once",
      );
      expect(await fs.readFile(source, "utf8")).toBe("source");
      expect(await fs.readFile(second, "utf8")).toBe("source");
      expect(await fs.readdir(root)).not.toContain("destination.txt");
    });
  },
);

test("rename reports incomplete parent cleanup without deleting an owned source", async () => {
  await fixture(async (root) => {
    const source = path.join(root, "source.txt");
    const parent = path.join(root, "new");
    const destination = path.join(parent, "destination.txt");
    await fs.writeFile(source, "source");
    const originalLink = fs.link;
    const originalRemove = fs.rmdir;
    const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (String(to).includes("rename-probe"))
        throw new Error("link capability failed");
      return originalLink(from, to);
    });
    const remove = spyOn(fs, "rmdir").mockImplementation(async (...args) => {
      if (String(args[0]) === parent)
        throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
      return originalRemove(...args);
    });
    try {
      await expect(
        renameFilesSafely({
          [source]: { destination, expectedSha256: sha256("source") },
        }),
      ).rejects.toMatchObject({
        message: "file_rename failed and parent cleanup was incomplete",
        details: { affectedPaths: [parent] },
      });
      expect(await fs.readFile(source, "utf8")).toBe("source");
      expect(await fs.readdir(parent)).toEqual([]);
    } finally {
      link.mockRestore();
      remove.mockRestore();
    }
  });
});

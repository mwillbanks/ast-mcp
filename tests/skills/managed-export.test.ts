import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  reconcileSkillExport,
  SKILL_EXPORT_MANIFEST,
} from "../../src/skills/export";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function temporary() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-managed-skill-"),
  );
  roots.push(root);
  return root;
}
const file = (relative: string, text: string) => ({
  relative,
  bytes: Buffer.from(text),
});
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const current = [
  file("SKILL.md", "first"),
  file("references/tools.md", "tools"),
];

test("exports track exact bytes and repeat without replacement", async () => {
  const root = path.join(await temporary(), "new");
  expect(await reconcileSkillExport(root, "export", current)).toMatchObject({
    destination: root,
    written: ["SKILL.md", "references/tools.md"],
    preserved: [],
    conflicts: [],
  });
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, SKILL_EXPORT_MANIFEST), "utf8"),
  );
  expect(manifest).toEqual({
    version: 1,
    files: { "SKILL.md": sha("first"), "references/tools.md": sha("tools") },
  });
  expect(await reconcileSkillExport(root, "export", current)).toMatchObject({
    written: [],
    updated: [],
    unchanged: ["SKILL.md", "references/tools.md"],
    preserved: ["SKILL.md", "references/tools.md"],
  });
});

test("managed hashes safely support prototype property filenames", async () => {
  const root = await temporary();
  const names = ["__proto__", "constructor", "toString"];
  const original = names.map((name) => file(name, "old " + name));
  expect(
    (await reconcileSkillExport(root, "export", original)).written,
  ).toEqual(names);
  const firstManifest = JSON.parse(
    await fs.readFile(path.join(root, SKILL_EXPORT_MANIFEST), "utf8"),
  );
  for (const name of names) {
    expect(Object.hasOwn(firstManifest.files, name)).toBeTrue();
    expect(firstManifest.files[name]).toBe(sha("old " + name));
  }
  expect(
    (
      await reconcileSkillExport(
        root,
        "update",
        names.map((name) => file(name, "new " + name)),
      )
    ).updated,
  ).toEqual(names);
  const updatedManifest = JSON.parse(
    await fs.readFile(path.join(root, SKILL_EXPORT_MANIFEST), "utf8"),
  );
  for (const name of names) {
    expect(await fs.readFile(path.join(root, name), "utf8")).toBe(
      "new " + name,
    );
    expect(Object.hasOwn(updatedManifest.files, name)).toBeTrue();
    expect(updatedManifest.files[name]).toBe(sha("new " + name));
  }
  const legacy = await temporary();
  await fs.writeFile(path.join(legacy, "__proto__"), "custom");
  expect(
    (
      await reconcileSkillExport(legacy, "update", [
        file("__proto__", "current"),
      ])
    ).conflicts,
  ).toEqual(["__proto__"]);
});

test("updates unchanged resources and preserves customized and obsolete resources", async () => {
  const root = await temporary();
  await reconcileSkillExport(root, "export", current);
  await fs.writeFile(path.join(root, "references/tools.md"), "custom");
  await fs.writeFile(path.join(root, "personal.txt"), "personal");
  const result = await reconcileSkillExport(root, "update", [
    file("SKILL.md", "second"),
    file("references/tools.md", "new tools"),
    file("new.md", "new"),
  ]);
  expect(result).toMatchObject({
    updated: ["SKILL.md"],
    written: ["new.md"],
    preserved: ["references/tools.md"],
    conflicts: ["references/tools.md"],
  });
  expect(await fs.readFile(path.join(root, "SKILL.md"), "utf8")).toBe("second");
  expect(
    await fs.readFile(path.join(root, "references/tools.md"), "utf8"),
  ).toBe("custom");
  expect(await fs.readFile(path.join(root, "personal.txt"), "utf8")).toBe(
    "personal",
  );
  const retired = await reconcileSkillExport(root, "update", [
    file("SKILL.md", "third"),
  ]);
  expect(retired.obsolete).toEqual(["new.md", "references/tools.md"]);
  expect(await fs.readFile(path.join(root, "new.md"), "utf8")).toBe("new");
});

test("legacy exports adopt matching bytes but preserve uncertain files", async () => {
  const root = await temporary();
  await fs.writeFile(path.join(root, "SKILL.md"), "legacy");
  await fs.writeFile(path.join(root, "same.md"), "same");
  expect(
    await reconcileSkillExport(root, "update", [
      file("SKILL.md", "current"),
      file("same.md", "same"),
    ]),
  ).toMatchObject({
    conflicts: ["SKILL.md"],
    unchanged: ["same.md"],
  });
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, SKILL_EXPORT_MANIFEST), "utf8"),
  );
  expect(manifest.files).toEqual({ "same.md": sha("same") });
  await reconcileSkillExport(root, "update", [file("same.md", "new")]);
  expect(await fs.readFile(path.join(root, "same.md"), "utf8")).toBe("new");
});

for (const value of [
  null,
  [],
  {},
  { version: 2, files: {} },
  { version: 1, files: [] },
  { version: 1, files: {}, extra: true },
  { version: 1, files: { "../outside": sha("x") } },
  { version: 1, files: { "/absolute": sha("x") } },
  { version: 1, files: { "bad\\path": sha("x") } },
  { version: 1, files: { x: "bad" } },
  { version: 1, files: { x: 2 } },
  { version: 1, files: { "a/./b": sha("x") } },
  { version: 1, files: { ".hidden": sha("x") } },
]) {
  test(
    "invalid manifests fail before resource writes: " + JSON.stringify(value),
    async () => {
      const root = await temporary();
      await fs.writeFile(
        path.join(root, SKILL_EXPORT_MANIFEST),
        JSON.stringify(value),
      );
      await expect(
        reconcileSkillExport(root, "update", current),
      ).rejects.toThrow("Invalid skill export manifest");
      expect(await Bun.file(path.join(root, "SKILL.md")).exists()).toBeFalse();
    },
  );
}

test("malformed, oversized and nonregular manifests fail without writes", async () => {
  const root = await temporary();
  const manifest = path.join(root, SKILL_EXPORT_MANIFEST);
  await fs.writeFile(manifest, "{");
  await expect(reconcileSkillExport(root, "update", current)).rejects.toThrow();
  await fs.writeFile(manifest, " ".repeat(256 * 1024 + 1));
  await expect(reconcileSkillExport(root, "update", current)).rejects.toThrow(
    "bounded regular file",
  );
  await fs.rm(manifest);
  await fs.mkdir(manifest);
  await expect(reconcileSkillExport(root, "update", current)).rejects.toThrow(
    "bounded regular file",
  );
  expect(await Bun.file(path.join(root, "SKILL.md")).exists()).toBeFalse();
});

test("all parent paths are preflighted before any skill writes", async () => {
  const root = await temporary();
  const outside = await temporary();
  await fs.symlink(
    outside,
    path.join(root, "references"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(reconcileSkillExport(root, "update", current)).rejects.toThrow(
    "symbolic links",
  );
  expect(await Bun.file(path.join(root, "SKILL.md")).exists()).toBeFalse();
  expect(await fs.readdir(outside)).toEqual([]);
});

test("rejects linked root and manifest but preserves linked resource targets", async () => {
  const parent = await temporary();
  const root = path.join(parent, "skill");
  await fs.mkdir(root);
  const linked = path.join(parent, "linked");
  await fs.symlink(
    root,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(reconcileSkillExport(linked, "export", current)).rejects.toThrow(
    "symbolic links",
  );
  const outside = path.join(parent, "outside");
  await fs.writeFile(outside, "user");
  await fs.symlink(outside, path.join(root, "SKILL.md"));
  expect(
    (await reconcileSkillExport(root, "update", current)).conflicts,
  ).toEqual(["SKILL.md"]);
  expect(await fs.readFile(outside, "utf8")).toBe("user");
  await fs.rm(path.join(root, SKILL_EXPORT_MANIFEST));
  await fs.symlink(outside, path.join(root, SKILL_EXPORT_MANIFEST));
  await expect(reconcileSkillExport(root, "update", current)).rejects.toThrow(
    "bounded regular file",
  );
});

test("resource path validation rejects traversal and duplicates before directory creation", async () => {
  const root = path.join(await temporary(), "absent");
  for (const files of [
    [file("../bad", "x")],
    [file("C:/bad", "x")],
    [file("", "x")],
    [file("a", "x"), file("a", "y")],
  ]) {
    await expect(reconcileSkillExport(root, "update", files)).rejects.toThrow(
      "unsafe or duplicate",
    );
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("active locks reject competing exports without changing files", async () => {
  const root = await temporary();
  await fs.writeFile(path.join(root, ".ast-mcp-export.lock"), "");
  await expect(reconcileSkillExport(root, "update", current)).rejects.toThrow(
    "locked",
  );
  expect(await Bun.file(path.join(root, "SKILL.md")).exists()).toBeFalse();
});

test("changes during staging are preserved and locks are released", async () => {
  const root = await temporary();
  await reconcileSkillExport(root, "export", [file("SKILL.md", "old")]);
  const originalOpen = fs.open;
  const intercepted = spyOn(fs, "open").mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(".tmp"))
        await fs.writeFile(path.join(root, "SKILL.md"), "concurrent edit");
      return handle;
    },
  );
  try {
    await expect(
      reconcileSkillExport(root, "update", [file("SKILL.md", "new")]),
    ).rejects.toThrow("changed before replacement");
  } finally {
    intercepted.mockRestore();
  }
  expect(await fs.readFile(path.join(root, "SKILL.md"), "utf8")).toBe(
    "concurrent edit",
  );
  expect(
    (await fs.readdir(root)).some(
      (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
    ),
  ).toBeFalse();
});

test("interruption after a file update preserves data and permits recovery", async () => {
  const root = await temporary();
  await reconcileSkillExport(root, "export", [file("SKILL.md", "old")]);
  const originalRename = fs.rename;
  const intercepted = spyOn(fs, "rename").mockImplementation(
    async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]).endsWith(SKILL_EXPORT_MANIFEST))
        throw new Error("interrupted");
      return originalRename(...args);
    },
  );
  try {
    await expect(
      reconcileSkillExport(root, "update", [file("SKILL.md", "new")]),
    ).rejects.toThrow("interrupted");
  } finally {
    intercepted.mockRestore();
  }
  expect(await fs.readFile(path.join(root, "SKILL.md"), "utf8")).toBe("new");
  expect(
    (await reconcileSkillExport(root, "update", [file("SKILL.md", "new")]))
      .unchanged,
  ).toEqual(["SKILL.md"]);
  expect(
    (await reconcileSkillExport(root, "update", [file("SKILL.md", "newer")]))
      .updated,
  ).toEqual(["SKILL.md"]);
});

test("operational errors propagate and directory collisions are preserved", async () => {
  const parent = await temporary();
  const root = path.join(parent, "root");
  await fs.writeFile(root, "file");
  await expect(reconcileSkillExport(root, "export", current)).rejects.toThrow(
    "directories",
  );
  await fs.rm(root);
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, "SKILL.md"));
  expect(
    (await reconcileSkillExport(root, "update", current)).conflicts,
  ).toContain("SKILL.md");
  const intercepted = spyOn(fs, "lstat").mockRejectedValueOnce(
    Object.assign(new Error("denied"), { code: "EACCES" }),
  );
  try {
    await expect(reconcileSkillExport(root, "update", current)).rejects.toThrow(
      "denied",
    );
  } finally {
    intercepted.mockRestore();
  }
});

test("manifest capacity failures occur before resource writes", async () => {
  const root = await temporary();
  await fs.writeFile(
    path.join(root, SKILL_EXPORT_MANIFEST),
    JSON.stringify({
      version: 1,
      files: Object.fromEntries(
        Array.from({ length: 512 }, (_, index) => ["old-" + index, sha("old")]),
      ),
    }),
  );
  await expect(reconcileSkillExport(root, "update", current)).rejects.toThrow(
    "capacity exceeded",
  );
  expect(await Bun.file(path.join(root, "SKILL.md")).exists()).toBeFalse();
});

test("replacement preserves installed file permissions", async () => {
  if (process.platform === "win32") return;
  const root = await temporary();
  await reconcileSkillExport(root, "export", [file("SKILL.md", "old")]);
  await fs.chmod(path.join(root, "SKILL.md"), 0o600);
  await reconcileSkillExport(root, "update", [file("SKILL.md", "new")]);
  expect((await fs.stat(path.join(root, "SKILL.md"))).mode & 0o777).toBe(0o600);
});

test("replacement staging does not follow a swapped support directory", async () => {
  const root = await temporary();
  const outside = await temporary();
  await reconcileSkillExport(root, "export", [
    file("references/tools.md", "old"),
  ]);
  const originalOpen = fs.open;
  let swapped = false;
  const stagingParents: string[] = [];
  const open = spyOn(fs, "open").mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith(".tmp")) {
        if (!swapped) {
          swapped = true;
          await fs.rename(
            path.join(root, "references"),
            path.join(root, "saved-references"),
          );
          await fs.symlink(
            outside,
            path.join(root, "references"),
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        stagingParents.push(await fs.realpath(path.dirname(String(args[0]))));
      }
      return originalOpen(...args);
    },
  );
  try {
    await expect(
      reconcileSkillExport(root, "update", [
        file("references/tools.md", "new"),
      ]),
    ).rejects.toThrow("symbolic links");
  } finally {
    open.mockRestore();
  }
  expect(stagingParents).toEqual([await fs.realpath(root)]);
  expect(await fs.readdir(outside)).toEqual([]);
  expect(
    await fs.readFile(path.join(root, "saved-references/tools.md"), "utf8"),
  ).toBe("old");
  expect(
    (await fs.readdir(root)).some(
      (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
    ),
  ).toBeFalse();
});

test("fresh resources recheck parents after directory preparation", async () => {
  const root = await temporary();
  const outside = await temporary();
  const references = path.join(root, "references");
  const originalMkdir = fs.mkdir;
  const originalLstat = fs.lstat;
  let preparing = false;
  let swapped = false;
  const mkdir = spyOn(fs, "mkdir").mockImplementation((async (
    ...args: Parameters<typeof fs.mkdir>
  ) => {
    const result = await originalMkdir(...args);
    if (path.basename(String(args[0])) === "references") preparing = true;
    return result;
  }) as typeof fs.mkdir);
  const lstat = spyOn(fs, "lstat").mockImplementation((async (
    ...args: Parameters<typeof fs.lstat>
  ) => {
    const result = await originalLstat(...args);
    if (
      preparing &&
      !swapped &&
      path.basename(String(args[0])) === "references"
    ) {
      swapped = true;
      await fs.rename(references, path.join(root, "saved-references"));
      await fs.symlink(
        outside,
        references,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    return result;
  }) as typeof fs.lstat);
  try {
    await expect(
      reconcileSkillExport(root, "export", [
        file("references/tools.md", "new"),
      ]),
    ).rejects.toThrow("symbolic links");
  } finally {
    mkdir.mockRestore();
    lstat.mockRestore();
  }
  expect(swapped).toBeTrue();
  expect(await fs.readdir(outside)).toEqual([]);
  expect(
    (await fs.readdir(root)).some(
      (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
    ),
  ).toBeFalse();
});

test("staging collisions preserve the preexisting file", async () => {
  const root = await temporary();
  await reconcileSkillExport(root, "export", [file("SKILL.md", "old")]);
  const originalOpen = fs.open;
  let staged = "";
  const intercepted = spyOn(fs, "open").mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith(".tmp")) {
        staged = String(args[0]);
        await fs.writeFile(staged, "unrelated");
      }
      return originalOpen(...args);
    },
  );
  try {
    await expect(
      reconcileSkillExport(root, "update", [file("SKILL.md", "new")]),
    ).rejects.toThrow("staging file already exists");
  } finally {
    intercepted.mockRestore();
  }
  expect(await fs.readFile(staged, "utf8")).toBe("unrelated");
  expect(await fs.readFile(path.join(root, "SKILL.md"), "utf8")).toBe("old");
});

test("new files that appear concurrently are not replaced", async () => {
  const root = await temporary();
  const originalOpen = fs.open;
  const intercepted = spyOn(fs, "open").mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      if (
        path.basename(String(args[0])) === "SKILL.md" &&
        typeof args[1] === "number" &&
        args[1] & constants.O_CREAT
      )
        await fs.writeFile(path.join(root, "SKILL.md"), "concurrent");
      return originalOpen(...args);
    },
  );
  try {
    await expect(
      reconcileSkillExport(root, "export", [file("SKILL.md", "new")]),
    ).rejects.toThrow("appeared during creation");
  } finally {
    intercepted.mockRestore();
  }
  expect(await fs.readFile(path.join(root, "SKILL.md"), "utf8")).toBe(
    "concurrent",
  );
});

test("directory and lock permission failures propagate", async () => {
  const root = await temporary();
  const mkdir = spyOn(fs, "mkdir").mockRejectedValueOnce(
    Object.assign(new Error("parent denied"), { code: "EACCES" }),
  );
  try {
    await expect(reconcileSkillExport(root, "export", current)).rejects.toThrow(
      "parent denied",
    );
  } finally {
    mkdir.mockRestore();
  }
  const originalOpen = fs.open;
  const open = spyOn(fs, "open").mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith(".lock"))
        throw Object.assign(new Error("lock denied"), { code: "EACCES" });
      return originalOpen(...args);
    },
  );
  try {
    await expect(reconcileSkillExport(root, "export", current)).rejects.toThrow(
      "lock denied",
    );
  } finally {
    open.mockRestore();
  }
});

test("write failures preserve the original error when cleanup fails", async () => {
  const root = await temporary();
  const originalOpen = fs.open;
  const unlink = spyOn(fs, "unlink").mockRejectedValueOnce(
    new Error("cleanup failed"),
  );
  const open = spyOn(fs, "open").mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith("SKILL.md"))
        spyOn(handle, "writeFile").mockRejectedValueOnce(
          new Error("write failed"),
        );
      return handle;
    },
  );
  try {
    await expect(
      reconcileSkillExport(root, "export", [file("SKILL.md", "new")]),
    ).rejects.toThrow("write failed");
  } finally {
    open.mockRestore();
    unlink.mockRestore();
  }
  expect(
    (await fs.readdir(root)).some((name) => name.endsWith(".lock")),
  ).toBeFalse();
});

for (const phase of ["resource", "initial manifest"] as const) {
  test(
    "staging close failure cleans owned temporary files during " + phase,
    async () => {
      const root = await temporary();
      if (phase === "resource")
        await reconcileSkillExport(root, "export", [file("SKILL.md", "old")]);
      else await fs.writeFile(path.join(root, "SKILL.md"), "old");
      const manifestPath = path.join(root, SKILL_EXPORT_MANIFEST);
      const manifest =
        phase === "resource" ? await fs.readFile(manifestPath) : undefined;
      const originalOpen = fs.open;
      const open = spyOn(fs, "open").mockImplementation(
        async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args);
          if (String(args[0]).endsWith(".tmp")) {
            const close = handle.close.bind(handle);
            spyOn(handle, "close").mockImplementation(async () => {
              await close();
              throw new Error("staging close failed");
            });
          }
          return handle;
        },
      );
      try {
        await expect(
          reconcileSkillExport(
            root,
            phase === "resource" ? "update" : "export",
            [file("SKILL.md", phase === "resource" ? "new" : "old")],
          ),
        ).rejects.toThrow("staging close failed");
      } finally {
        open.mockRestore();
      }
      expect(await fs.readFile(path.join(root, "SKILL.md"), "utf8")).toBe(
        "old",
      );
      if (manifest) expect(await fs.readFile(manifestPath)).toEqual(manifest);
      else expect(await Bun.file(manifestPath).exists()).toBeFalse();
      expect(
        (await fs.readdir(root)).some(
          (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
        ),
      ).toBeFalse();
    },
  );
}

test("successful writes report lock cleanup failure instead of false success", async () => {
  const root = await temporary();
  const originalUnlink = fs.unlink;
  const unlink = spyOn(fs, "unlink").mockImplementation(async (target) => {
    if (String(target).endsWith(".lock"))
      throw new Error("lock cleanup denied");
    return originalUnlink(target);
  });
  try {
    await expect(
      reconcileSkillExport(root, "export", [file("SKILL.md", "new")]),
    ).rejects.toThrow("lock cleanup failed");
  } finally {
    unlink.mockRestore();
  }
  expect(await fs.readFile(path.join(root, "SKILL.md"), "utf8")).toBe("new");
  await expect(reconcileSkillExport(root, "update", current)).rejects.toThrow(
    "locked",
  );
});

for (const failure of [
  "read",
  "write",
  "sync",
  "read-close",
  "write-close",
] as const) {
  test(
    "resource handle cleanup preserves " + failure + " failures",
    async () => {
      const root = await temporary();
      if (failure.startsWith("read"))
        await fs.writeFile(path.join(root, "SKILL.md"), "old");
      const originalOpen = fs.open;
      const open = spyOn(fs, "open").mockImplementation(
        async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args);
          if (String(args[0]).endsWith("SKILL.md")) {
            const close = handle.close.bind(handle);
            spyOn(handle, "close").mockImplementation(async () => {
              await close();
              throw new Error("resource close failed");
            });
            if (failure === "read")
              spyOn(handle, "readFile").mockRejectedValueOnce(
                new Error("primary read failed"),
              );
            if (failure === "write")
              spyOn(handle, "writeFile").mockRejectedValueOnce(
                new Error("primary write failed"),
              );
            if (failure === "sync")
              spyOn(handle, "sync").mockRejectedValueOnce(
                new Error("primary sync failed"),
              );
          }
          return handle;
        },
      );
      try {
        await expect(
          reconcileSkillExport(root, "export", [file("SKILL.md", "new")]),
        ).rejects.toThrow(
          failure.endsWith("close")
            ? "resource close failed"
            : "primary " + failure + " failed",
        );
      } finally {
        open.mockRestore();
      }
      expect(
        (await fs.readdir(root)).some((name) => name.endsWith(".lock")),
      ).toBeFalse();
    },
  );
}

test("lock close failures do not hide the primary operation failure", async () => {
  const root = await temporary();
  const originalOpen = fs.open;
  const open = spyOn(fs, "open").mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(".lock")) {
        const close = handle.close.bind(handle);
        spyOn(handle, "close").mockImplementation(async () => {
          await close();
          throw new Error("close failure");
        });
      }
      if (String(args[0]).endsWith("SKILL.md"))
        spyOn(handle, "writeFile").mockRejectedValueOnce(
          new Error("primary write failure"),
        );
      return handle;
    },
  );
  try {
    await expect(
      reconcileSkillExport(root, "export", [file("SKILL.md", "new")]),
    ).rejects.toThrow("primary write failure");
  } finally {
    open.mockRestore();
  }
  expect(
    (await fs.readdir(root)).some((name) => name.endsWith(".lock")),
  ).toBeFalse();
});

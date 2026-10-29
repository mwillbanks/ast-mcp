import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { withConfig } from "../../src/config";
import { patchFile, writeFilesSafely } from "../../src/patch/engine";
import * as formatting from "../../src/runtime/format";
import { sha256 } from "../../src/runtime/hash";
import { hermeticConfig } from "../support/hermetic-config";

async function fixture(operation: (root: string) => Promise<void>) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "ast-patch-mutation-coverage-")),
  );
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(
    path.join(root, "ast-mcp.toml"),
    'version = 2\n[formatting]\nenabled = false\n[[paths]]\nid = "fixture"\npath = "."\npolicies = { read = "allow", write = "allow", delete = "allow" }\n',
  );
  try {
    await withConfig(hermeticConfig(root), () => operation(root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("write preflight reports formatter failure and incomplete owned-parent cleanup", async () => {
  await fixture(async (root) => {
    const parent = path.join(root, "new");
    const target = path.join(parent, "file.txt");
    const originalRemove = fs.rmdir;
    const format = spyOn(formatting, "formatContent").mockRejectedValue(
      new Error("formatter failure"),
    );
    const remove = spyOn(fs, "rmdir").mockImplementation(async (...args) => {
      if (String(args[0]) === parent)
        throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
      return originalRemove(...args);
    });
    try {
      let failure: unknown;
      try {
        await writeFilesSafely({ [target]: { content: "candidate" } });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({
        message:
          "File write preflight failed and parent cleanup was incomplete",
        details: { affectedPaths: [parent] },
      });
      expect((failure as AggregateError).errors[0]).toMatchObject({
        message: "formatter failure",
      });
      expect(await fs.readdir(parent)).toEqual([]);
    } finally {
      format.mockRestore();
      remove.mockRestore();
    }
  });
});

test("write commit reports rename failure and incomplete owned-parent cleanup", async () => {
  await fixture(async (root) => {
    const parent = path.join(root, "new");
    const target = path.join(parent, "file.txt");
    const originalRename = fs.rename;
    const originalRemove = fs.rmdir;
    let committing = false;
    const rename = spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[1]) === target) {
        committing = true;
        throw new Error("atomic replacement failed");
      }
      return originalRename(...args);
    });
    const remove = spyOn(fs, "rmdir").mockImplementation(async (...args) => {
      if (committing && String(args[0]) === parent)
        throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
      return originalRemove(...args);
    });
    try {
      let failure: unknown;
      try {
        await writeFilesSafely({ [target]: { content: "candidate" } });
      } catch (error) {
        failure = error;
      }
      expect(committing).toBe(true);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({
        message: "File write failed and cleanup was incomplete",
        details: { affectedPaths: [parent] },
      });
      expect((failure as AggregateError).errors[0]).toMatchObject({
        message: "atomic replacement failed",
      });
      expect(await fs.readdir(parent)).toEqual([]);
    } finally {
      rename.mockRestore();
      remove.mockRestore();
    }
  });
});

for (const existing of [false, true]) {
  for (const failWrite of [false, true]) {
    test(`commit close failure reclaims temporary and owned parents, existing=${existing}, write failure=${failWrite}`, async () => {
      await fixture(async (root) => {
        const parent = existing ? root : path.join(root, "new", "nested");
        const target = path.join(parent, "file.txt");
        if (existing) await fs.writeFile(target, "original");
        const primary = new Error("temporary write failed");
        const cleanup = new Error("temporary close failed");
        const actualOpen = fs.open;
        let temporary: string | undefined;
        let output: fs.FileHandle | undefined;
        const open = spyOn(fs, "open").mockImplementation((async (
          ...args: Parameters<typeof fs.open>
        ) => {
          const handle = await actualOpen(...args);
          if (
            path.dirname(String(args[0])) === parent &&
            String(args[0]).includes(".ast-mcp-") &&
            args[1] === "wx"
          ) {
            temporary = String(args[0]);
            output = handle;
            if (failWrite)
              spyOn(handle, "writeFile").mockRejectedValue(primary);
            const close = handle.close.bind(handle);
            spyOn(handle, "close").mockImplementation(async () => {
              await close();
              throw cleanup;
            });
          }
          return handle;
        }) as typeof fs.open);
        try {
          const failure = await writeFilesSafely({
            [target]: {
              content: "candidate",
              ...(existing ? { expectedSha256: sha256("original") } : {}),
            },
          }).catch((error) => error);
          expect(failure).toBeInstanceOf(AggregateError);
          expect(failure.errors).toContain(cleanup);
          if (failWrite) expect(failure.errors).toContain(primary);
          expect(failure.details.affectedPaths).toContain(temporary);
          expect(temporary).toBeDefined();
          expect(await fs.lstat(temporary!).catch(() => null)).toBeNull();
          await expect(output!.stat()).rejects.toMatchObject({ code: "EBADF" });
          if (existing)
            expect(await fs.readFile(target, "utf8")).toBe("original");
          else
            expect(
              await fs.lstat(path.join(root, "new")).catch(() => null),
            ).toBeNull();
        } finally {
          open.mockRestore();
        }
      });
    });
  }
}

test("commit reports denied temporary cleanup and still attempts owned-parent cleanup", async () => {
  await fixture(async (root) => {
    const parent = path.join(root, "new");
    const target = path.join(parent, "file.txt");
    const primary = new Error("temporary write failed");
    const closeFailure = new Error("temporary close failed");
    const unlinkFailure = Object.assign(new Error("temporary unlink denied"), {
      code: "EACCES",
    });
    const actualOpen = fs.open,
      actualUnlink = fs.unlink,
      actualRmdir = fs.rmdir;
    let temporary: string | undefined;
    let attemptedParent = false;
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await actualOpen(...args);
      if (
        path.dirname(String(args[0])) === parent &&
        String(args[0]).includes(".ast-mcp-") &&
        args[1] === "wx"
      ) {
        temporary = String(args[0]);
        spyOn(handle, "writeFile").mockRejectedValue(primary);
        const close = handle.close.bind(handle);
        spyOn(handle, "close").mockImplementation(async () => {
          await close();
          throw closeFailure;
        });
      }
      return handle;
    }) as typeof fs.open);
    const unlink = spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (String(file) === temporary) throw unlinkFailure;
      return actualUnlink(file);
    });
    const rmdir = spyOn(fs, "rmdir").mockImplementation(async (file) => {
      if (temporary && String(file) === parent) attemptedParent = true;
      return actualRmdir(file);
    });
    try {
      const failure = await writeFilesSafely({
        [target]: { content: "candidate" },
      }).catch((error) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors).toContain(primary);
      expect(failure.errors).toContain(closeFailure);
      expect(failure.errors).toContain(unlinkFailure);
      expect(failure.details.affectedPaths).toContain(temporary);
      expect(attemptedParent).toBeTrue();
      expect(await Bun.file(target).exists()).toBeFalse();
      expect(await Bun.file(temporary!).exists()).toBeTrue();
    } finally {
      open.mockRestore();
      unlink.mockRestore();
      rmdir.mockRestore();
    }
  });
});

test("single-file patch previews preserve shared context and report unchanged candidates", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "source.txt");
    const original = "header\nbefore\ntail\n";
    await fs.writeFile(file, original);
    const request = {
      filePath: file,
      expectedSha256: sha256(original),
      patchStrategy: "aider_block" as const,
      aiderBlock: { search: "before", replace: "after" },
    };
    const preview = await patchFile({ ...request, preview: true });
    expect(preview.changed).toBe(true);
    expect(preview.diff).toContain("@@ -2,1 +2,1 @@");
    expect(preview.diff).not.toContain("header");
    expect(preview.diff).not.toContain("tail");
    expect(await fs.readFile(file, "utf8")).toBe(original);
    const unchanged = await patchFile({
      ...request,
      aiderBlock: { search: "before", replace: "before" },
      preview: true,
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.diff).toBe("");
    await patchFile(request);
    expect(await fs.readFile(file, "utf8")).toBe("header\nafter\ntail\n");
  });
});

test("large single-file patch previews cap diff evidence without truncating the candidate", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "source.txt");
    const original = Array.from(
      { length: 120 },
      (_, index) => "before " + index,
    ).join("\n");
    const candidate = Array.from(
      { length: 120 },
      (_, index) => "after " + index,
    ).join("\n");
    await fs.writeFile(file, original);
    const preview = await patchFile({
      filePath: file,
      expectedSha256: sha256(original),
      patchStrategy: "aider_block",
      aiderBlock: { search: original, replace: candidate },
      preview: true,
    });
    expect(String(preview.diff).split("\n")).toHaveLength(200);
    expect(String(preview.diff)).toEndWith("... diff truncated");
    expect(preview.sha256).toBe(sha256(candidate));
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });
});

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
        message: "File write failed and parent cleanup was incomplete",
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

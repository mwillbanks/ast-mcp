import { expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyFileChattr,
  resultingFileChattr,
  validateFileChattr,
} from "../src/runtime/attributes";

test("validates and applies shared file chattr", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-attributes-"));
  const filePath = path.join(folder, "note.txt");
  try {
    await writeFile(filePath, "content");
    expect(validateFileChattr(undefined)).toBeUndefined();
    expect(() => validateFileChattr({ chmod: 0o1000 })).toThrow("chmod");
    expect(() => validateFileChattr({ chown: { gid: -1, uid: 1 } })).toThrow(
      "chown",
    );
    expect(() =>
      validateFileChattr({
        chown: {
          gid: process.getgid?.() ?? 0,
          uid: (process.getuid?.() ?? 0) + 1,
        },
      }),
    ).toThrow("server process owner");
    const chattr = await applyFileChattr(filePath, { chmod: 0o600 });
    expect(chattr.chmod).toBe(0o600);
    expect(await resultingFileChattr(filePath)).toEqual(chattr);
    expect(await readFile(filePath, "utf8")).toBe("content");
  } finally {
    await rm(folder, { force: true, recursive: true });
  }
});
test("restores prior attributes after a metadata failure", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-attributes-"));
  const filePath = path.join(folder, "note.txt");
  await writeFile(filePath, "content");
  const chown = spyOn(fsPromises, "chown").mockRejectedValue(
    new Error("chown denied"),
  );
  const chmod = spyOn(fsPromises, "chmod").mockRejectedValue(
    new Error("chmod denied"),
  );
  try {
    await expect(
      applyFileChattr(filePath, {
        chmod: 0o600,
        chown: { gid: process.getgid?.() ?? 0, uid: process.getuid?.() ?? 0 },
      }),
    ).rejects.toThrow("chown denied");
  } finally {
    chown.mockRestore();
    chmod.mockRestore();
    await rm(folder, { force: true, recursive: true });
  }
});

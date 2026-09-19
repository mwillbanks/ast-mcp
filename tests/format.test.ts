import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { replaceFileAtomically } from "../src/runtime/atomic";
import {
  assertFormattable,
  dprintCacheDirectory,
  formatContent,
  formatFileAtomically,
} from "../src/runtime/format";

let folder = "";
afterEach(async () => {
  if (folder) await rm(folder, { force: true, recursive: true });
  folder = "";
});

test("selects platform dprint cache directories", () => {
  expect(dprintCacheDirectory("win32", {}, "C:\\Users\\runneradmin")).toBe(
    "C:\\Users\\runneradmin\\AppData\\Local\\dprint",
  );
  expect(
    dprintCacheDirectory(
      "win32",
      { LOCALAPPDATA: "D:\\Cache" },
      "C:\\Users\\runneradmin",
    ),
  ).toBe("D:\\Cache\\dprint");
  expect(dprintCacheDirectory("darwin", {}, "/Users/runner")).toBe(
    "/Users/runner/Library/Caches/dprint",
  );
  expect(dprintCacheDirectory("linux", {}, "/home/runner")).toBe(
    "/home/runner/.cache/dprint",
  );
  expect(
    dprintCacheDirectory(
      "win32",
      { DPRINT_CACHE_DIR: "D:\\Custom" },
      "C:\\Users\\runneradmin",
    ),
  ).toBe("D:\\Custom");
  expect(
    dprintCacheDirectory(
      "linux",
      { DPRINT_CACHE_DIR: "/tmp/dprint-custom" },
      "/home/runner",
    ),
  ).toBe("/tmp/dprint-custom");
  expect(
    dprintCacheDirectory(
      "linux",
      { XDG_CACHE_HOME: "/tmp/xdg" },
      "/home/runner",
    ),
  ).toBe("/tmp/xdg/dprint");
});

test("formats content and files through dprint", async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-format-"));
  const filePath = path.join(folder, "value.ts");
  await writeFile(filePath, "const compact={x:1};\n", { mode: 0o640 });
  expect(await formatContent(filePath, "const other={y:2};\n")).toBe(
    "const other = { y: 2 };\n",
  );
  await assertFormattable(filePath);
  await formatFileAtomically(filePath);
  expect(await readFile(filePath, "utf8")).toBe("const compact = { x: 1 };\n");
  await replaceFileAtomically(filePath, "const restored = true;\n", 0o640);
  expect(await readFile(filePath, "utf8")).toBe("const restored = true;\n");
});

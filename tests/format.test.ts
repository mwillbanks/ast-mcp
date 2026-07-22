import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { replaceFileAtomically } from "../src/runtime/atomic";
import {
  assertFormattable,
  formatContent,
  formatFileAtomically,
} from "../src/runtime/format";

let folder = "";
afterEach(async () => {
  if (folder) await rm(folder, { force: true, recursive: true });
  folder = "";
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

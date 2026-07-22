import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { patchFiles } from "../src/patch/engine";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

test("file_patch preview uses the normal AST and Aider contract without committing", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-preview-"));
  process.env.AST_MCP_ROOTS = folder;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  try {
    const source = path.join(folder, "value.ts");
    const sourceContent = "const value = 1;\n";
    await writeFile(source, sourceContent);
    const astResult = await patchFiles({
      [source]: {
        astRules: [{ fix: "const $A = 2", pattern: "const $A = $B" }],
        expectedSha256: sha256(sourceContent),
        patchStrategy: "ast",
        preview: true,
      },
    });
    const astPreview = (
      astResult.files as Record<string, Record<string, unknown>>
    )[source];
    expect(astPreview.preview).toBeTrue();
    expect(astPreview.changed).toBeTrue();
    expect(astPreview.diff).toContain("+const value = 2;");
    expect(await readFile(source, "utf8")).toBe(sourceContent);

    const notes = path.join(folder, "notes.md");
    const notesContent = "alpha\nbeta\n";
    await writeFile(notes, notesContent);
    const aiderResult = await patchFiles({
      [notes]: {
        aiderBlocks: [
          { replace: "one", search: "alpha" },
          { replace: "two", search: "beta" },
        ],
        expectedSha256: sha256(notesContent),
        patchStrategy: "aider_block",
        preview: true,
      },
    });
    const aiderPreview = (
      aiderResult.files as Record<string, Record<string, unknown>>
    )[notes];
    expect(aiderPreview.preview).toBeTrue();
    expect(aiderPreview.diff).toContain("+one");
    expect(await readFile(notes, "utf8")).toBe(notesContent);
  } finally {
    delete process.env.AST_MCP_ROOTS;
    delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
    await rm(folder, { force: true, recursive: true });
  }
});

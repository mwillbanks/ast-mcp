import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withConfig } from "../src/config";
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

function formatStages(folder: string) {
  return readdir(folder).then((names) =>
    names.filter((name) => name.startsWith(".ast-mcp-format-")),
  );
}

test("file_patch preview skips formatters until commit", async () => {
  const folder = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-preview-format-"),
  );
  process.env.AST_MCP_ROOTS = folder;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  await mkdir(path.join(folder, ".git"));
  const bun = process.execPath.replaceAll("\\", "\\\\");
  const stdoutScript =
    "process.stdout.write((await Bun.stdin.text()).toUpperCase())";
  const inPlaceScript =
    "const file=process.argv[1]; await Bun.write(file,(await Bun.file(file).text())+'!')";
  const tsScript =
    'process.stdout.write((await Bun.stdin.text()) + "// formatted\\n")';
  await writeFile(
    path.join(folder, "ast-mcp.toml"),
    [
      "version = 2",
      "[formatting]",
      "enabled = false",
      'fallback = "preserve"',
      "[[formatting.formatters]]",
      'id = "upper"',
      "enabled = true",
      'extensions = [".txt"]',
      `command = "${bun}"`,
      `args = ["-e", ${JSON.stringify(stdoutScript)}]`,
      'mode = "stdout"',
      "[[formatting.formatters]]",
      'id = "staged"',
      "enabled = true",
      'extensions = [".md"]',
      `command = "${bun}"`,
      `args = ["-e", ${JSON.stringify(inPlaceScript)}, "{file}"]`,
      'mode = "in_place"',
      "[[formatting.formatters]]",
      'id = "ts-mark"',
      "enabled = true",
      'extensions = [".ts"]',
      `command = "${bun}"`,
      `args = ["-e", ${JSON.stringify(tsScript)}]`,
      'mode = "stdout"',
      "[[paths]]",
      'id = "workspace"',
      'path = "."',
      'policies = { read = "allow", write = "allow" }',
      "",
    ].join("\n"),
  );
  const options = {
    cwd: folder,
    env: { XDG_CONFIG_HOME: path.join(folder, "xdg") },
  };
  try {
    await withConfig(options, async () => {
      const notes = path.join(folder, "notes.txt");
      const notesContent = "hello world\n";
      await writeFile(notes, notesContent);
      const preview = await patchFiles({
        [notes]: {
          aiderBlocks: [{ replace: "hi world", search: "hello world" }],
          expectedSha256: sha256(notesContent),
          patchStrategy: "aider_block",
          preview: true,
        },
      });
      const result = (preview.files as Record<string, Record<string, unknown>>)[
        notes
      ];
      expect(result.preview).toBeTrue();
      expect(String(result.diff)).toContain("+hi world");
      expect(String(result.diff)).not.toContain("HI WORLD");
      expect(result.sha256).toBe(sha256("hi world\n"));
      expect(await readFile(notes, "utf8")).toBe(notesContent);
      expect(await formatStages(folder)).toEqual([]);

      const committed = await patchFiles({
        [notes]: { previewReceipt: result.previewReceipt as string },
      });
      const committedResult = (
        committed.files as Record<string, Record<string, unknown>>
      )[notes];
      expect(await readFile(notes, "utf8")).toBe("HI WORLD\n");
      expect(committedResult.sha256).toBe(sha256("HI WORLD\n"));
      expect(committedResult.sha256).not.toBe(result.sha256);
      expect(committedResult.receiptCommitted).toBeTrue();

      const markdown = path.join(folder, "notes.md");
      const markdownContent = "alpha\n";
      await writeFile(markdown, markdownContent);
      const mdPreview = await patchFiles({
        [markdown]: {
          aiderBlocks: [{ replace: "beta", search: "alpha" }],
          expectedSha256: sha256(markdownContent),
          patchStrategy: "aider_block",
          preview: true,
        },
      });
      const mdResult = (
        mdPreview.files as Record<string, Record<string, unknown>>
      )[markdown];
      expect(String(mdResult.diff)).toContain("+beta");
      expect(String(mdResult.diff)).not.toContain("!");
      expect(await readFile(markdown, "utf8")).toBe(markdownContent);
      expect(await formatStages(folder)).toEqual([]);

      await patchFiles({
        [markdown]: {
          aiderBlocks: [{ replace: "beta", search: "alpha" }],
          expectedSha256: sha256(markdownContent),
          patchStrategy: "aider_block",
        },
      });
      expect(await readFile(markdown, "utf8")).toBe("beta\n!");
      expect(await formatStages(folder)).toEqual([]);

      const source = path.join(folder, "value.ts");
      const sourceContent = "const value = 1;\nconst other=2;\n";
      await writeFile(source, sourceContent);
      const astPreview = await patchFiles({
        [source]: {
          astRules: [{ fix: "const value = 2", pattern: "const value = $B" }],
          expectedSha256: sha256(sourceContent),
          patchStrategy: "ast",
          preview: true,
        },
      });
      const astResult = (
        astPreview.files as Record<string, Record<string, unknown>>
      )[source];
      expect(String(astResult.diff)).toContain("+const value = 2;");
      expect(String(astResult.diff)).not.toContain("formatted");
      expect(await readFile(source, "utf8")).toBe(sourceContent);
      expect(await formatStages(folder)).toEqual([]);

      await patchFiles({
        [source]: {
          astRules: [{ fix: "const value = 2", pattern: "const value = $B" }],
          expectedSha256: sha256(sourceContent),
          patchStrategy: "ast",
        },
      });
      expect(await readFile(source, "utf8")).toContain("// formatted");
      expect(await formatStages(folder)).toEqual([]);
    });
  } finally {
    delete process.env.AST_MCP_ROOTS;
    delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
    await rm(folder, { force: true, recursive: true });
  }
});

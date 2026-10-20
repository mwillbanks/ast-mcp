import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { deleteFilesSafely } from "../src/runtime/file-delete";
import { sha256 } from "../src/runtime/hash";
const roots: string[] = [];
const previousRoots = process.env.AST_MCP_ROOTS;
const previousExternalRoots = process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-delete-formats-"));
  roots.push(root);
  await writeFile(path.join(root, "ast-mcp.toml"), "version = 1\n");
  process.env.AST_MCP_ROOTS = root;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  return root;
}
afterEach(async () => {
  if (previousRoots === undefined) delete process.env.AST_MCP_ROOTS;
  else process.env.AST_MCP_ROOTS = previousRoots;
  if (previousExternalRoots === undefined)
    delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  else process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = previousExternalRoots;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
test("mixed documents preserve source and JSON import protection", async () => {
  const root = await temporaryRoot();
  const source = path.join(root, "source.ts");
  const document = path.join(root, "settings.json");
  const sourceContent = "export const answer = 42;\n";
  const documentContent = '{"answer":42}\n';
  await Promise.all([
    writeFile(source, sourceContent),
    writeFile(document, documentContent),
    writeFile(path.join(root, "settings.toml"), "answer = 42\n"),
    writeFile(path.join(root, "settings.yaml"), "answer: 42\n"),
    writeFile(path.join(root, "README.md"), "# Mixed formats\n"),
    writeFile(
      path.join(root, "index.html"),
      "<!doctype html><html><body>Example</body></html>\n",
    ),
    writeFile(path.join(root, "helper.py"), "def helper():\n    return 42\n"),
    writeFile(path.join(root, "helper.sh"), "#!/bin/sh\nprintf 'example\\n'\n"),
    writeFile(
      path.join(root, "consumer.ts"),
      'import { answer } from "./source";\nimport settings from "./settings.json";\nconsole.log(answer, settings);\n',
    ),
  ]);
  await expect(
    deleteFilesSafely({ [source]: { expectedSha256: sha256(sourceContent) } }),
  ).rejects.toThrow("referenced by");
  await expect(
    deleteFilesSafely({
      [document]: { expectedSha256: sha256(documentContent) },
    }),
  ).rejects.toThrow("referenced by");
  expect(await readFile(source, "utf8")).toBe(sourceContent);
  expect(await readFile(document, "utf8")).toBe(documentContent);
  const unused = path.join(root, "unused.ts");
  await writeFile(unused, "export const unused = 1;\n");
  await deleteFilesSafely({
    [unused]: { expectedSha256: sha256("export const unused = 1;\n") },
  });
  expect(await Bun.file(unused).exists()).toBeFalse();
});
test("deletes unreferenced documents and malformed source without requiring a valid target AST", async () => {
  const root = await temporaryRoot();
  const contents = {
    "settings.json": '{"answer":42}\n',
    "settings.toml": "answer = 42\n",
    "README.md": "# Retired documentation\n",
    "broken.ts": "export const = ;\n",
  };
  const files: Record<string, { expectedSha256: string }> = {};
  for (const [name, content] of Object.entries(contents)) {
    const target = path.join(root, name);
    await writeFile(target, content);
    files[target] = { expectedSha256: sha256(content) };
  }
  await deleteFilesSafely(files);
  for (const target of Object.keys(files))
    expect(await Bun.file(target).exists()).toBe(false);
});
test("explicit reference override skips discovery and reports the bypass", async () => {
  const root = await temporaryRoot();
  const target = path.join(root, "source.ts");
  const content = "export const answer = 42;\n";
  await Promise.all([
    writeFile(target, content),
    writeFile(
      path.join(root, "consumer.ts"),
      'import { answer } from "./source";\n',
    ),
    writeFile(path.join(root, "broken.ts"), "export const = ;\n"),
    writeFile(path.join(root, "broken.json"), "{invalid json"),
  ]);
  const result = await deleteFilesSafely({
    [target]: { expectedSha256: sha256(content), forceReferences: true },
  });
  expect(Object.values(result.files)[0]).toMatchObject({
    deleted: true,
    forcedReferences: false,
    referenceVerificationBypassed: true,
  });
  expect(await Bun.file(target).exists()).toBe(false);
  expect(await Bun.file(path.join(root, "consumer.ts")).exists()).toBe(true);
});
test("incomplete reference scans fail closed and prune dependency directories", async () => {
  const root = await temporaryRoot();
  const target = path.join(root, "target.ts");
  const content = "export const answer = 42;\n";
  const candidate = path.join(root, "candidate.ts");
  await writeFile(target, content);
  for (const source of [
    "export const = ;",
    Buffer.from([0xff, 0xfe, 0xff]),
    " ".repeat(2 * 1024 * 1024 + 1),
  ]) {
    await writeFile(candidate, source);
    await expect(
      deleteFilesSafely({ [target]: { expectedSha256: sha256(content) } }),
    ).rejects.toMatchObject({ code: "reference_verification_failed" });
    expect(await readFile(target, "utf8")).toBe(content);
  }
  await rm(candidate);
  await mkdir(path.join(root, "node_modules/deep"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules/deep/invalid.ts"),
    "export const = ;",
  );
  const controller = new AbortController();
  controller.abort(new Error("cancelled before deletion"));
  await expect(
    deleteFilesSafely(
      { [target]: { expectedSha256: sha256(content) } },
      controller.signal,
    ),
  ).rejects.toThrow("cancelled before deletion");
  expect(await readFile(target, "utf8")).toBe(content);
  await deleteFilesSafely({ [target]: { expectedSha256: sha256(content) } });
  expect(await Bun.file(target).exists()).toBeFalse();
});

test("reference override preserves the content hash guard", async () => {
  const root = await temporaryRoot();
  const target = path.join(root, "source.ts");
  const content = "export const answer = 42;\n";
  await writeFile(target, content);
  await expect(
    deleteFilesSafely({
      [target]: { expectedSha256: sha256("stale"), forceReferences: true },
    }),
  ).rejects.toThrow("Stale file context");
  expect(await readFile(target, "utf8")).toBe(content);
});

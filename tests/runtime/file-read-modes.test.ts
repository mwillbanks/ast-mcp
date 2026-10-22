import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { currentConfig, withConfig } from "../../src/config";
import {
  WorkspaceRegistry,
  withWorkspaceContext,
} from "../../src/intelligence/workspace";
import { inspectFileCapabilities } from "../../src/runtime/file-capabilities";
import {
  hashFilesSafely,
  historicalCapabilities,
  inspectWorkspaceFileCapabilitiesSafely,
  readFileSafely,
  FILE_READ_MAX_BYTES,
} from "../../src/runtime/file-read";
import { hermeticConfig } from "../support/hermetic-config";

test("read modes reject unavailable AST access, oversized documents and invalid bounds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-read-modes-"));
  try {
    const text = path.join(root, "value.txt");
    const document = path.join(root, "large.json");
    await writeFile(text, "value");
    await writeFile(
      document,
      JSON.stringify({ value: "x".repeat(FILE_READ_MAX_BYTES) }),
    );
    await withConfig(hermeticConfig(root), async () => {
      await expect(
        readFileSafely({ filePath: text, mode: "ast" }),
      ).rejects.toMatchObject({ code: "read_mode_unavailable" });
      await expect(
        readFileSafely({ filePath: document, mode: "ast" }),
      ).rejects.toMatchObject({ code: "document_source_too_large" });
      for (const lines of [
        [-1, 2],
        [1, 1],
        [0, 1.5],
      ] as [number, number][]) {
        await expect(
          readFileSafely({ filePath: text, mode: "text", lines }),
        ).rejects.toThrow("file_read line");
      }
      for (const paths of [[], Array(51).fill(text)])
        await expect(hashFilesSafely(paths)).rejects.toThrow(
          "requires between",
        );
      await expect(
        readFileSafely({ filePath: root, mode: "text" }),
      ).rejects.toThrow("Not a regular file");
      const capabilities = await inspectFileCapabilities(
        text,
        "unsupported-language",
      );
      expect(capabilities.parseStatus).toBe("unsupported");
      const invalidSource = path.join(root, "invalid.ts");
      await writeFile(invalidSource, "export const = ;");
      expect(await inspectFileCapabilities(invalidSource)).toMatchObject({
        parseStatus: "invalid",
        parseErrorCount: expect.any(Number),
      });
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("historical capabilities preserve parse failures, binary classification and policy intersections", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-historical-capabilities-"),
  );
  try {
    await withConfig(hermeticConfig(root), async () => {
      const json = path.join(root, "value.json");
      expect(
        await historicalCapabilities(json, Buffer.from("{")),
      ).toMatchObject({
        kind: "document",
        parseStatus: "invalid",
        parseErrorCount: 1,
        intrinsic: { patch: [], read: ["text"], search: [] },
      });
      expect(
        await historicalCapabilities(json, Buffer.from([0, 1])),
      ).toMatchObject({ kind: "binary", intrinsic: { read: [] } });
      expect(
        await historicalCapabilities(
          path.join(root, "value.ts"),
          Buffer.from("const a=1;"),
          "typescript",
        ),
      ).toMatchObject({
        kind: "source",
        parseStatus: "unsupported",
        language: "typescript",
        intrinsic: { read: ["text"] },
      });
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("historical reads and hashes use committed bytes after the working file changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-read-history-"));
  const git = (args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    git(["init", "-q"]);
    const file = path.join(root, "value.json");
    await writeFile(file, '{"version":1}\n');
    git(["add", "value.json"]);
    git(["commit", "-qm", "fixture"]);
    const oid = git(["rev-parse", "HEAD"]);
    await writeFile(file, '{"version":2}\n');
    await withConfig(hermeticConfig(root), async () => {
      const registry = new WorkspaceRegistry();
      const workspace = await registry.open({
        directory: root,
        configurationGeneration: (await currentConfig()).generation,
        revision: { kind: "commit", oid },
        storage: { kind: "explicit", path: path.join(root, "storage") },
      });
      await withWorkspaceContext(workspace, async () => {
        const [capabilities] = await inspectWorkspaceFileCapabilitiesSafely([
          file,
        ]);
        expect(capabilities).toMatchObject({
          kind: "document",
          parseStatus: "parseable",
          effective: { patch: [] },
        });
        const ast = await readFileSafely({ filePath: file, mode: "ast" });
        expect(ast.ast).toMatchObject({
          values: [{ selector: "", value: { version: 1 } }],
        });
        const text = await readFileSafely({ filePath: file, mode: "text" });
        expect(text.content).toBe('{"version":1}\n');
        expect((await hashFilesSafely([file]))[0]?.sha256).toBe(text.sha256);
      });
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

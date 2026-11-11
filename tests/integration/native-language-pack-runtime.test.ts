import { expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveConfig, withResolvedConfig } from "../../src/config";
import {
  findStructuralMatches,
  parseSource,
  ParserWorkerPool,
  pinnedGrammarRegistration,
} from "../../src/intelligence/parser/index.ts";
import { nativeGrammarSet } from "../../src/intelligence/parser/native-pack-selection.ts";
import { createNativeProcess } from "../../src/intelligence/parser/native-process.ts";
import { nativePackDescriptor } from "../../src/language-packs/catalog.ts";
import { PatchPreparationPool } from "../../src/patch/strategy/worker-client.ts";
import { inspectFileCapabilities } from "../../src/runtime/file-capabilities.ts";
import type {
  CpuJob,
  CpuReply,
} from "../../src/tools/code-intelligence-worker.ts";

const samples = [
  ["python", "sample.py", "# 🙂\r\nprint(1)\r\n", "print(1)", "print(2)"],
  [
    "go",
    "sample.go",
    "package main\r\n// 🙂\r\nfunc main() { f(1) }\r\n",
    "f(1)",
    "f(2)",
  ],
  ["sql", "sample.sql", "-- 🙂\r\nSELECT 1;\r\n", "SELECT 1", "SELECT 2"],
] as const;

test.skipIf(!nativePackDescriptor("python"))(
  "loads exact managed grammars in isolated workers and preserves native ranges and bytes offline",
  async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "ast-mcp-pack-runtime-")),
    );
    const config = await resolveConfig({
      cwd: root,
      env: { XDG_CONFIG_HOME: path.join(root, "configuration") },
      home: root,
    });
    const store = config.languagePacks!.directory;
    await mkdir(store, { mode: 0o700, recursive: true });
    const parsers = new ParserWorkerPool({
      minWorkers: 0,
      maxWorkers: 1,
      nativePackContext: { config, checkoutRoot: root },
    });
    const patchers = new PatchPreparationPool({ maxWorkers: 1 });
    const assets = new Set<string>();
    try {
      for (const [language, name, source, pattern, replacement] of samples) {
        const descriptor = nativePackDescriptor(language)!;
        const asset = path.join(store, descriptor.filename);
        assets.add(asset);
        await copyFile(pinnedGrammarRegistration(language).libraryPath, asset);
        await chmod(asset, 0o400);
        const filePath = path.join(root, name);
        await writeFile(filePath, source);

        const request = { languageId: language, source };
        const bundled = parseSource(request);
        const managed = await parsers.parse(request);
        expect(managed.grammarFingerprint).not.toBe(bundled.grammarFingerprint);
        expect(
          managed.nodes.map(({ kind, range }) => ({ kind, range })),
        ).toEqual(bundled.nodes.map(({ kind, range }) => ({ kind, range })));
        expect(await parsers.parse(request)).toEqual(managed);
        const expectedMatches = findStructuralMatches(
          source,
          language,
          pattern,
        );
        expect(expectedMatches).toHaveLength(1);

        const packs = await nativeGrammarSet([language], config, root);
        expect(packs).toBeDefined();
        const nativeProcess = createNativeProcess(
          new URL(
            "../../src/tools/code-intelligence-worker.ts",
            import.meta.url,
          ),
          "code-intelligence",
        );
        try {
          const job: CpuJob = {
            aliases: [],
            files: [{ facts: managed, path: filePath, source }],
            input: { pattern },
            kind: "compute",
            name: "run",
            root,
          };
          const result = await new Promise<CpuReply>((resolve, reject) => {
            nativeProcess.once("error", reject);
            nativeProcess.once("exit", () =>
              reject(new Error("Native worker exited")),
            );
            nativeProcess.once("message", (message) =>
              resolve(message as CpuReply),
            );
            nativeProcess.postMessage({ ...job, packs });
          });
          if (!result.ok) throw new Error(result.error.message);
          const actual = (
            result.value as {
              items: Array<{ id: string; range: unknown; text: string }>;
            }
          ).items;
          expect(actual).toHaveLength(1);
          expect(actual[0]!.id).not.toBe(expectedMatches[0]!.id);
          expect(actual[0]!.range).toEqual(expectedMatches[0]!.range);
          expect(actual[0]!.text).toBe(expectedMatches[0]!.text);
        } finally {
          await nativeProcess.terminate();
        }

        const patch = await withResolvedConfig(config, async () => {
          const capabilities = await inspectFileCapabilities(
            filePath,
            language,
          );
          const context = {
            capabilities,
            filePath,
            language,
            mode: 0o600,
            original: source,
          };
          try {
            return await patchers.prepare("ast", {
              ...context,
              aiderBlocks: [],
              astRules: [{ expectedMatches: 1, fix: replacement, pattern }],
            });
          } finally {
            if (process.platform === "win32") {
              // The one-slot pool dispatches this job after the native DLL worker exits.
              const text = await patchers.prepare("aider_block", {
                ...context,
                aiderBlocks: [{ search: pattern, replace: replacement }],
                astRules: [],
              });
              expect(text.candidate).toBe(
                source.replace(pattern, replacement).replaceAll("\r\n", "\n"),
              );
            }
          }
        });
        expect(patch.candidate).toBe(source.replace(pattern, replacement));
        expect(await Bun.file(filePath).text()).toBe(source);

        if (process.platform === "win32") {
          // Keep the managed cache entry, but release the DLL before replacing its bytes.
          await parsers.parse({
            languageId: "typescript",
            source: `const retiredGrammar = ${JSON.stringify(language)};`,
          });
        }
        await chmod(asset, 0o600);
        await writeFile(asset, "corrupt");
        await chmod(asset, 0o400);
        await expect(parsers.parse(request)).rejects.toThrow("digest mismatch");
        if (process.platform === "win32") await chmod(asset, 0o600);
        await rm(asset);
        assets.delete(asset);
        expect((await parsers.parse(request)).grammarFingerprint).toBe(
          bundled.grammarFingerprint,
        );
      }
    } finally {
      await parsers.close();
      if (process.platform === "win32") {
        for (const asset of assets) {
          if (await Bun.file(asset).exists()) await chmod(asset, 0o600);
        }
      }
      await rm(root, { force: true, recursive: true });
    }
  },
);

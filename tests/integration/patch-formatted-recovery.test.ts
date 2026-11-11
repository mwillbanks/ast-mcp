import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  currentConfig,
  withConfig,
  withResolvedConfig,
} from "../../src/config";
import { withMutationLifecycle } from "../../src/intelligence/mutation/lifecycle";
import { patchFiles } from "../../src/patch/engine";
import { sha256 } from "../../src/runtime/hash";
import { hermeticConfig } from "../support/hermetic-config";

test("patch rejects invalid formatter output and journals exact valid bytes", async () => {
  const folder = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-patch-formatter-"),
  );
  const root = await realpath(folder);
  const file = path.join(root, "source.ts");
  const original = "export const state: number = 1;\n";
  const validated = "export const state: number = 3;\n";
  const candidates: Array<string | null> = [];
  try {
    await writeFile(
      path.join(root, "ast-mcp.toml"),
      'version = 2\n[[paths]]\nid = "workspace"\npath = "."\npolicies = { read = "allow", write = "allow", delete = "allow" }\n',
    );
    await writeFile(file, original);
    await withConfig(hermeticConfig(root), async () => {
      const config = await currentConfig();
      await withResolvedConfig(
        {
          ...config,
          formatting: {
            ...config.formatting,
            enabled: true,
            fallback: "reject",
            formatters: [
              {
                id: "formatter-fixture",
                command: process.execPath,
                args: [
                  "-e",
                  'const source = await Bun.stdin.text(); process.stdout.write(source.includes("rejected") ? \'export const state: number = ;\\n\' : source.replace("2", "3"));',
                ],
                extensions: [".ts"],
                globs: [],
                mode: "stdout",
                enabled: true,
                timeoutMs: 3000,
              },
            ],
          },
        },
        () =>
          withMutationLifecycle(
            {
              begin: async (plan) => {
                candidates.push(
                  ...plan.files.map((entry) => entry.candidateSha256),
                );
              },
              committed: async () => {},
              complete: async () => null,
              failed: async () => {},
              rolledBack: async () => {},
            },
            async () => {
              const patch = (replacement: string) =>
                patchFiles({
                  [file]: {
                    aiderBlocks: [{ search: original, replace: replacement }],
                    expectedSha256: sha256(original),
                    patchStrategy: "aider_block",
                  },
                });
              await expect(
                patch("export const state: number = 9; // rejected\n"),
              ).rejects.toMatchObject({
                code: "candidate_parse_error",
              });
              expect(candidates).toEqual([]);
              expect(await readFile(file, "utf8")).toBe(original);

              await patch("export const state: number = 2;\n");
              expect(candidates).toEqual([sha256(validated)]);
              expect(await readFile(file, "utf8")).toBe(validated);
            },
          ),
      );
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

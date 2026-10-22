import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  currentConfig,
  withConfig,
  withResolvedConfig,
} from "../../src/config";
import { formatContent } from "../../src/runtime/format";
import { hermeticConfig } from "../support/hermetic-config";

test("glob formatters resolve the selected external workspace root and cwd", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-formatter-root-"),
  );
  const external = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-formatter-external-"),
  );
  try {
    await withConfig(hermeticConfig(root), async () => {
      const config = await currentConfig();
      await withResolvedConfig(
        {
          ...config,
          workspace: { ...config.workspace, roots: [external] },
          formatting: {
            ...config.formatting,
            enabled: true,
            fallback: "reject",
            formatters: [
              {
                id: "root",
                command: process.execPath,
                args: [
                  "-e",
                  'process.stdout.write(process.cwd()+"|"+process.argv[1]+"|"+await Bun.stdin.text())',
                  "{project_root}",
                ],
                extensions: [],
                globs: ["**/*.data"],
                mode: "stdout",
                enabled: true,
                timeoutMs: 1000,
              },
            ],
          },
        },
        async () => {
          const output = await formatContent(
            path.join(external, "value.data"),
            "candidate",
          );
          const [cwd, placeholder, value] = output.split("|");
          expect(await fs.realpath(cwd!)).toBe(await fs.realpath(external));
          expect(await fs.realpath(placeholder!)).toBe(
            await fs.realpath(external),
          );
          expect(value).toBe("candidate");
        },
      );
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  }
});

test("staging cleanup failures reject even successfully formatted content", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-formatter-cleanup-"),
  );
  const remove = fs.rm;
  try {
    await withConfig(hermeticConfig(root), async () => {
      const config = await currentConfig();
      const failure = spyOn(fs, "rm").mockImplementation(
        async (target, options) => {
          if (path.basename(String(target)).startsWith(".ast-mcp-format-"))
            throw new Error("cleanup denied");
          return remove(target, options);
        },
      );
      try {
        await withResolvedConfig(
          {
            ...config,
            formatting: {
              ...config.formatting,
              enabled: true,
              fallback: "preserve",
              formatters: [
                {
                  id: "cleanup",
                  command: process.execPath,
                  args: ["-e", ""],
                  extensions: [".txt"],
                  globs: [],
                  mode: "in_place",
                  enabled: true,
                  timeoutMs: 1000,
                },
              ],
            },
          },
          async () => {
            await expect(
              formatContent(path.join(root, "value.txt"), "candidate"),
            ).rejects.toMatchObject({
              code: "formatter_cleanup_failed",
              message: expect.stringContaining("cleanup denied"),
            });
          },
        );
      } finally {
        failure.mockRestore();
      }
    });
  } finally {
    await remove(root, { recursive: true, force: true });
  }
});

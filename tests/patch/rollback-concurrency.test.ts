import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withConfig } from "../../src/config";
import { withMutationLifecycle } from "../../src/intelligence/mutation/lifecycle";
import { writeFilesSafely } from "../../src/patch/engine";
import { sha256 } from "../../src/runtime/hash";
import { hermeticConfig } from "../support/hermetic-config";

for (const existing of [true, false]) {
  test(
    "rollback preserves a concurrent writer for " +
      (existing ? "existing" : "created") +
      " files",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "ast-mcp-rollback-cas-"),
      );
      const target = path.join(root, "target.txt");
      await mkdir(path.join(root, ".git"));
      await writeFile(
        path.join(root, "ast-mcp.toml"),
        'version = 2\n[formatting]\nenabled = false\n[[paths]]\nid = "workspace"\npath = "."\npolicies = { read = "allow", write = "allow", delete = "allow" }\n',
      );
      if (existing) await writeFile(target, "before");
      try {
        await expect(
          withConfig(hermeticConfig(root), () =>
            withMutationLifecycle(
              {
                begin: async () => {},
                committed: async () => {
                  await writeFile(target, "concurrent writer");
                  throw new Error("journal failed");
                },
                complete: async () => null,
                failed: async () => {},
                rolledBack: async () => {},
              },
              () =>
                writeFilesSafely({
                  [target]: {
                    ...(existing ? { expectedSha256: sha256("before") } : {}),
                    content: "batch commit",
                  },
                }),
            ),
          ),
        ).rejects.toThrow("rollback requires recovery");
        expect(await readFile(target, "utf8")).toBe("concurrent writer");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

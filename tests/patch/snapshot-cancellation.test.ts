import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withConfig } from "../../src/config";
import { patchFiles, writeFilesSafely } from "../../src/patch/engine";
import { sha256 } from "../../src/runtime/hash";
import { hermeticConfig } from "../support/hermetic-config";

test.skipIf(process.platform === "win32")(
  "mutation batches reject FIFO snapshots without waiting for a writer",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-patch-fifo-"));
    const target = path.join(root, "pipe.txt");
    await mkdir(path.join(root, ".git"));
    await writeFile(
      path.join(root, "ast-mcp.toml"),
      'version = 2\n[formatting]\nenabled = false\n[[paths]]\nid = "workspace"\npath = "."\npolicies = { read = "allow", write = "allow", delete = "allow" }\n',
    );
    const created = Bun.spawn(["mkfifo", target], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await created.exited).toBe(0);
    try {
      for (const kind of ["patch", "write"] as const) {
        await expect(
          withConfig(hermeticConfig(root), () =>
            kind === "patch"
              ? patchFiles({
                  [target]: {
                    expectedSha256: sha256(""),
                    patchStrategy: "aider_block",
                    aiderBlocks: [{ search: "x", replace: "y" }],
                  },
                })
              : writeFilesSafely({
                  [target]: { expectedSha256: sha256(""), content: "new" },
                }),
          ),
        ).rejects.toThrow("regular");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  3000,
);

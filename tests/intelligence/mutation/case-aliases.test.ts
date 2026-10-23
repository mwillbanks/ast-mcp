import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withFencedFileLocks } from "../../../src/intelligence/mutation/locks.ts";

test.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
  "absent case aliases share one batch lease",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-case-alias-"));
    try {
      await withFencedFileLocks(
        [path.join(root, "Missing.ts"), path.join(root, "missing.ts")],
        async (leases) => {
          expect(leases).toHaveLength(1);
          await leases[0]!.fence();
        },
        { deadline: Date.now() + 200 },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

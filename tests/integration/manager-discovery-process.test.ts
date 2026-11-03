import { expect, spyOn, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import * as runtimeBinaries from "../../src/runtime/binary-resolution";
import * as exportedBinaries from "../../templates/skills/ast-mcp/scripts/binary-resolution";

// The native subprocess watchdog must terminate a nonresponsive package manager.
for (const [surface, binaries] of [
  ["runtime", runtimeBinaries],
  ["exported skill", exportedBinaries],
] as const) {
  test(`${surface} bounds stalled manager discovery and continues after timeout`, () => {
    const execute = Bun.spawnSync;
    let calls = 0;
    const base = path.resolve(os.tmpdir(), "ast-mcp-stalled-manager");
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(((
      args: string[],
      options: NonNullable<Parameters<typeof Bun.spawnSync>[1]>,
    ) => {
      calls++;
      expect(options).toMatchObject({
        stdin: "ignore",
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 65536,
      });
      if (calls === 1)
        return execute(
          [process.execPath, "-e", "setInterval(() => {}, 1000)"],
          options,
        );
      return {
        exitCode: args[0] === "pnpm" ? 0 : 1,
        stdout: Buffer.from(base),
      };
    }) as never);
    try {
      expect(
        binaries.globalBinDirectories(
          "ast-mcp-fixture",
          process.platform,
          base,
        ),
      ).toContain(base);
      expect(calls).toBe(5);
    } finally {
      spawn.mockRestore();
    }
  });
}

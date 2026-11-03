import { expect, test } from "bun:test";

import { verifyMcpLaunch } from "../../src/installer/health";

test("installer rejects malformed protocol and excessive output", async () => {
  for (const [code, diagnostic] of [
    [
      'process.stdout.write("invalid\\n"); setInterval(() => {}, 60000);',
      "JSON",
    ],
    [
      'process.stdout.write("x".repeat(11 * 1024 * 1024)); setInterval(() => {}, 60000);',
      "output exceeded",
    ],
    [
      'process.stderr.write("x".repeat(11 * 1024 * 1024)); setInterval(() => {}, 60000);',
      "diagnostic output exceeded",
    ],
  ]) {
    await expect(
      verifyMcpLaunch({ command: process.execPath, args: ["-e", code] }),
    ).rejects.toThrow(diagnostic);
  }
});

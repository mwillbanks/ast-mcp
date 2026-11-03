import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { reconcileSkillExport } from "../../src/skills/export";
import { spawnLiveProcess } from "./support/live-process";

// Only an independent process can prove the OS releases a dead owner's lock.
test("killed export owners do not block future exports", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-export-owner-"),
  );
  const identity = path.join(await fs.realpath(root), ".ast-mcp-export.lock");
  const modulePath = Bun.fileURLToPath(
    new URL("../../src/runtime/transaction-lock.ts", import.meta.url),
  );
  const script = `import {acquireTransactionLock} from ${JSON.stringify(modulePath)}; const lease=await acquireTransactionLock(${JSON.stringify(identity + "-different-private-account")}, {sharedDatabasePath: ${JSON.stringify(identity + ".sqlite")}}); console.log("ready"); await Bun.stdin.text(); lease.release();`;
  const child = spawnLiveProcess(process.execPath, ["-e", script]);
  const current = [
    { relative: "SKILL.md", bytes: Buffer.from("first") },
    { relative: "references/tools.md", bytes: Buffer.from("tools") },
  ];
  try {
    expect(await child.readStdoutLine()).toBe("ready");
    await expect(reconcileSkillExport(root, "export", current)).rejects.toThrow(
      "locked",
    );
    child.process.kill("SIGKILL");
    await child.waitForExit();
    expect(
      (await reconcileSkillExport(root, "export", current)).written,
    ).toEqual(["SKILL.md", "references/tools.md"]);
  } finally {
    await child.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

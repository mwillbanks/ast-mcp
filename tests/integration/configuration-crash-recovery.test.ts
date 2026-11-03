import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withConfigTransaction } from "../../src/config/transaction";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-config-crash-"));
  const file = path.join(root, "ast-mcp.toml");
  await writeFile(file, "version = 2\n");
  return { root, file };
}

test("configuration ownership recovers immediately after its process is killed", async () => {
  const { root, file } = await fixture();
  const modulePath = Bun.fileURLToPath(
    new URL("../../src/config/transaction.ts", import.meta.url),
  );
  const script = `import {withConfigTransaction} from ${JSON.stringify(modulePath)}; withConfigTransaction(${JSON.stringify(file)},()=>{console.log("ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Lock owner never became ready")),
          3000,
        );
      }),
    ]);
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    expect(() => withConfigTransaction(file, () => {})).toThrow(
      expect.objectContaining({ code: "configuration_busy" }),
    );
    child.kill("SIGKILL");
    await child.exited;
    expect(withConfigTransaction(file, () => true)).toBe(true);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await reader.cancel().catch(() => undefined);
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});

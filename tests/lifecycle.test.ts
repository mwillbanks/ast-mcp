import { expect, test } from "bun:test";

import { readFile } from "node:fs/promises";
import path from "node:path";

test("stdio entrypoint uses the signal-aware server lifecycle", async () => {
  const [entrypoint, lifecycle] = await Promise.all([
    readFile(path.resolve(import.meta.dir, "../src/index.ts"), "utf8"),
    readFile(path.resolve(import.meta.dir, "../src/lifecycle.ts"), "utf8"),
  ]);

  expect(entrypoint).toContain("createProcessServer as createServer");
  expect(lifecycle).toContain(
    "installProcessSignalHandlers(server.close.bind(server))",
  );
});

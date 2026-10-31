import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { checkInstall } from "../../templates/skills/ast-mcp/scripts/check-install";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("standalone checker keeps exact canonical release helper", async () => {
  const [canonical, bundled] = await Promise.all([
    readFile("src/runtime/release.ts", "utf8"),
    readFile("templates/skills/ast-mcp/scripts/release.ts", "utf8"),
  ]);
  expect(bundled).toBe(canonical);
});

test("missing installation still attempts a fresh release check without claiming a running version", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-check-diagnostics-"),
  );
  created.push(root);
  let requests = 0;
  const fetcher = (async () => {
    requests++;
    return new Response(JSON.stringify({ version: "1.2.3" }));
  }) as unknown as typeof fetch;
  for (let attempt = 0; attempt < 2; attempt++) {
    const report = await checkInstall(
      ["--target", "claude", "--root", root],
      root,
      { fetch: fetcher },
    );
    expect(report.diagnostics.connectedServerVersion).toBe("unknown");
    expect(report.diagnostics.versionCheck.latestVersion).toBe("1.2.3");
    expect(report.diagnostics.versionCheck.status).toBe("unavailable");
    expect(JSON.stringify(report.diagnostics)).not.toContain("Codex Desktop");
  }
  expect(requests).toBe(2);
});

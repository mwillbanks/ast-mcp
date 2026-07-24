import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function availablePort() {
  const probe = Bun.serve({
    fetch: () => new Response("probe"),
    port: 0,
  });
  const port = probe.port;
  probe.stop(true);
  return port;
}

test("HTTP startup reads project TOML before binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-http-config-"));
  const port = availablePort();
  await mkdir(path.join(root, ".git"));
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    `[http]
host = "127.0.0.1"
port = ${port}
session_timeout_ms = 5000
session_sweep_interval_ms = 1000
`,
  );

  const processHandle = Bun.spawn(
    [process.execPath, path.resolve(import.meta.dir, "../src/http-entry.ts")],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        AST_MCP_PROJECT_ROOT: root,
        PORT: undefined,
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      response = await fetch(`http://127.0.0.1:${port}/missing`).catch(
        () => undefined,
      );
      if (response) break;
      await Bun.sleep(25);
    }
    expect(response?.status).toBe(404);
  } finally {
    if (processHandle.exitCode === null) processHandle.kill("SIGTERM");
    await processHandle.exited;
    await rm(root, { force: true, recursive: true });
  }
});

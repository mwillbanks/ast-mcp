import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { spawnHttpMcpProcess } from "./support/live-process";

test("HTTP startup reads project TOML before binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-http-config-"));
  await mkdir(path.join(root, ".git"));
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    `[http]
host = "127.0.0.1"
port = 3768
session_timeout_ms = 5000
session_sweep_interval_ms = 1000
`,
  );

  const server = await spawnHttpMcpProcess(
    process.execPath,
    [path.resolve(import.meta.dir, "../bin/ast-mcp.ts"), "mcp"],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        AST_MCP_PROJECT_ROOT: root,
        PORT: undefined,
      },
      host: false,
    },
  );

  try {
    expect((await fetch(new URL("/missing", server.url))).status).toBe(404);
  } finally {
    await server.stop();
    await rm(root, { force: true, recursive: true });
  }
});

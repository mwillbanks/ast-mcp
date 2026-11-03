import { expect, test } from "bun:test";

import { spawnHttpMcpProcess } from "./support/live-process";

test("starts Streamable HTTP through the stable mcp subcommand", async () => {
  const server = await spawnHttpMcpProcess(
    process.execPath,
    ["bin/ast-mcp.ts", "mcp"],
    { cwd: process.cwd() },
  );
  try {
    expect((await fetch(server.url)).status).toBe(400);
  } finally {
    await server.stop();
  }
});

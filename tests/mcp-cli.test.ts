import { expect, test } from "bun:test";
import { runMcpCli } from "../src/mcp-cli";
import { spawnHttpMcpProcess } from "./support/live-process";

test("validates MCP transport arguments", async () => {
  await expect(runMcpCli(["--transport", "invalid"])).rejects.toThrow(
    "expected stdio or http",
  );
  await expect(runMcpCli(["--host", "127.0.0.1"])).rejects.toThrow(
    "require --transport http",
  );
  await expect(
    runMcpCli(["--transport", "http", "--port", "70000"]),
  ).rejects.toThrow("1 through 65535");
  const ephemeral = await runMcpCli(["--transport", "http", "--port", "0"], {
    http: async (options) => ({ url: new URL(`http://x:${options.port}`) }),
  });
  expect(ephemeral?.url.port).toBe("0");
});

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

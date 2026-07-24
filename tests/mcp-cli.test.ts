import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:net";
import { runMcpCli } from "../src/mcp-cli";

const children: Bun.Subprocess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      child.kill("SIGTERM");
      await child.exited;
    }),
  );
});

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

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
});

test("starts Streamable HTTP through the stable mcp subcommand", async () => {
  const port = await availablePort();
  const child = Bun.spawn(
    [
      "bun",
      "bin/ast-mcp.ts",
      "mcp",
      "--transport",
      "http",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: process.cwd(), stderr: "pipe", stdout: "pipe" },
  );
  children.push(child);
  const url = `http://127.0.0.1:${port}/mcp`;
  let response: Response | undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      response = await fetch(url);
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  expect(response?.status).toBe(400);
  child.kill("SIGTERM");
  expect(await child.exited).toBe(0);
});

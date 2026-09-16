import { expect, test } from "bun:test";
import path from "node:path";
import { spawnHttpMcpProcess } from "./support/live-process";

test.skipIf(process.platform === "win32")(
  "HTTP entrypoint closes cleanly on SIGHUP",
  async () => {
    const server = await spawnHttpMcpProcess(
      process.execPath,
      [path.resolve(import.meta.dir, "../bin/ast-mcp.ts"), "mcp"],
      {},
    );

    try {
      expect((await fetch(new URL("/health", server.url))).status).toBe(404);

      const initialized = await fetch(server.url, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "shutdown-test", version: "1.0.0" },
            protocolVersion: "2025-06-18",
          },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(initialized.status).toBe(200);
      expect(initialized.headers.get("mcp-session-id")).toBeTruthy();

      server.process.kill("SIGHUP");
      expect(await server.waitForExit()).toBe(0);
    } finally {
      await server.stop();
    }
  },
);

import { expect, test } from "bun:test";
import path from "node:path";

import { verifyMcpLaunch } from "../../src/installer/health";

function cleanupFixture(cleanup: string) {
  return `import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "ast-mcp" } } }));
  if (request.id === 2) console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: ["file_read", "file_hash", "file_patch", "workspace_open"].map(name => ({ name })) } }));
});
input.on("close", () => { ${cleanup} });`;
}

test("installer awaits graceful cleanup lasting more than 500 milliseconds", async () => {
  const started = performance.now();
  await verifyMcpLaunch({
    command: process.execPath,
    args: ["-e", cleanupFixture("setTimeout(() => process.exit(0), 700);")],
  });
  expect(performance.now() - started).toBeGreaterThanOrEqual(700);
});

test("installer rejects failed cleanup and retains its diagnostics", async () => {
  await expect(
    verifyMcpLaunch({
      command: process.execPath,
      args: [
        "-e",
        cleanupFixture(
          'process.stderr.write("cleanup failed"); process.exit(7);',
        ),
      ],
    }),
  ).rejects.toThrow(
    "shutdown failed (code 7, signal null)\nStderr: cleanup failed",
  );
});

test("installer bounds cleanup separately from the initialization deadline", async () => {
  const started = performance.now();
  await expect(
    verifyMcpLaunch(
      {
        command: process.execPath,
        args: [
          "-e",
          cleanupFixture(
            'process.stderr.write("cleanup stalled"); setInterval(() => {}, 60000);',
          ),
        ],
      },
      1000,
      50,
    ),
  ).rejects.toThrow("shutdown timed out\nStderr: cleanup stalled");
  expect(performance.now() - started).toBeLessThan(2000);
});

test("installer verifies real initialization and required tool discovery", async () => {
  await verifyMcpLaunch({
    args: [path.resolve(import.meta.dir, "../../bin/ast-mcp.ts"), "mcp"],
    command: process.execPath,
    cwd: path.resolve(import.meta.dir, "../.."),
  });
});

test("installer rejects missing executables, early exit, and unresponsive commands", async () => {
  await expect(
    verifyMcpLaunch({
      args: [],
      command: path.resolve(import.meta.dir, "not-an-executable"),
    }),
  ).rejects.toThrow("MCP launch failed");
  await expect(
    verifyMcpLaunch({
      args: ["-e", "process.exit(0)"],
      command: process.execPath,
    }),
  ).rejects.toThrow("before tool discovery");
  await expect(
    verifyMcpLaunch(
      {
        args: ["-e", "setInterval(() => {}, 60000)"],
        command: process.execPath,
      },
      20,
    ),
  ).rejects.toThrow("timed out");
});

test("installer rejects servers missing essential tools", async () => {
  const code = `process.stdin.on("data", chunk => {
    for (const line of chunk.toString().trim().split("\\n")) {
      const request = JSON.parse(line);
      if (request.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "ast-mcp" } } }));
      if (request.id === 2) console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }));
    }
  });`;
  await expect(
    verifyMcpLaunch({ args: ["-e", code], command: process.execPath }),
  ).rejects.toThrow("missing required");
});

test("installer retains bounded stderr startup diagnostics", async () => {
  await expect(
    verifyMcpLaunch({
      command: process.execPath,
      args: [
        "-e",
        'process.stderr.write("missing parser dependency"); process.exit(1);',
      ],
    }),
  ).rejects.toThrow("missing parser dependency");
});

import { expect, test } from "bun:test";
import { createServer } from "node:net";
import path from "node:path";

async function availablePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a test port");
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

test("HTTP entrypoint closes cleanly on SIGHUP", async () => {
  const port = await availablePort();
  const processHandle = Bun.spawn(
    [process.execPath, path.resolve(import.meta.dir, "../src/http-entry.ts")],
    {
      env: { ...process.env, PORT: String(port) },
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      response = await fetch(`http://127.0.0.1:${port}/health`).catch(
        () => undefined,
      );
      if (response) break;
      await Bun.sleep(25);
    }
    expect(response?.status).toBe(404);

    const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
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

    processHandle.kill("SIGHUP");

    const [exitCode, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  } finally {
    if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
  }
});

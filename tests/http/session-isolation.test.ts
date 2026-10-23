import { expect, spyOn, test } from "bun:test";

import { startHttpServer } from "../../src/http";
import * as lifecycle from "../../src/server/lifecycle";

const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  "mcp-protocol-version": "2025-06-18",
};
async function initialize(url: URL) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "session-isolation", version: "1" },
      },
    }),
  });
  await response.text();
  expect(response.status).toBe(200);
  return response.headers.get("mcp-session-id")!;
}
async function ping(url: URL, id: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": id },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });
  await response.text();
  return response.status;
}
test("HTTP servers isolate sessions and close only their own resources", async () => {
  const signals = [
    "SIGTERM",
    "SIGINT",
    "SIGHUP",
    "uncaughtException",
    "unhandledRejection",
  ] as const;
  const before = signals.map((name) => process.listenerCount(name));
  const first = await startHttpServer({ host: "127.0.0.1", port: 0 });
  const second = await startHttpServer({ host: "127.0.0.1", port: 0 });
  const firstUrl = new URL("/mcp", first.url);
  const secondUrl = new URL("/mcp", second.url);
  try {
    const firstId = await initialize(firstUrl);
    const secondId = await initialize(secondUrl);
    expect(firstId).not.toBe(secondId);
    expect(await ping(firstUrl, firstId)).toBe(200);
    expect(await ping(secondUrl, firstId)).toBe(404);
    expect(await ping(firstUrl, secondId)).toBe(404);
    const close = first.close();
    expect(first.close()).toBe(close);
    await close;
    expect(await ping(secondUrl, secondId)).toBe(200);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
  expect(signals.map((name) => process.listenerCount(name))).toEqual(before);
});

test("shutdown releases a legacy server awaiting connection and rejects late registration", async () => {
  const original = lifecycle.createServer;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const connected = Promise.withResolvers<void>();
  let closes = 0;
  let transportCloses = 0;
  const injected = spyOn(lifecycle, "createServer").mockImplementation(
    (...args) => {
      const server = original(...args);
      const connect = server.connect.bind(server);
      const close = server.close.bind(server);
      server.connect = async (...connectionArgs) => {
        const transport = connectionArgs[0];
        const closeTransport = transport.close.bind(transport);
        transport.close = async () => {
          transportCloses++;
          await closeTransport();
        };
        started.resolve();
        await release.promise;
        try {
          return await connect(...connectionArgs);
        } finally {
          connected.resolve();
        }
      };
      server.close = async () => {
        closes++;
        await close();
      };
      return server;
    },
  );
  const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
  const request = fetch(new URL("/mcp", server.url), {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pending-initialize", version: "1" },
      },
    }),
  }).then(
    async (response) => {
      await response.text();
      return response.status;
    },
    () => 503,
  );
  try {
    await Promise.race([
      started.promise,
      request.then(() => {
        throw new Error("setup did not start");
      }),
      Bun.sleep(1000).then(() => {
        throw new Error("setup timed out");
      }),
    ]);
    await Promise.race([
      server.close(),
      Bun.sleep(1000).then(() => {
        throw new Error("shutdown blocked");
      }),
    ]);
    expect(closes).toBeGreaterThan(0);
    expect(await request).toBe(503);
    const beforeLateConnection = closes;
    release.resolve();
    await connected.promise;
    await Bun.sleep(0);
    expect(closes).toBeGreaterThan(beforeLateConnection);
    expect(transportCloses).toBeGreaterThan(0);
  } finally {
    release.resolve();
    await server.close();
    injected.mockRestore();
  }
});

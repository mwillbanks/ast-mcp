import { expect, spyOn, test } from "bun:test";

import { startHttpServer } from "../../src/http";
import * as lifecycle from "../../src/server/lifecycle";

const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  "mcp-protocol-version": "2025-06-18",
};
const initialization = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "http-lifecycle", version: "1" },
  },
});
async function initialize(server: Awaited<ReturnType<typeof startHttpServer>>) {
  const response = await fetch(new URL("/mcp", server.url), {
    method: "POST",
    headers,
    body: initialization,
  });
  await response.text();
  expect(response.status).toBe(200);
  return response.headers.get("mcp-session-id")!;
}
async function request(
  server: Awaited<ReturnType<typeof startHttpServer>>,
  method: string,
  sessionId?: string,
) {
  const response = await fetch(new URL("/mcp", server.url), {
    method,
    headers: {
      ...headers,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
  });
  await response.text();
  return response.status;
}

test("legacy endpoint validates methods and releases deleted sessions", async () => {
  const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
  try {
    expect(await request(server, "GET")).toBe(400);
    expect(await request(server, "DELETE")).toBe(400);
    expect(await request(server, "PUT")).toBe(405);
    expect((await fetch(new URL("/absent", server.url))).status).toBe(404);
    const id = await initialize(server);
    expect(await request(server, "DELETE", id)).toBe(200);
    expect(await request(server, "GET", id)).toBe(404);
  } finally {
    await server.close();
  }
});

test("idle sessions expire without closing an active server", async () => {
  const before = {
    timeout: process.env.AST_MCP_SESSION_TIMEOUT_MS,
    sweep: process.env.AST_MCP_SESSION_SWEEP_INTERVAL_MS,
  };
  process.env.AST_MCP_SESSION_TIMEOUT_MS = "10";
  process.env.AST_MCP_SESSION_SWEEP_INTERVAL_MS = "5";
  const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
  try {
    const id = await initialize(server);
    await Bun.sleep(40);
    const expired = await fetch(new URL("/mcp", server.url), {
      method: "POST",
      headers: { ...headers, "mcp-session-id": id },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    await expired.text();
    expect(expired.status).toBe(404);
    expect(await initialize(server)).not.toBe(id);
  } finally {
    await server.close();
    for (const [key, value] of [
      ["AST_MCP_SESSION_TIMEOUT_MS", before.timeout],
      ["AST_MCP_SESSION_SWEEP_INTERVAL_MS", before.sweep],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("modern discovery creates request scoped servers", async () => {
  const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(new URL("/mcp", server.url), {
      method: "POST",
      headers: {
        ...headers,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "modern-http",
              version: "1",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("result");
    expect(response.headers.get("mcp-session-id")).toBeNull();
  } finally {
    await server.close();
  }
});

test("DELETE closes sessions when transport omits its close callback", async () => {
  const original = lifecycle.createServer;
  let closed = 0;
  const injected = spyOn(lifecycle, "createServer").mockImplementation(
    (...args) => {
      const server = original(...args);
      const connect = server.connect.bind(server);
      const close = server.close.bind(server);
      server.connect = async (transport, ...rest) => {
        const http =
          transport as import("@modelcontextprotocol/server").WebStandardStreamableHTTPServerTransport;
        const handle = http.handleRequest.bind(http);
        http.handleRequest = async (request, ...options) =>
          request.method === "DELETE"
            ? new Response(null, { status: 200 })
            : handle(request, ...options);
        return connect(transport, ...rest);
      };
      server.close = async () => {
        closed++;
        await close();
      };
      return server;
    },
  );
  const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
  try {
    const id = await initialize(server);
    expect(await request(server, "DELETE", id)).toBe(200);
    expect(closed).toBeGreaterThan(0);
    expect(await request(server, "GET", id)).toBe(404);
  } finally {
    await server.close();
    injected.mockRestore();
  }
});

test("closed HTTP servers reject accepted requests", async () => {
  const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
  await server.close();
  expect(
    (await server.fetch(new Request(new URL("/mcp", server.url).href))).status,
  ).toBe(503);
});

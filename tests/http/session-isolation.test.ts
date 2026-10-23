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

const failureInitialization = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "http-faults", version: "1" },
  },
});
test("an uninitialized legacy request releases its temporary server", async () => {
  const original = lifecycle.createServer;
  let closed = 0;
  const injected = spyOn(lifecycle, "createServer").mockImplementation(
    (...args) => {
      const server = original(...args);
      const close = server.close.bind(server);
      server.close = async () => {
        closed++;
        await close();
      };
      return server;
    },
  );
  const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(new URL("/mcp", server.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    await response.text();
    expect(response.status).toBe(400);
    expect(closed).toBeGreaterThan(0);
  } finally {
    await server.close();
    injected.mockRestore();
  }
});
test("setup errors preserve the original failure and report cleanup failures", async () => {
  const original = lifecycle.createServer;
  const injected = spyOn(lifecycle, "createServer").mockImplementation(
    (...args) => {
      const server = original(...args);
      const close = server.close.bind(server);
      server.connect = async () => {
        throw new Error("setup failure");
      };
      server.close = async () => {
        await close();
        throw "cleanup failure";
      };
      return server;
    },
  );
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
  const failures: unknown[] = [];
  // Bun accepts partial reload options while its declarations require a full server configuration.
  server.reload({
    error: (error: Error) => {
      failures.push(error);
      return new Response(null, { status: 500 });
    },
  } as Parameters<typeof server.reload>[0]);
  try {
    const response = await fetch(new URL("/mcp", server.url), {
      method: "POST",
      headers,
      body: failureInitialization,
    });
    await response.text();
    expect(response.status).toBe(500);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ message: "setup failure" });
    expect(
      stderr.mock.calls.some(([message]) =>
        String(message).includes("HTTP setup cleanup failed: cleanup failure"),
      ),
    ).toBe(true);
  } finally {
    await server.close();
    stderr.mockRestore();
    injected.mockRestore();
  }
});
test("process failure reporting forwards the error to every active session", async () => {
  let report: Parameters<typeof lifecycle.installProcessFailureHandlers>[3];
  const failureHook = spyOn(
    lifecycle,
    "installProcessFailureHandlers",
  ).mockImplementation((_shutdown, _target, _deadline, reporter) => {
    report = reporter;
    return () => {};
  });
  const original = lifecycle.createServer;
  const errors: unknown[] = [];
  const injected = spyOn(lifecycle, "createServer").mockImplementation(
    (...args) => {
      const server = original(...args);
      server.telemetry.reportException = (error) => {
        errors.push(error);
      };
      return server;
    },
  );
  const server = await startHttpServer({ host: "127.0.0.1", port: 0 });
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(new URL("/mcp", server.url), {
        method: "POST",
        headers,
        body: failureInitialization,
      });
      await response.text();
      expect(response.status).toBe(200);
    }
    const error = new Error("process failure");
    report!(error);
    expect(errors).toEqual([error, error]);
  } finally {
    await server.close();
    injected.mockRestore();
    failureHook.mockRestore();
  }
});

const legacyInitialization = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "http-lifecycle", version: "1" },
  },
});
async function initializeLegacySession(
  server: Awaited<ReturnType<typeof startHttpServer>>,
) {
  const response = await fetch(new URL("/mcp", server.url), {
    method: "POST",
    headers,
    body: legacyInitialization,
  });
  await response.text();
  expect(response.status).toBe(200);
  return response.headers.get("mcp-session-id")!;
}
async function legacyRequest(
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
    expect(await legacyRequest(server, "GET")).toBe(400);
    expect(await legacyRequest(server, "DELETE")).toBe(400);
    expect(await legacyRequest(server, "PUT")).toBe(405);
    expect((await fetch(new URL("/absent", server.url))).status).toBe(404);
    const id = await initializeLegacySession(server);
    expect(await legacyRequest(server, "DELETE", id)).toBe(200);
    expect(await legacyRequest(server, "GET", id)).toBe(404);
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
    const id = await initializeLegacySession(server);
    await Bun.sleep(40);
    const expired = await fetch(new URL("/mcp", server.url), {
      method: "POST",
      headers: { ...headers, "mcp-session-id": id },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    await expired.text();
    expect(expired.status).toBe(404);
    expect(await initializeLegacySession(server)).not.toBe(id);
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
    const id = await initializeLegacySession(server);
    expect(await legacyRequest(server, "DELETE", id)).toBe(200);
    expect(closed).toBeGreaterThan(0);
    expect(await legacyRequest(server, "GET", id)).toBe(404);
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

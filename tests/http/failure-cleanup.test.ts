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
      body: initialization,
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
        body: initialization,
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

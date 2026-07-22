import { expect, test } from "bun:test";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

function request(body: unknown, sessionId?: string) {
  return new Request("http://127.0.0.1/mcp", {
    body: JSON.stringify(body),
    headers: {
      ...headers,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    method: "POST",
  });
}

test("streamable HTTP batch suppresses notification responses", async () => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => "batch-session",
  });
  const server = new McpServer({ name: "batch-test-server", version: "1.0.0" });
  await server.connect(transport);

  try {
    const initialize = await transport.handleRequest(
      request({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "batch-test", version: "1.0.0" },
          protocolVersion: "2025-06-18",
        },
      }),
    );
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-session-id")).toBe("batch-session");

    const response = await transport.handleRequest(
      request(
        [
          {
            jsonrpc: "2.0",
            method: "notifications/initialized",
            params: {},
          },
          { id: 2, jsonrpc: "2.0", method: "ping", params: {} },
          { id: 3, jsonrpc: "2.0", method: "ping", params: {} },
        ],
        "batch-session",
      ),
    );
    expect(response.status).toBe(200);

    const messages = (await response.json()) as Array<{
      id: number;
      result: unknown;
    }>;
    expect(messages.map((message) => message.id).sort()).toEqual([2, 3]);
    expect(messages.every((message) => message.result)).toBeTrue();
  } finally {
    await server.close();
  }
});

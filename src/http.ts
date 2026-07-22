import type { McpServer } from "@modelcontextprotocol/server";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { serve } from "bun";

import { createServer, installProcessSignalHandlers } from "./lifecycle";

const { PORT = "3000" } = process.env;

function httpBinding() {
  return { hostname: process.env.AST_MCP_HTTP_HOST ?? "127.0.0.1" };
}
function durationFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const SESSION_TIMEOUT_MS = durationFromEnv(
  "AST_MCP_SESSION_TIMEOUT_MS",
  30 * 60 * 1000,
);
const SESSION_SWEEP_INTERVAL_MS = durationFromEnv(
  "AST_MCP_SESSION_SWEEP_INTERVAL_MS",
  60 * 1000,
); // 30 minutes

const sessions = new Map<
  string,
  {
    transport: WebStandardStreamableHTTPServerTransport;
    server: McpServer;
    lastActivity: number;
  }
>();

// Clean up idle sessions periodically
const sessionSweep = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      void session.server.close();
      sessions.delete(id);
    }
  }
}, SESSION_SWEEP_INTERVAL_MS);

export function startHttpServer() {
  const httpServer = serve({
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname !== "/mcp") {
        return new Response("Not found", { status: 404 });
      }

      const sessionId = request.headers.get("mcp-session-id");

      if (request.method === "GET" || request.method === "DELETE") {
        if (!sessionId) {
          return new Response("Missing session ID", { status: 400 });
        }

        const session = sessions.get(sessionId);
        if (!session) {
          return new Response("Session not found", { status: 404 });
        }

        session.lastActivity = Date.now();
        const response = await session.transport.handleRequest(request);

        if (request.method === "DELETE") {
          await session.server.close();
          sessions.delete(sessionId);
        }

        return response;
      }

      if (request.method === "POST") {
        if (sessionId) {
          const session = sessions.get(sessionId);
          if (!session) {
            return new Response("Session not found", { status: 404 });
          }

          session.lastActivity = Date.now();
          return session.transport.handleRequest(request);
        }

        const server = createServer();

        const transport = new WebStandardStreamableHTTPServerTransport({
          onsessionclosed: (closedSessionId) => {
            const session = sessions.get(closedSessionId);
            if (session) {
              void session.server.close();
              sessions.delete(closedSessionId);
            }
          },
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, {
              lastActivity: Date.now(),
              server,
              transport,
            });
          },
          sessionIdGenerator: () => crypto.randomUUID(),
        });

        await server.connect(transport);

        return transport.handleRequest(request);
      }

      return new Response("Method not allowed", { status: 405 });
    },
    port: Number(PORT),
    ...httpBinding(),
  });
  let shutdown: Promise<void> | undefined;
  installProcessSignalHandlers(() => {
    shutdown ??= (async () => {
      httpServer.stop(false);
      clearInterval(sessionSweep);
      const results = await Promise.allSettled(
        [...sessions.values()].map((session) => session.server.close()),
      );
      sessions.clear();
      httpServer.stop(true);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return shutdown;
  });
  return httpServer;
}

if (import.meta.main) startHttpServer();

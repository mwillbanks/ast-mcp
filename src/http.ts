import type { McpServer } from "@modelcontextprotocol/server";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { serve } from "bun";

import { type ResolvedConfig, resolveConfig } from "./config";
import { createServer, installProcessSignalHandlers } from "./lifecycle";

const configuration = resolveConfig;

function httpBinding(config: ResolvedConfig) {
  return { hostname: config.http.host };
}
function updateSessionDurations(config: ResolvedConfig) {
  SESSION_TIMEOUT_MS = config.http.sessionTimeoutMs;
  SESSION_SWEEP_INTERVAL_MS = config.http.sessionSweepIntervalMs;
}

let SESSION_TIMEOUT_MS = 30 * 60 * 1000;
let SESSION_SWEEP_INTERVAL_MS = 60 * 1000; // 30 minutes

const sessions = new Map<
  string,
  {
    transport: WebStandardStreamableHTTPServerTransport;
    server: McpServer;
    lastActivity: number;
  }
>();

// Clean up idle sessions periodically
let sessionSweep: ReturnType<typeof setInterval> | undefined;

export async function startHttpServer(
  overrides: { host?: string; port?: number } = {},
) {
  const config = await configuration();
  updateSessionDurations(config);
  sessionSweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        void session.server.close();
        sessions.delete(id);
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);

  const httpServer = serve({
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname !== "/mcp")
        return new Response("Not found", { status: 404 });

      const sessionId = request.headers.get("mcp-session-id");

      if (request.method === "GET" || request.method === "DELETE") {
        if (!sessionId)
          return new Response("Missing session ID", { status: 400 });

        const session = sessions.get(sessionId);
        if (!session) return new Response("Session not found", { status: 404 });

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
          if (!session)
            return new Response("Session not found", { status: 404 });

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
    port: overrides.port ?? config.http.port,
    ...httpBinding({
      ...config,
      http: { ...config.http, host: overrides.host ?? config.http.host },
    }),
  });
  let shutdown: Promise<void> | undefined;
  installProcessSignalHandlers(() => {
    shutdown ??= (async () => {
      httpServer.stop(false);
      if (sessionSweep) clearInterval(sessionSweep);
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

if (import.meta.main) await startHttpServer();

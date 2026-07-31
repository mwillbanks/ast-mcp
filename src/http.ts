import type { McpServer } from "@modelcontextprotocol/server";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { serve } from "bun";

import { type ResolvedConfig, resolveConfig } from "./config";
import { createServer, installProcessSignalHandlers } from "./lifecycle";
import { clearSessionApprovals } from "./runtime/approval";

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

function discardSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  clearSessionApprovals(sessionId);
  void session.server.close().catch(() => undefined);
}

async function closeSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  clearSessionApprovals(sessionId);
  await session.server.close();
}

function sweepExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) discardSession(id);
  }
}

function startSessionSweep() {
  sessionSweep = setInterval(sweepExpiredSessions, SESSION_SWEEP_INTERVAL_MS);
}

async function existingSessionRequest(
  request: Request,
  sessionId: string,
  closeAfterResponse = false,
) {
  const session = sessions.get(sessionId);
  if (!session) return new Response("Session not found", { status: 404 });
  session.lastActivity = Date.now();
  const response = await session.transport.handleRequest(request);
  if (closeAfterResponse) await closeSession(sessionId);
  return response;
}

function sessionTransport(server: ReturnType<typeof createServer>) {
  let transport: WebStandardStreamableHTTPServerTransport;
  transport = new WebStandardStreamableHTTPServerTransport({
    onsessionclosed: discardSession,
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, {
        lastActivity: Date.now(),
        server,
        transport,
      });
    },
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  return transport;
}

async function createSession(request: Request) {
  const server = createServer();
  const transport = sessionTransport(server);
  await server.connect(transport);
  return transport.handleRequest(request);
}

async function sessionRequest(request: Request) {
  const sessionId = request.headers.get("mcp-session-id");
  if (request.method === "GET" || request.method === "DELETE") {
    if (!sessionId) return new Response("Missing session ID", { status: 400 });
    return existingSessionRequest(
      request,
      sessionId,
      request.method === "DELETE",
    );
  }
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  return sessionId
    ? existingSessionRequest(request, sessionId)
    : createSession(request);
}

function handleMcpRequest(request: Request) {
  const url = new URL(request.url);
  return url.pathname === "/mcp"
    ? sessionRequest(request)
    : new Response("Not found", { status: 404 });
}

async function shutdownHttpServer(httpServer: ReturnType<typeof serve>) {
  httpServer.stop(false);
  if (sessionSweep) clearInterval(sessionSweep);
  const activeSessions = [...sessions.entries()];
  for (const [sessionId] of activeSessions) clearSessionApprovals(sessionId);
  const results = await Promise.allSettled(
    activeSessions.map(([, session]) => session.server.close()),
  );
  sessions.clear();
  httpServer.stop(true);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export async function startHttpServer(
  overrides: { host?: string; port?: number } = {},
) {
  const config = await configuration();
  updateSessionDurations(config);
  startSessionSweep();
  const httpServer = serve({
    fetch: handleMcpRequest,
    port: overrides.port ?? config.http.port,
    ...httpBinding({
      ...config,
      http: { ...config.http, host: overrides.host ?? config.http.host },
    }),
  });
  let shutdown: Promise<void> | undefined;
  installProcessSignalHandlers(() => {
    shutdown ??= shutdownHttpServer(httpServer);
    return shutdown;
  });
  return httpServer;
}

if (import.meta.main) await startHttpServer();

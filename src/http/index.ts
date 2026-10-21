import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { serve } from "bun";

import { type ResolvedConfig, resolveConfig } from "../config";
import { WorkspaceRegistry } from "../intelligence/workspace/index.ts";
import { clearSessionApprovals } from "../runtime/approval";
import {
  createServer,
  installProcessFailureHandlers,
  installProcessSignalHandlers,
} from "../server/lifecycle";

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
    server: ReturnType<typeof createServer>;
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
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    if (![...sessions.values()].some((session) => session.server === server))
      await server.close();
    return response;
  } catch (error) {
    await server.close().catch((closeError) => {
      process.stderr.write(
        `ast-mcp HTTP setup cleanup failed: ${closeError instanceof Error ? closeError.message : String(closeError)}\n`,
      );
    });
    throw error;
  }
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

function modernHttpHandler() {
  const workspaceRegistry = new WorkspaceRegistry();
  return createMcpHandler(
    () => createServer({}, {}, { workspaceRegistry, requestScoped: true }),
    { legacy: "reject", responseMode: "sse" },
  );
}

async function handleMcpRequest(
  request: Request,
  server: Pick<Bun.Server<unknown>, "timeout">,
  modernHandler: ReturnType<typeof modernHttpHandler>,
) {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp")
    return new Response("Not found", { status: 404 });
  server.timeout(request, 0);
  return (await isLegacyRequest(request))
    ? sessionRequest(request)
    : modernHandler.fetch(request);
}

async function shutdownHttpServer(
  httpServer: ReturnType<typeof serve>,
  modernHandler: ReturnType<typeof modernHttpHandler>,
) {
  httpServer.stop(false);
  if (sessionSweep) clearInterval(sessionSweep);
  const activeSessions = [...sessions.entries()];
  for (const [sessionId] of activeSessions) clearSessionApprovals(sessionId);
  const results = await Promise.allSettled([
    ...activeSessions.map(([, session]) => session.server.close()),
    modernHandler.close(),
  ]);
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
  const modernHandler = modernHttpHandler();
  const httpServer = serve({
    fetch: (request, server) =>
      handleMcpRequest(request, server, modernHandler),
    port: overrides.port ?? config.http.port,
    ...httpBinding({
      ...config,
      http: { ...config.http, host: overrides.host ?? config.http.host },
    }),
  });
  startSessionSweep();
  let shutdown: Promise<void> | undefined;
  const close = () => {
    shutdown ??= shutdownHttpServer(httpServer, modernHandler);
    return shutdown;
  };
  installProcessSignalHandlers(close);
  installProcessFailureHandlers(close, process, 5000, (error) => {
    for (const session of sessions.values())
      session.server.telemetry.reportException(error);
  });
  return httpServer;
}

if (import.meta.main) await startHttpServer();

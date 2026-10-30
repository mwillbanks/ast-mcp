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
function sessionRuntime(config: ResolvedConfig) {
  const SESSION_TIMEOUT_MS = config.http.sessionTimeoutMs;
  const SESSION_SWEEP_INTERVAL_MS = config.http.sessionSweepIntervalMs;

  const sessions = new Map<
    string,
    {
      transport: WebStandardStreamableHTTPServerTransport;
      server: ReturnType<typeof createServer>;
      lastActivity: number;
    }
  >();

  let closing = false;
  const servers = new Set<ReturnType<typeof createServer>>();
  const cleanup = new Set<Promise<void>>();
  const setupAbort = new AbortController();

  function closeServer(server: ReturnType<typeof createServer>) {
    servers.delete(server);
    const pending = server.close();
    cleanup.add(pending);
    void pending.finally(() => cleanup.delete(pending)).catch(() => undefined);
    return pending;
  }

  // Clean up idle sessions periodically
  let sessionSweep: ReturnType<typeof setInterval> | undefined;

  function discardSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    clearSessionApprovals(sessionId, session.server);
    void closeServer(session.server).catch(() => undefined);
  }

  async function closeSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    clearSessionApprovals(sessionId, session.server);
    await closeServer(session.server);
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
        if (closing) return;
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
    const server = createServer({}, {}, {}, { transport: "http" });
    servers.add(server);
    const transport = sessionTransport(server);
    const signal = AbortSignal.any([request.signal, setupAbort.signal]);
    let interrupt: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = () => reject(signal.reason);
      signal.addEventListener("abort", interrupt, { once: true });
    });
    const connected = server.connect(transport);
    // A delayed connection must release resources even after shutdown returned.
    void connected
      .then(async () => {
        if (signal.aborted) {
          await transport.close();
          await closeServer(server);
        }
      })
      .catch(() => undefined);
    try {
      signal.throwIfAborted();
      await Promise.race([connected, interrupted]);
      const response = await Promise.race([
        transport.handleRequest(request),
        interrupted,
      ]);
      if (![...sessions.values()].some((session) => session.server === server))
        await closeServer(server);
      return response;
    } catch (error) {
      await closeServer(server).catch((closeError) => {
        process.stderr.write(
          `ast-mcp HTTP setup cleanup failed: ${closeError instanceof Error ? closeError.message : String(closeError)}\n`,
        );
      });
      if (closing) return new Response("Server shutting down", { status: 503 });
      throw error;
    } finally {
      signal.removeEventListener("abort", interrupt!);
    }
  }

  async function sessionRequest(request: Request) {
    const sessionId = request.headers.get("mcp-session-id");
    if (request.method === "GET" || request.method === "DELETE") {
      if (!sessionId)
        return new Response("Missing session ID", { status: 400 });
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
      () =>
        createServer(
          {},
          {},
          { workspaceRegistry, requestScoped: true },
          { transport: "http" },
        ),
      { legacy: "reject", responseMode: "sse" },
    );
  }

  async function handleMcpRequest(
    request: Request,
    server: Pick<Bun.Server<unknown>, "timeout">,
    modernHandler: ReturnType<typeof modernHttpHandler>,
  ) {
    if (closing) return new Response("Server shutting down", { status: 503 });
    const url = new URL(request.url);
    if (url.pathname !== "/mcp")
      return new Response("Not found", { status: 404 });
    server.timeout(request, 0);
    const legacy = await isLegacyRequest(request);
    if (closing) return new Response("Server shutting down", { status: 503 });
    return legacy ? sessionRequest(request) : modernHandler.fetch(request);
  }

  async function shutdownHttpServer(
    httpServer: ReturnType<typeof serve>,
    modernHandler: ReturnType<typeof modernHttpHandler>,
  ) {
    closing = true;
    setupAbort.abort(new Error("HTTP server shutting down"));
    httpServer.stop(false);
    if (sessionSweep) clearInterval(sessionSweep);
    const activeSessions = [...sessions.entries()];
    for (const [sessionId, session] of activeSessions)
      clearSessionApprovals(sessionId, session.server);
    const results = await Promise.allSettled([
      ...[...servers].map(closeServer),
      ...cleanup,
      modernHandler.close(),
    ]);
    sessions.clear();
    httpServer.stop(true);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  return {
    handleMcpRequest,
    modernHttpHandler,
    shutdownHttpServer,
    startSessionSweep,
    reportException(error: unknown) {
      for (const session of sessions.values())
        session.server.telemetry.reportException(error);
    },
  };
}

export async function startHttpServer(
  overrides: { host?: string; port?: number } = {},
) {
  const config = await configuration();
  const runtime = sessionRuntime(config);
  const modernHandler = runtime.modernHttpHandler();
  const httpServer = serve({
    fetch: (request, server) =>
      runtime.handleMcpRequest(request, server, modernHandler),
    port: overrides.port ?? config.http.port,
    ...httpBinding({
      ...config,
      http: { ...config.http, host: overrides.host ?? config.http.host },
    }),
  });
  runtime.startSessionSweep();
  let disposeSignals: (() => void) | undefined;
  let disposeFailures: (() => void) | undefined;
  let shutdown: Promise<void> | undefined;
  const close = () => {
    shutdown ??= Promise.resolve().then(async () => {
      try {
        await runtime.shutdownHttpServer(httpServer, modernHandler);
      } finally {
        disposeSignals?.();
        disposeFailures?.();
      }
    });
    return shutdown;
  };
  disposeSignals = installProcessSignalHandlers(close);
  disposeFailures = installProcessFailureHandlers(
    close,
    process,
    5000,
    runtime.reportException,
  );
  return Object.assign(httpServer, { close });
}

if (import.meta.main) await startHttpServer();

import { once } from "node:events";
import {
  type AddressInfo,
  createServer,
  type Server,
  type Socket,
} from "node:net";

import { createDeadline } from "../../runtime/deadline";
import {
  installProcessFailureHandlers,
  installProcessSignalHandlers,
} from "../../runtime/signals";
import { BatchingStdioServerTransport } from "../stdio";
import {
  brokerDirectory,
  brokerHost,
  createEndpoint,
  publishEndpoint,
  removeEndpoint,
  tryBrokerGate,
} from "./endpoint";
import {
  announceBrokerReady,
  authenticateBrokerClient,
  type BrokerLaunch,
} from "./handshake";

const defaultStartupMs = 10_000;
const drainMs = 5_000;
const handshakeMs = 2_000;
const maxSessions = 128;

interface BrokerSession {
  close(): Promise<void>;
}

export interface SharedBrokerOptions {
  installationKey: string;
  connectSession(
    transport: BatchingStdioServerTransport,
    launch: BrokerLaunch,
  ): Promise<BrokerSession>;
  stopBackgroundWork?(): Promise<void>;
  closeProjectRuntimes?(): Promise<void>;
  lifetime?: ReturnType<typeof standaloneBrokerLifetime>;
  signal?: AbortSignal;
  onListening?(port: number): void;
}

export function standaloneBrokerLifetime(
  host: {
    once(event: "exit", listener: () => void): void;
    exit(code: number): void;
  } = process,
) {
  return {
    // Keep exclusive ownership while referenced work finishes at shutdown.
    holdOwner(release: () => void) {
      host.once("exit", release);
    },
    // The kernel sends final EOF as the process releases its memory.
    retire(socket: Socket | undefined, remainingMs: number) {
      setTimeout(() => host.exit(1), remainingMs).unref();
      socket?.unref();
    },
    timeout() {
      host.exit(1);
    },
  };
}

function report(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ast-mcp shared broker: ${message.slice(0, 500)}\n`);
}

async function listen(server: Server): Promise<number> {
  const ready = once(server, "listening");
  server.listen(0, brokerHost);
  await ready;
  // The numeric port and host select TCP, so a listening server has AddressInfo.
  return (server.address() as AddressInfo).port;
}

function closed(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  // Unlike events.once, this resolves on close even if a socket error precedes it.
  return new Promise((resolve) => socket.once("close", resolve));
}

async function drain(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<false>();
  const timer = setTimeout(resolve, timeoutMs, false);
  try {
    return await Promise.race([work.then(() => true), promise]);
  } finally {
    clearTimeout(timer);
  }
}

function sessionRuntime(options: SharedBrokerOptions) {
  const sockets = new Set<Socket>();
  const connected = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  let lastClient: Socket | undefined;
  let startup: ReturnType<typeof setTimeout> | undefined;
  let secret: string | undefined;
  let admitted = false;
  let stopping = false;
  const stop = Promise.withResolvers<void>();

  function requestStop() {
    stopping = true;
    clearTimeout(startup);
    stop.resolve();
  }

  function leave(socket: Socket, orderly = false) {
    if (!connected.delete(socket) || !admitted || connected.size) return;
    // The last orderly client observes EOF only after bounded project teardown.
    if (orderly && !stopping) lastClient = socket;
    requestStop();
  }

  async function session(socket: Socket, secret: string): Promise<void> {
    const disconnected = closed(socket);
    const connection = new AbortController();
    const cancel = () =>
      connection.abort(new Error("Broker client disconnected"));
    socket.once("close", cancel);
    let transport: BatchingStdioServerTransport | undefined;
    let attached: BrokerSession | undefined;
    try {
      using deadline = createDeadline(handshakeMs, connection.signal);
      // Stop stream delivery until the ready packet has authenticated this peer.
      socket.pause();
      const launch = await authenticateBrokerClient(
        socket,
        secret,
        deadline.signal,
      );
      // Admit the MCP session before the client may relay its first request.
      transport = new BatchingStdioServerTransport(socket, socket);
      const attachedSession = options.connectSession(transport, launch);
      // Setup that finishes after disconnect must still close its resources.
      void attachedSession
        .then((late) => {
          if (!attached && connection.signal.aborted) return late.close();
        })
        .catch(report);
      try {
        const pending = Promise.withResolvers<never>();
        const abort = () => pending.reject(deadline.signal.reason);
        deadline.signal.addEventListener("abort", abort, { once: true });
        try {
          deadline.signal.throwIfAborted();
          attached = await Promise.race([attachedSession, pending.promise]);
        } finally {
          deadline.signal.removeEventListener("abort", abort);
        }
      } catch (error) {
        cancel();
        throw error;
      }
      deadline.signal.throwIfAborted();
      announceBrokerReady(socket);
      admitted = true;
      clearTimeout(startup);
      deadline.dispose();
      socket.resume();
      const ending = Promise.withResolvers<void>();
      const end = () => {
        leave(socket, true);
        ending.resolve();
      };
      socket.once("end", end);
      if (socket.readableEnded) end();
      await Promise.race([disconnected, ending.promise]);
      socket.off("end", end);
      if (socket !== lastClient && !socket.destroyed) socket.end();
    } finally {
      socket.off("close", cancel);
      if (socket !== lastClient && !socket.writableEnded) socket.destroy();
      try {
        await transport?.close();
      } finally {
        await attached?.close();
      }
    }
  }

  const listener = createServer(
    { allowHalfOpen: true, pauseOnConnect: true },
    (socket) => {
      // Do not log untrusted handshake content or let socket faults exit the broker.
      socket.on("error", () => {});
      if (
        stopping ||
        !secret ||
        sockets.size >= maxSessions ||
        pending.size >= maxSessions
      ) {
        socket.destroy();
        return;
      }
      socket.setNoDelay(true);
      sockets.add(socket);
      connected.add(socket);
      // Start bounded teardown even if closing a disconnected session stalls.
      socket.once("close", () => {
        sockets.delete(socket);
        leave(socket);
      });
      const work = session(socket, secret);
      pending.add(work);
      const releaseSession = () => pending.delete(work);
      void work.then(releaseSession, releaseSession);
    },
  );
  listener.on("error", (error) => {
    report(error);
    requestStop();
  });

  return {
    listener,
    begin(endpointSecret: string) {
      secret = endpointSecret;
      startup = setTimeout(requestStop, defaultStartupMs);
    },
    requestStop,
    wait: stop.promise,
    async close() {
      requestStop();
      if (listener.listening) listener.close();
      const finalSocket = lastClient;
      for (const socket of sockets) {
        if (socket !== finalSocket) socket.destroy();
      }
      const cutoff = performance.now() + drainMs;
      const finished = Promise.allSettled(pending).then(async () => {
        try {
          await options.stopBackgroundWork?.();
        } finally {
          await options.closeProjectRuntimes?.();
        }
        if (!finalSocket || finalSocket.destroyed) return;
        // Flush queued output before retiring either kind of broker.
        await new Promise<void>((resolve) =>
          finalSocket.write("", () => resolve()),
        );
        if (!options.lifetime && !finalSocket.destroyed) {
          const disconnected = closed(finalSocket);
          finalSocket.end();
          await disconnected;
        }
      });
      let drained = false;
      try {
        drained = await drain(finished, drainMs);
        if (drained)
          options.lifetime?.retire(
            finalSocket,
            Math.max(0, cutoff - performance.now()),
          );
        return drained;
      } finally {
        if (!drained || !options.lifetime) finalSocket?.destroy();
      }
    },
  };
}

export async function runSharedBroker(
  options: SharedBrokerOptions,
): Promise<void> {
  const directory = await brokerDirectory(options.installationKey);
  const release = await tryBrokerGate(directory, "owner");
  if (!release) return;
  options.lifetime?.holdOwner(release);
  const runtime = sessionRuntime(options);
  let published = false;
  let disposeSignals: (() => void) | undefined;
  let disposeFailures: (() => void) | undefined;
  let shutdown: Promise<void> | undefined;
  let drained = false;
  const close = () => {
    shutdown ??= Promise.resolve().then(async () => {
      runtime.requestStop();
      try {
        if (published) await removeEndpoint(directory);
      } finally {
        drained = await runtime.close();
      }
    });
    return shutdown;
  };
  try {
    const port = await listen(runtime.listener);
    const endpoint = createEndpoint(port);
    runtime.begin(endpoint.secret);
    await publishEndpoint(directory, endpoint);
    published = true;
    disposeSignals = installProcessSignalHandlers(
      close,
      process,
      drainMs + 1_000,
    );
    disposeFailures = installProcessFailureHandlers(
      close,
      process,
      drainMs + 1_000,
    );
    options.signal?.addEventListener("abort", runtime.requestStop, {
      once: true,
    });
    if (options.signal?.aborted) runtime.requestStop();
    options.onListening?.(port);
    await runtime.wait;
  } finally {
    try {
      await close();
    } finally {
      options.signal?.removeEventListener("abort", runtime.requestStop);
      disposeSignals?.();
      disposeFailures?.();
      if (!options.lifetime) release();
      if (!drained) {
        report("Shutdown deadline elapsed");
        options.lifetime?.timeout();
      }
    }
  }
}

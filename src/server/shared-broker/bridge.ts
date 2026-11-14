import { type FSWatcher, watch } from "node:fs";
import { createConnection, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { createDeadline } from "../../runtime/deadline";
import { PROCESS_SIGNALS } from "../../runtime/signals";
import {
  brokerDirectory,
  brokerHost,
  readEndpoint,
  tryBrokerGate,
} from "./endpoint";
import {
  BrokerHandshakeEof,
  type BrokerLaunch,
  connectBrokerSession,
} from "./handshake";

const startupMs = 10_000;
const connectMs = 2_000;
const retryMs = 50;

export interface StdioBridgeOptions {
  daemonCommand: readonly string[];
  installationKey: string;
  launch: BrokerLaunch;
  stdin?: Readable;
  stdout?: Writable;
}

/** Watch only while awaiting publication or retirement; poll if events are lost. */
function endpointChanges(directory: string) {
  let pending: (() => void) | undefined;
  let changed = false;
  const notify = () => {
    changed = true;
    pending?.();
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(directory, { persistent: false }, (_event, filename) => {
      if (filename === "endpoint.json" || filename === null) notify();
    });
    watcher.on("error", watcher.close.bind(watcher));
  } catch {
    // A bounded polling fallback also covers unsupported watchers.
  }
  return {
    async next(signal: AbortSignal) {
      signal.throwIfAborted();
      if (!changed) {
        const ready = Promise.withResolvers<void>();
        const stopTimer = new AbortController();
        pending = ready.resolve;
        try {
          await Promise.race([
            ready.promise,
            delay(retryMs, undefined, {
              signal: AbortSignal.any([signal, stopTimer.signal]),
            }),
          ]);
        } finally {
          pending = undefined;
          stopTimer.abort();
        }
      }
      changed = false;
    },
    [Symbol.dispose]() {
      watcher?.close();
    },
  };
}

async function endpointRetired(
  directory: string,
  secret: string,
  signal: AbortSignal,
): Promise<boolean> {
  using changes = endpointChanges(directory);
  while (!signal.aborted) {
    if ((await readEndpoint(directory))?.secret !== secret) return true;
    try {
      await changes.next(signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  return false;
}

/** Keep a socket error listener attached until the caller has taken ownership. */
async function tryConnect(
  directory: string,
  launch: BrokerLaunch,
  signal: AbortSignal,
): Promise<Socket | undefined> {
  const endpoint = await readEndpoint(directory);
  if (!endpoint) return;
  using deadline = createDeadline(connectMs, signal);
  const socket = createConnection({
    allowHalfOpen: true,
    host: brokerHost,
    port: endpoint.port,
  });
  socket.setNoDelay(true);
  // Handshake and relay each have their own observers. Cover transition gaps.
  socket.on("error", () => {});
  try {
    await connectBrokerSession(
      socket,
      launch,
      endpoint.secret,
      deadline.signal,
    );
    return socket;
  } catch (error) {
    socket.destroy();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED") return;
    // Idle shutdown can reject a connection before it removes its endpoint.
    // Without a generation change, EOF/reset may be a live broker rejecting us.
    if (
      (error instanceof BrokerHandshakeEof || code === "ECONNRESET") &&
      (await endpointRetired(directory, endpoint.secret, deadline.signal))
    )
      return;
    throw error;
  }
}

function launchBroker(command: readonly string[]): void {
  if (!command[0]) throw new Error("No executable for the shared MCP broker");
  Bun.spawn([...command], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();
}

async function openSession(
  options: StdioBridgeOptions,
  signal: AbortSignal,
): Promise<Socket> {
  using deadline = createDeadline(startupMs, signal);
  const directory = await brokerDirectory(options.installationKey);
  let release: (() => void) | undefined;
  let changes: ReturnType<typeof endpointChanges> | undefined;
  try {
    while (!deadline.signal.aborted) {
      const socket = await tryConnect(
        directory,
        options.launch,
        deadline.signal,
      );
      if (socket) return socket;
      // Subscribe before spawning to catch publication without a polling tick.
      changes ??= endpointChanges(directory);
      if (!release) {
        release = await tryBrokerGate(directory, "startup");
        if (release) {
          // The previous starter could publish while we acquired the gate.
          const live = await tryConnect(
            directory,
            options.launch,
            deadline.signal,
          );
          if (live) return live;
          const nobodyListening = await tryBrokerGate(directory, "owner");
          if (nobodyListening) {
            nobodyListening();
            launchBroker(options.daemonCommand);
          } else {
            release();
            release = undefined;
          }
        }
      }
      await changes.next(deadline.signal);
    }
    throw deadline.signal.reason;
  } finally {
    changes?.[Symbol.dispose]();
    release?.();
  }
}

function relay(
  socket: Socket,
  stdin: Readable,
  stdout: Writable,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let clientEnded = stdin.readableEnded || stdin.destroyed;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      stdin.unpipe(socket);
      stdin.pause();
      socket.unpipe(stdout);
      stdin.off("end", inputEnded);
      stdin.off("close", inputClosed);
      stdin.off("error", finish);
      stdout.off("close", outputClosed);
      stdout.off("error", finish);
      socket.off("error", finish);
      socket.off("end", socketEnded);
      socket.off("close", socketEnded);
      signal.removeEventListener("abort", outputClosed);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const inputEnded = () => {
      clientEnded = true;
    };
    const inputClosed = () => {
      clientEnded = true;
      if (!socket.writableEnded) socket.end();
    };
    const outputClosed = finish.bind(undefined, undefined);
    const socketEnded = () =>
      finish(
        clientEnded ? undefined : new Error("Shared MCP broker disconnected"),
      );
    stdin.once("end", inputEnded);
    stdin.once("close", inputClosed);
    stdin.on("error", finish);
    stdout.once("close", outputClosed);
    stdout.on("error", finish);
    socket.on("error", finish);
    socket.once("end", socketEnded);
    socket.once("close", socketEnded);
    signal.addEventListener("abort", outputClosed, { once: true });
    if (signal.aborted || stdout.destroyed) finish();
    else if (socket.destroyed || socket.readableEnded) socketEnded();
    else {
      socket.pipe(stdout, { end: false });
      if (clientEnded) socket.end();
      else stdin.pipe(socket);
    }
  });
}

/** Forward raw MCP bytes in both directions, without parsing or replay. */
export async function runStdioBridge(
  options: StdioBridgeOptions,
): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of PROCESS_SIGNALS) process.on(signal, abort);
  const cancelStartup = () => {
    if (!stdin.readableEnded) abort();
  };
  stdin.once("close", cancelStartup);
  stdout.once("close", abort);
  try {
    if (stdin.destroyed || stdout.destroyed) return;
    const socket = await openSession(options, controller.signal);
    stdin.off("close", cancelStartup);
    await relay(socket, stdin, stdout, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    for (const signal of PROCESS_SIGNALS) process.off(signal, abort);
    stdin.off("close", cancelStartup);
    stdout.off("close", abort);
  }
}

import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { watch } from "node:fs/promises";
import { createConnection, createServer, Server, type Socket } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import {
  type ManagedSubprocess,
  terminateProcessTree,
} from "../../src/runtime/subprocess";
import { runStdioBridge } from "../../src/server/shared-broker/bridge";
import {
  runSharedBroker,
  standaloneBrokerLifetime,
} from "../../src/server/shared-broker/broker";
import {
  brokerDirectory,
  brokerHost,
  createEndpoint,
  publishEndpoint,
  readEndpoint,
  removeEndpoint,
  tryBrokerGate,
} from "../../src/server/shared-broker/endpoint";
import { connectBrokerSession } from "../../src/server/shared-broker/handshake";
import { createMockTime } from "../support/mock-time";

const peerPath = Bun.fileURLToPath(
  new URL("./support/shared-broker-peer.ts", import.meta.url),
);
const ping = { id: 1, jsonrpc: "2.0", method: "ping" };

function openTestBridge(
  installationKey: string,
  client: ReturnType<typeof streams>,
  daemonCommand: string[] = [],
) {
  const bridge = runStdioBridge({
    daemonCommand,
    installationKey,
    launch: { cwd: process.cwd() },
    stdin: client.stdin,
    stdout: client.stdout,
  });
  void bridge.catch(() => undefined);
  return bridge;
}

async function assertLeft(directory: string) {
  const controller = new AbortController();
  const changes = watch(directory, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
  });
  try {
    const iterator = changes[Symbol.asyncIterator]();
    while (true) {
      const changed = iterator.next();
      void changed.catch(() => undefined);
      if (!(await readEndpoint(directory))) return;
      if ((await changed).done) throw new Error("Broker shutdown watch closed");
    }
  } finally {
    controller.abort();
    await changes.return?.();
  }
}

function peerFrame(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

async function readFrame(socket: Socket) {
  let buffered = Buffer.alloc(0);
  let size = 4;
  socket.resume();
  while (buffered.length < size) {
    const [chunk] = await once(socket, "data");
    socket.pause();
    buffered = Buffer.concat([buffered, chunk as Buffer]);
    if (buffered.length >= 4) size = 4 + buffered.readUInt32BE();
    if (buffered.length < size) socket.resume();
  }
  return JSON.parse(buffered.subarray(4).toString("utf8")) as unknown;
}

function streams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const responses = lines[Symbol.asyncIterator]();
  return {
    stdin,
    stdout,
    async read() {
      const line = await responses.next();
      if (line.done) throw new Error("The MCP session unexpectedly ended");
      return JSON.parse(line.value) as Record<string, unknown>;
    },
    close() {
      lines.close();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

test.skipIf(process.platform === "win32")(
  "the broker admits only authenticated independent stdio sessions",
  async () => {
    const installationKey = randomUUID();
    const stopped = new AbortController();
    const listening = Promise.withResolvers<number>();
    const sessionCount = Promise.withResolvers<void>();
    const clients = [streams(), streams()];
    const attached = new Set<number>();
    let opened = 0;
    let projectsClosed = false;
    const broker = runSharedBroker({
      installationKey,
      signal: stopped.signal,
      onListening: listening.resolve,
      async closeProjectRuntimes() {
        projectsClosed = true;
      },
      async connectSession(transport, launch) {
        const id = ++opened;
        attached.add(id);
        transport.onmessage = (message) => {
          if ("id" in message && "method" in message) {
            void transport.send({
              id: message.id,
              jsonrpc: "2.0",
              result: { cwd: launch.cwd, session: id },
            });
          }
        };
        await transport.start();
        if (attached.size === 2) sessionCount.resolve();
        return {
          async close() {
            attached.delete(id);
            await transport.close();
          },
        };
      },
    });
    const bridgeTasks: Promise<void>[] = [];
    try {
      const port = await Promise.race([
        listening.promise,
        broker.then(() => {
          throw new Error("The test broker did not start");
        }),
      ]);
      const badSocket = createConnection({ host: brokerHost, port });
      try {
        await expect(
          connectBrokerSession(
            badSocket,
            { cwd: process.cwd() },
            "0".repeat(64),
            AbortSignal.timeout(2_000),
          ),
        ).rejects.toThrow("Invalid shared MCP broker handshake");
        expect(opened).toBe(0);
      } finally {
        badSocket.destroy();
      }

      for (const client of clients) {
        bridgeTasks.push(
          runStdioBridge({
            daemonCommand: [],
            installationKey,
            launch: { cwd: process.cwd() },
            stdin: client.stdin,
            stdout: client.stdout,
          }),
        );
        void bridgeTasks.at(-1)?.catch(() => {});
      }
      await Promise.race([
        sessionCount.promise,
        Promise.race(bridgeTasks).then(() => {
          throw new Error("A test bridge stopped during setup");
        }),
      ]);

      const first = clients[0]!;
      const second = clients[1]!;
      const request = { id: 1, jsonrpc: "2.0", method: "ping" };
      first.stdin.write(
        JSON.stringify([{ jsonrpc: "2.0", method: "note" }, request]) + "\n",
      );
      second.stdin.write(JSON.stringify(request) + "\n");
      const [firstResponse, secondResponse] = await Promise.all([
        first.read(),
        second.read(),
      ]);
      expect(firstResponse.id).toBe(1);
      expect(secondResponse.id).toBe(1);
      expect(firstResponse.result).not.toEqual(secondResponse.result);

      first.stdin.end();
      await bridgeTasks[0];
      second.stdin.write(JSON.stringify({ ...request, id: 2 }) + "\n");
      expect((await second.read()).result).toEqual(secondResponse.result);
      second.stdin.end();
      await bridgeTasks[1];
    } finally {
      stopped.abort();
      for (const client of clients) client.close();
      await Promise.allSettled(bridgeTasks);
      await broker;
    }
    expect(projectsClosed).toBe(true);
    expect(attached.size).toBe(0);
    expect(
      await readEndpoint(await brokerDirectory(installationKey)),
    ).toBeUndefined();
  },
);

test.skipIf(process.platform === "win32")(
  "a competing broker cannot replace the live owner",
  async () => {
    const installationKey = randomUUID();
    const stopped = new AbortController();
    const listening = Promise.withResolvers<number>();
    function unexpectedSession(): never {
      throw new Error("The test does not attach MCP sessions");
    }
    const broker = runSharedBroker({
      installationKey,
      signal: stopped.signal,
      onListening: listening.resolve,
      connectSession: unexpectedSession,
    });
    try {
      const port = await listening.promise;
      await runSharedBroker({
        installationKey,
        onListening() {
          throw new Error("A second broker replaced its owner");
        },
        connectSession: unexpectedSession,
      });
      const socket = createConnection({ host: brokerHost, port });
      try {
        await once(socket, "connect");
      } finally {
        socket.destroy();
      }
    } finally {
      stopped.abort();
      await broker;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "endpoint retirement after open is missing but a live hard link is unsafe",
  async () => {
    const directory = await brokerDirectory(randomUUID());
    const target = path.join(directory, "endpoint.json");
    const linked = path.join(directory, "linked.json");
    await publishEndpoint(directory, createEndpoint(12345));
    const sample = await fs.open(target, "r");
    const prototype: { stat(): Promise<Stats> } = Object.getPrototypeOf(sample);
    const stat = prototype.stat;
    await sample.close();

    const unlinkBeforeStat = spyOn(prototype, "stat").mockImplementationOnce(
      async function (this: typeof sample) {
        await removeEndpoint(directory);
        return stat.call(this);
      },
    );
    try {
      expect(await readEndpoint(directory)).toBeUndefined();
      expect(unlinkBeforeStat).toHaveBeenCalledTimes(1);
    } finally {
      unlinkBeforeStat.mockRestore();
    }

    const endpoint = createEndpoint(12345);
    await publishEndpoint(directory, { ...endpoint, port: 65_536 });
    await expect(readEndpoint(directory)).rejects.toThrow(
      "metadata is invalid",
    );

    await publishEndpoint(directory, endpoint);
    await fs.chmod(target, 0o644);
    try {
      await expect(readEndpoint(directory)).rejects.toThrow(
        "metadata is unsafe",
      );
    } finally {
      await fs.chmod(target, 0o600);
    }
    await fs.link(target, linked);
    try {
      await expect(readEndpoint(directory)).rejects.toThrow(
        "metadata is unsafe",
      );
    } finally {
      await fs.unlink(linked);
      await removeEndpoint(directory);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "broker ownership rejects a hard-linked coordination file",
  async () => {
    const directory = await brokerDirectory(randomUUID());
    const fixture = path.join(directory, "unrelated.sqlite");
    const guard = path.join(directory, "owner.sqlite");
    const content = "unrelated contents";
    try {
      await fs.writeFile(fixture, content, { flag: "wx", mode: 0o600 });
      await fs.link(fixture, guard);
      await expect(tryBrokerGate(directory, "owner")).rejects.toThrow(
        "Shared MCP broker coordination file is unsafe",
      );
      expect(await fs.readFile(fixture, "utf8")).toBe(content);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "broker discovery rejects an existing non-private installation directory",
  async () => {
    const installationKey = randomUUID();
    const directory = await brokerDirectory(installationKey);
    try {
      await fs.chmod(directory, 0o755);
      await expect(brokerDirectory(installationKey)).rejects.toThrow(
        "Shared MCP broker directory is not private",
      );
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o755);
    } finally {
      await fs.rmdir(directory);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "the bridge reconnects only after a pre-MCP disconnect retires an endpoint",
  async () => {
    const installationKey = randomUUID();
    const directory = await brokerDirectory(installationKey);
    const client = streams();
    const staleConnection = Promise.withResolvers<Socket>();
    const stale = createServer(staleConnection.resolve);
    const stopped = new AbortController();
    const requests: unknown[] = [];
    let bridge: Promise<void> | undefined;
    let broker: Promise<void> | undefined;
    let socket: Socket | undefined;
    try {
      stale.listen(0, brokerHost);
      await once(stale, "listening");
      const address = stale.address();
      if (!address || typeof address === "string")
        throw new Error("No stale endpoint port");
      await publishEndpoint(directory, createEndpoint(address.port));
      bridge = runStdioBridge({
        daemonCommand: [],
        installationKey,
        launch: { cwd: process.cwd() },
        stdin: client.stdin,
        stdout: client.stdout,
      });
      void bridge.catch(() => {});

      const request = { id: 1, jsonrpc: "2.0", method: "ping" };
      client.stdin.write(JSON.stringify(request) + "\n");
      socket = await Promise.race([
        staleConnection.promise,
        bridge.then(() => {
          throw new Error("Bridge exited before the first connection");
        }),
      ]);
      socket.end();

      const listening = Promise.withResolvers<number>();
      broker = runSharedBroker({
        installationKey,
        signal: stopped.signal,
        onListening: listening.resolve,
        async connectSession(transport) {
          transport.onmessage = (message) => {
            requests.push(message);
            if ("id" in message && message.id !== undefined)
              void transport.send({
                id: message.id,
                jsonrpc: "2.0",
                result: {},
              });
          };
          await transport.start();
          return transport;
        },
      });
      await Promise.race([
        listening.promise,
        bridge.then(() => {
          throw new Error(
            "Bridge exited instead of waiting for endpoint retirement",
          );
        }),
      ]);
      const response = await Promise.race([
        client.read(),
        bridge.then(() => {
          throw new Error("Bridge exited before relaying the buffered request");
        }),
      ]);
      expect(response.id).toBe(1);
      expect(requests).toEqual([request]);
      client.stdin.end();
      await bridge;
    } finally {
      client.close();
      socket?.destroy();
      if (stale.listening) stale.close();
      stopped.abort();
      await Promise.allSettled([bridge, broker]);
      await removeEndpoint(directory);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "the bridge does not reconnect when a live endpoint rejects authentication",
  async () => {
    const installationKey = randomUUID();
    const directory = await brokerDirectory(installationKey);
    const stopped = new AbortController();
    const listening = Promise.withResolvers<number>();
    const broker = runSharedBroker({
      installationKey,
      signal: stopped.signal,
      onListening: listening.resolve,
      connectSession(): never {
        throw new Error("Unauthenticated client attached");
      },
    });
    const client = streams();
    try {
      const port = await listening.promise;
      await publishEndpoint(directory, createEndpoint(port));
      await expect(
        runStdioBridge({
          daemonCommand: [],
          installationKey,
          launch: { cwd: process.cwd() },
          stdin: client.stdin,
          stdout: client.stdout,
        }),
      ).rejects.toThrow("Invalid shared MCP broker handshake");
    } finally {
      client.close();
      stopped.abort();
      await broker;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "one cold daemon serves concurrent bridges and exits after the last EOF",
  async () => {
    const installationKey = randomUUID();
    const directory = await brokerDirectory(installationKey);
    const clientA = streams();
    const clientB = streams();
    const command = [process.execPath, peerPath, installationKey];
    const launch = Bun.spawn;
    const owned: ManagedSubprocess[] = [];
    const spawning = spyOn(Bun, "spawn").mockImplementation(((
      argv: string[],
      options: Bun.SpawnOptions.OptionsObject<"ignore", "ignore", "ignore">,
    ) => {
      const child = launch(argv, options);
      if (argv[1] === peerPath && argv[2] === installationKey)
        owned.push(child);
      return child;
    }) as typeof Bun.spawn);
    const bridgeA = openTestBridge(installationKey, clientA, command);
    const bridgeB = openTestBridge(installationKey, clientB, command);
    try {
      const reply = (client: typeof clientA, bridge: Promise<void>) => {
        client.stdin.write(JSON.stringify(ping) + "\n");
        return Promise.race([
          client.read(),
          bridge.then(() => {
            throw new Error("Cold broker disconnected");
          }),
        ]);
      };
      const [replyA, replyB] = await Promise.all([
        reply(clientA, bridgeA),
        reply(clientB, bridgeB),
      ]);
      const endpoint = await readEndpoint(directory);
      const owner = owned[0];
      expect(owned).toHaveLength(1);
      if (!owner) throw new Error("Cold bridge did not start a broker");
      expect(endpoint?.pid).toBe(owner.pid);
      expect(replyA.result).toEqual({ pid: owner.pid });
      expect(replyB.result).toEqual({ pid: owner.pid });
      clientA.stdin.end();
      await bridgeA;
      expect((await readEndpoint(directory))?.pid).toBe(owner.pid);
      clientB.stdin.end();
      await bridgeB;
      await assertLeft(directory);
      const deadline = AbortSignal.timeout(5_000);
      const failed = Promise.withResolvers<never>();
      const expire = () => failed.reject(new Error("Cold broker did not exit"));
      deadline.addEventListener("abort", expire, { once: true });
      try {
        expect(await Promise.race([owner.exited, failed.promise])).toBe(0);
      } finally {
        deadline.removeEventListener("abort", expire);
      }
    } finally {
      clientA.close();
      clientB.close();
      await Promise.allSettled([bridgeA, bridgeB]);
      spawning.mockRestore();
      for (const child of owned) await terminateProcessTree(child);
      await assertLeft(directory);
    }
  },
);

async function startStandalonePeer(
  installationKey: string,
  mode: "backpressure" | "watchdog",
) {
  const child = Bun.spawn([process.execPath, peerPath, installationKey, mode], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    const ready = child.stdout.getReader();
    try {
      const { done } = await ready.read();
      if (done) throw new Error("Standalone broker exited before listening");
    } finally {
      ready.releaseLock();
    }
    const directory = await brokerDirectory(installationKey);
    const endpoint = await readEndpoint(directory);
    if (!endpoint) throw new Error("Standalone broker did not publish");
    return { child, directory, endpoint };
  } catch (error) {
    await terminateProcessTree(child);
    throw error;
  }
}

test("the standalone retire watchdog exits only after the remaining budget", async () => {
  const clock = createMockTime();
  const exits: number[] = [];
  const lifetime = standaloneBrokerLifetime({
    once() {},
    exit(code) {
      exits.push(code);
    },
  });
  try {
    lifetime.retire(undefined, 50);
    await clock.advanceBy(49);
    expect(exits).toEqual([]);
    await clock.advanceBy(1);
    expect(exits).toEqual([1]);
    expect(clock.pending()).toBe(0);
  } finally {
    clock.dispose();
  }
});

test.skipIf(process.platform === "win32")(
  "an unfinished broker drain reports failure and keeps standalone ownership",
  async () => {
    const installationKey = randomUUID();
    const stopped = new AbortController();
    const entered = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    let exitListener: (() => void) | undefined;
    const exitCodes: number[] = [];
    const broker = runSharedBroker({
      installationKey,
      signal: stopped.signal,
      lifetime: standaloneBrokerLifetime({
        once(_event, listener) {
          exitListener = listener;
        },
        exit(code) {
          exitCodes.push(Number(code));
          throw new Error("Observed standalone exit");
        },
      }),
      onListening: () => entered.resolve(),
      connectSession() {
        throw new Error("Unexpected session");
      },
      closeProjectRuntimes: () => cleanup.promise,
    });
    void broker.catch(() => {});
    const directory = await brokerDirectory(installationKey);
    try {
      await entered.promise;
      stopped.abort();
      await expect(broker).rejects.toThrow("Observed standalone exit");
      expect(exitCodes).toEqual([1]);
      expect(await readEndpoint(directory)).toBeUndefined();
      expect(await tryBrokerGate(directory, "owner")).toBeUndefined();
    } finally {
      stopped.abort();
      cleanup.resolve();
      await Promise.allSettled([broker]);
      exitListener?.();
    }
  },
  10_000,
);

test.skipIf(process.platform === "win32")(
  "the standalone broker flushes a backpressured final reply before exit",
  async () => {
    const { child, directory, endpoint } = await startStandalonePeer(
      randomUUID(),
      "backpressure",
    );
    const socket = createConnection({ host: brokerHost, port: endpoint.port });
    try {
      await connectBrokerSession(
        socket,
        { cwd: process.cwd() },
        endpoint.secret,
        AbortSignal.timeout(2_000),
      );
      socket.pause();
      socket.end(JSON.stringify(ping) + "\n");
      await assertLeft(directory);

      const data: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => data.push(chunk));
      const finished = once(socket, "end");
      socket.resume();
      await finished;
      expect(Buffer.concat(data).toString()).toBe(
        JSON.stringify({
          id: ping.id,
          jsonrpc: "2.0",
          result: { tail: "x".repeat(4 * 1024 * 1024) },
        }) + "\n",
      );
      expect(await child.exited).toBe(0);
    } finally {
      socket.destroy();
      await terminateProcessTree(child);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "the standalone watchdog terminates referenced work after retiring the endpoint",
  async () => {
    const identity = randomUUID();
    const { child, directory } = await startStandalonePeer(
      identity,
      "watchdog",
    );
    const client = streams();
    const bridge = openTestBridge(identity, client);
    try {
      client.stdin.write(JSON.stringify(ping) + "\n");
      expect((await client.read()).result).toEqual({ pid: child.pid });
      client.stdin.end();
      await assertLeft(directory);
      expect(await tryBrokerGate(directory, "owner")).toBeUndefined();
      expect(await child.exited).toBe(1);
      await bridge;
      const release = await tryBrokerGate(directory, "owner");
      expect(release).toBeFunction();
      release?.();
    } finally {
      client.close();
      await terminateProcessTree(child);
      await Promise.allSettled([bridge]);
    }
  },
  10_000,
);

test.skipIf(process.platform === "win32")(
  "last EOF retires the endpoint, drains sessions, and joins background work before closing projects",
  async () => {
    const installationKey = randomUUID();
    const directory = await brokerDirectory(installationKey);
    const listening = Promise.withResolvers<number>();
    const closing = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const joining = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    let projectsClosed = false;
    const stopped = new AbortController();
    const client = streams();
    const broker = runSharedBroker({
      installationKey,
      onListening: listening.resolve,
      signal: stopped.signal,
      stopBackgroundWork() {
        joining.resolve();
        return joined.promise;
      },
      async closeProjectRuntimes() {
        projectsClosed = true;
      },
      async connectSession(transport) {
        transport.onmessage = () => {
          void transport.send({ jsonrpc: "2.0", id: 1, result: {} });
        };
        await transport.start();
        return {
          async close() {
            closing.resolve();
            await cleanup.promise;
          },
        };
      },
    });
    let bridge: Promise<void> | undefined;
    let acknowledged = false;
    try {
      await listening.promise;
      bridge = openTestBridge(installationKey, client);
      void bridge.then(() => {
        acknowledged = true;
      });
      client.stdin.write(JSON.stringify(ping) + "\n");
      expect((await client.read()).id).toBe(1);
      client.stdin.end();
      await closing.promise;
      await assertLeft(directory);
      expect(acknowledged).toBe(false);
      cleanup.resolve();
      await joining.promise;
      expect(projectsClosed).toBeFalse();
      expect(acknowledged).toBeFalse();
      joined.resolve();
      await bridge;
      await broker;
      expect(projectsClosed).toBeTrue();
      expect(acknowledged).toBe(true);
    } finally {
      cleanup.resolve();
      joined.resolve();
      client.close();
      stopped.abort();
      await Promise.allSettled([bridge, broker]);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "the broker still closes projects and releases ownership if background shutdown rejects",
  async () => {
    const installationKey = randomUUID();
    const directory = await brokerDirectory(installationKey);
    const listening = Promise.withResolvers<number>();
    const stopped = new AbortController();
    const closing = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const failure = new Error("Background shutdown failed");
    const broker = runSharedBroker({
      installationKey,
      onListening: listening.resolve,
      signal: stopped.signal,
      connectSession() {
        throw new Error("Unexpected session");
      },
      async stopBackgroundWork() {
        throw failure;
      },
      closeProjectRuntimes() {
        closing.resolve();
        return closed.promise;
      },
    });
    void broker.catch(() => undefined);
    try {
      await listening.promise;
      stopped.abort();
      await closing.promise;
      expect(await tryBrokerGate(directory, "owner")).toBeUndefined();
      closed.resolve();
      await expect(broker).rejects.toBe(failure);
      expect(await readEndpoint(directory)).toBeUndefined();
      const release = await tryBrokerGate(directory, "owner");
      try {
        expect(release).toBeFunction();
      } finally {
        release?.();
      }
    } finally {
      stopped.abort();
      closed.resolve();
      await Promise.allSettled([broker]);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "the bridge leaves a live owner alone when its endpoint is unavailable",
  async () => {
    const installationKey = randomUUID();
    const directory = await brokerDirectory(installationKey);
    const owner = await tryBrokerGate(directory, "owner");
    if (!owner) throw new Error("Could not acquire test owner");
    const client = streams();
    let bridge: Promise<void> | undefined;
    const watcher = watch(directory, { signal: AbortSignal.timeout(5_000) });
    try {
      // A stale endpoint on a closed port forces the bridge's refusal path.
      const stale = createServer();
      stale.listen(0, brokerHost);
      await once(stale, "listening");
      const address = stale.address();
      if (!address || typeof address === "string")
        throw new Error("No test listener address");
      await new Promise<void>((resolve, reject) =>
        stale.close((error) => (error ? reject(error) : resolve())),
      );
      await publishEndpoint(directory, createEndpoint(address.port));
      const changes = watcher[Symbol.asyncIterator]();
      let nextChange = changes.next();
      bridge = openTestBridge(installationKey, client);
      // The startup SQLite gate is created only after the stale port is refused.
      while (true) {
        const change = await nextChange;
        if (change.done) throw new Error("No startup gate observation");
        if (change.value.filename === "startup.sqlite") break;
        nextChange = changes.next();
      }
      client.stdin.destroy();
      await bridge;
      expect(await readEndpoint(directory)).toMatchObject({
        port: address.port,
      });
    } finally {
      await watcher.return?.();
      client.close();
      owner();
      await bridge;
      await removeEndpoint(directory);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a failed daemon launch reports the spawn error and releases startup ownership",
  async () => {
    const installationKey = randomUUID();
    const directory = await brokerDirectory(installationKey);
    const client = streams();
    try {
      await expect(
        openTestBridge(installationKey, client, [
          directory + "/missing-broker",
        ]),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const release = await tryBrokerGate(directory, "startup");
      expect(release).toBeFunction();
      release?.();
    } finally {
      client.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "an unchanged listener that terminates handshakes is not retried",
  async () => {
    const installationKey = randomUUID();
    const directory = await brokerDirectory(installationKey);
    const client = streams();
    let connections = 0;
    const peer = createServer((socket) => {
      ++connections;
      socket.end();
    });
    try {
      peer.listen(0, brokerHost);
      await once(peer, "listening");
      const address = peer.address();
      if (!address || typeof address === "string")
        throw new Error("No test listener address");
      await publishEndpoint(directory, createEndpoint(address.port));
      await expect(openTestBridge(installationKey, client)).rejects.toThrow(
        "closed during handshake",
      );
      expect(connections).toBe(1);
    } finally {
      client.close();
      peer.close();
      await removeEndpoint(directory);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "the broker rejects oversized and malformed peer frames and ignores unauthenticated launch",
  async () => {
    const installationKey = randomUUID();
    const stopped = new AbortController();
    const listening = Promise.withResolvers<number>();
    let established = false;
    const broker = runSharedBroker({
      installationKey,
      signal: stopped.signal,
      onListening: listening.resolve,
      connectSession(): never {
        established = true;
        throw new Error("Invalid client reached MCP session setup");
      },
    });
    try {
      const port = await listening.promise;
      const invalidPackets = [
        { nonce: Buffer.from([0, 1, 0, 0]) },
        { nonce: peerFrame("bad nonce") },
        {
          nonce: peerFrame("f".repeat(64)),
          launch: [process.cwd(), "f".repeat(64)],
        },
        {
          nonce: peerFrame("0".repeat(64)),
          launch: ["relative", "0".repeat(64)],
        },
      ];
      for (const invalid of invalidPackets) {
        const socket = createConnection({ host: brokerHost, port });
        try {
          await readFrame(socket);
          socket.write(invalid.nonce);
          if (invalid.launch) {
            expect(typeof (await readFrame(socket))).toBe("string");
            socket.write(peerFrame(invalid.launch));
          }
          const closed = once(socket, "close");
          socket.resume();
          await closed;
        } finally {
          socket.destroy();
        }
      }
      expect(established).toBeFalse();
    } finally {
      stopped.abort();
      await broker;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "broker shutdown during session setup closes late resources without admitting MCP",
  async () => {
    const installationKey = randomUUID();
    const stopped = new AbortController();
    const listening = Promise.withResolvers<number>();
    const attaching = Promise.withResolvers<void>();
    const attached = Promise.withResolvers<{ close(): Promise<void> }>();
    const lateClosed = Promise.withResolvers<void>();
    const broker = runSharedBroker({
      installationKey,
      signal: stopped.signal,
      onListening: listening.resolve,
      connectSession() {
        attaching.resolve();
        return attached.promise;
      },
    });
    const client = streams();
    const directory = await brokerDirectory(installationKey);
    let bridge: Promise<void> | undefined;
    try {
      await listening.promise;
      bridge = openTestBridge(installationKey, client);
      await attaching.promise;
      stopped.abort();
      await broker;
      attached.resolve({
        async close() {
          lateClosed.resolve();
        },
      });
      await lateClosed.promise;
      expect(await readEndpoint(directory)).toBeUndefined();
    } finally {
      attached.resolve({ async close() {} });
      client.close();
      stopped.abort();
      await Promise.allSettled([bridge, broker]);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a client can cancel a handshake with a silent peer",
  async () => {
    const connected = Promise.withResolvers<Socket>();
    const peer = createServer(connected.resolve);
    peer.listen(0, brokerHost);
    await once(peer, "listening");
    const address = peer.address();
    if (!address || typeof address === "string")
      throw new Error("No paused peer address");
    const socket = createConnection({ host: brokerHost, port: address.port });
    const canceled = new AbortController();
    const connecting = connectBrokerSession(
      socket,
      { cwd: process.cwd() },
      "0".repeat(64),
      canceled.signal,
    );
    void connecting.catch(() => undefined);
    let peerSocket: Socket | undefined;
    try {
      peerSocket = await connected.promise;
      canceled.abort(new Error("Client canceled handshake"));
      await expect(connecting).rejects.toThrow("Client canceled handshake");
    } finally {
      socket.destroy();
      peerSocket?.destroy();
      peer.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "an output close disconnects only that bridge while another session is active",
  async () => {
    const installationKey = randomUUID();
    const stopped = new AbortController();
    const listening = Promise.withResolvers<number>();
    const broker = runSharedBroker({
      installationKey,
      signal: stopped.signal,
      onListening: listening.resolve,
      async connectSession(transport) {
        transport.onmessage = (message) => {
          if ("id" in message && message.id !== undefined)
            void transport.send({
              id: message.id,
              jsonrpc: "2.0",
              result: {},
            });
        };
        await transport.start();
        return transport;
      },
    });
    const first = streams();
    const second = streams();
    let bridge: Promise<void> | undefined;
    let survivor: Promise<void> | undefined;
    try {
      await listening.promise;
      bridge = openTestBridge(installationKey, first);
      first.stdin.write(JSON.stringify(ping) + "\n");
      expect((await first.read()).id).toBe(1);
      survivor = openTestBridge(installationKey, second);
      second.stdin.write(JSON.stringify(ping) + "\n");
      expect((await second.read()).id).toBe(1);

      first.stdout.destroy();
      await bridge;
      second.stdin.write(JSON.stringify({ ...ping, id: 2 }) + "\n");
      expect((await second.read()).id).toBe(2);
      second.stdin.end();
      await survivor;
    } finally {
      first.close();
      second.close();
      stopped.abort();
      await Promise.allSettled([bridge, survivor, broker]);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a listener bind failure reports the OS error and releases broker ownership",
  async () => {
    const installationKey = randomUUID();
    const directory = await brokerDirectory(installationKey);
    const addressError = Object.assign(new Error("Loopback bind unavailable"), {
      code: "EADDRNOTAVAIL",
    });
    const original = Server.prototype.listen;
    const listener = spyOn(Server.prototype, "listen");
    listener.mockImplementation(function (
      this: Server,
      ...args: Parameters<typeof original>
    ) {
      listener.mockRestore();
      queueMicrotask(() => this.emit("error", addressError));
      return this;
    } as typeof original);
    try {
      await expect(
        runSharedBroker({
          installationKey,
          connectSession(): never {
            throw new Error("Unavailable listener attached a client");
          },
        }),
      ).rejects.toBe(addressError);
    } finally {
      listener.mockRestore();
    }
    expect(await readEndpoint(directory)).toBeUndefined();
    const release = await tryBrokerGate(directory, "owner");
    expect(release).toBeFunction();
    release?.();
  },
);

test.skipIf(process.platform === "win32")(
  "a failed authenticated setup does not stop other broker sessions",
  async () => {
    const installationKey = randomUUID();
    const stopped = new AbortController();
    const listening = Promise.withResolvers<number>();
    let attempts = 0;
    const broker = runSharedBroker({
      installationKey,
      signal: stopped.signal,

      onListening: listening.resolve,
      async connectSession(transport) {
        if (++attempts === 1) throw new Error("Session initialization failed");
        transport.onmessage = (message) => {
          if ("id" in message && message.id !== undefined)
            void transport.send({
              id: message.id,
              jsonrpc: "2.0",
              result: {},
            });
        };
        await transport.start();
        return transport;
      },
    });
    const first = streams();
    const second = streams();
    let firstBridge: Promise<void> | undefined;
    let secondBridge: Promise<void> | undefined;
    try {
      const port = await listening.promise;
      const endpoint = await readEndpoint(
        await brokerDirectory(installationKey),
      );
      if (!endpoint) throw new Error("Missing broker endpoint");
      const socket = createConnection({ host: brokerHost, port });
      try {
        await expect(
          connectBrokerSession(
            socket,
            { cwd: process.cwd() },
            endpoint.secret,
            AbortSignal.timeout(5_000),
          ),
        ).rejects.toThrow("closed during handshake");
      } finally {
        socket.destroy();
      }
      firstBridge = openTestBridge(installationKey, first);
      secondBridge = openTestBridge(installationKey, second);
      first.stdin.write(JSON.stringify(ping) + "\n");
      second.stdin.write(JSON.stringify(ping) + "\n");
      expect((await first.read()).id).toBe(1);
      expect((await second.read()).id).toBe(1);
      expect(attempts).toBe(3);
      first.stdin.end();
      second.stdin.end();
      await Promise.all([firstBridge, secondBridge]);
    } finally {
      first.close();
      second.close();
      stopped.abort();
      await Promise.allSettled([firstBridge, secondBridge, broker]);
    }
  },
);

import { expect, spyOn, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";

import { McpServer } from "@modelcontextprotocol/server";

import {
  installProcessFailureHandlers,
  type FailureHost,
} from "../src/runtime/signals";
import { createServer } from "../src/server";
import { createProcessServer } from "../src/server/lifecycle";
import { BatchingStdioServerTransport } from "../src/server/stdio";

function failureHost() {
  const listeners = new Map<string, (error: unknown) => void>();
  const exits: number[] = [];
  const messages: string[] = [];
  const host: FailureHost = {
    exit: (code) => {
      exits.push(code);
    },
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    off: (event) => {
      listeners.delete(event);
    },
    stderr: {
      write: (message) => {
        messages.push(message);
      },
    },
  };
  return { host, listeners, exits, messages };
}

test("a second fatal event exits once while cleanup is pending", async () => {
  const { host, listeners, exits, messages } = failureHost();
  let finish!: () => void;
  let cleanups = 0;
  const dispose = installProcessFailureHandlers(() => {
    cleanups += 1;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  }, host);
  try {
    listeners.get("uncaughtException")!(new Error("first failure"));
    listeners.get("unhandledRejection")!("second failure");
    expect(host.exitCode).toBe(1);
    expect(exits).toEqual([1]);
    expect(cleanups).toBe(1);
    expect(messages.join("")).toContain("second failure");
    finish();
    await Bun.sleep(0);
    expect(exits).toEqual([1]);
  } finally {
    dispose();
  }
});

for (const failure of [
  new Error("cleanup rejection"),
  "cleanup rejection",
] as const) {
  test(`fatal cleanup reports ${typeof failure === "string" ? "non-Error rejection" : "synchronous exception"} and retains nonzero exit`, async () => {
    const { host, listeners, exits, messages } = failureHost();
    const dispose = installProcessFailureHandlers(() => {
      if (failure instanceof Error) throw failure;
      return Promise.reject(failure);
    }, host);
    try {
      listeners.get("unhandledRejection")!("fatal payload");
      await Bun.sleep(0);
      expect(exits).toEqual([1]);
      expect(host.exitCode).toBe(1);
      expect(messages.join("")).toContain(
        "fatal cleanup failed: cleanup rejection",
      );
    } finally {
      dispose();
    }
  });
}

test("connection-close cleanup failures remain observable and set failure status", async () => {
  const previousExitCode = process.exitCode;
  const close = spyOn(McpServer.prototype, "close").mockRejectedValue(
    new Error("transport close failed"),
  );
  const diagnostics = spyOn(process.stderr, "write");
  let server: ReturnType<typeof createServer> | undefined;
  try {
    server = createServer();
    server.server.onclose!();
    await Bun.sleep(0);
    await expect(server.close()).rejects.toThrow("transport close failed");
    expect(process.exitCode).toBe(1);
    expect(diagnostics).toHaveBeenCalledWith(
      "ast-mcp connection cleanup failed: transport close failed\n",
    );
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await server?.close().catch(() => undefined);
    close.mockRestore();
    diagnostics.mockRestore();
    process.exitCode = previousExitCode ?? 0;
  }
});

test("process connection shutdown enforces its five-second failure deadline", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const close = spyOn(McpServer.prototype, "close").mockReturnValue(gate);
  const exit = spyOn(process, "exit").mockImplementation(
    (() => undefined) as never,
  );
  const diagnostics = spyOn(process.stderr, "write");
  const setTimeoutOriginal = globalThis.setTimeout;
  let deadline: (() => void) | undefined;
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 5_000) deadline = () => callback(...args);
    return setTimeoutOriginal(callback, delay, ...args);
  }) as typeof setTimeout);
  const server = createProcessServer();
  let closing: Promise<void> | undefined;
  try {
    closing = server.close();
    await Bun.sleep(0);
    expect(deadline).toBeDefined();
    deadline!();
    expect(exit).toHaveBeenCalledWith(1);
    expect(diagnostics).toHaveBeenCalledWith(
      "ast-mcp connection shutdown timed out\n",
    );
    release();
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await closing;
    close.mockRestore();
    exit.mockRestore();
    diagnostics.mockRestore();
    timers.mockRestore();
  }
});

test("failed protocol replies report the output failure and close transport", async () => {
  const stdin = new PassThrough();
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("protocol broken pipe"));
    },
  });
  const transport = new BatchingStdioServerTransport(stdin, stdout);
  const errors: Error[] = [];
  let closes = 0;
  transport.onerror = (error) => errors.push(error);
  transport.onclose = () => {
    closes += 1;
  };
  await transport.start();
  stdin.write("not-json\n");
  await Bun.sleep(0);
  expect(
    errors.some((error) => error.message.includes("protocol broken pipe")),
  ).toBe(true);
  expect(errors.length).toBeGreaterThanOrEqual(2);
  expect(closes).toBe(1);
  await expect(
    transport.send({ id: 1, jsonrpc: "2.0", result: {} } as never),
  ).rejects.toThrow("Stdio transport is closed");
  await transport.close();
});

test("stdout closure settles a backpressured write and closes transport once", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough({ highWaterMark: 1 });
  const transport = new BatchingStdioServerTransport(stdin, stdout);
  let closes = 0;
  transport.onclose = () => {
    closes += 1;
  };
  await transport.start();
  const result = transport
    .send({ id: 1, jsonrpc: "2.0", result: {} } as never)
    .catch((error: Error) => error);
  stdout.emit("close");
  expect(await result).toMatchObject({ message: "Stdio transport is closed" });
  expect(closes).toBe(1);
  expect(stdout.listenerCount("drain")).toBe(0);
  await transport.close();
  expect(closes).toBe(1);
});

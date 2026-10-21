import { expect, test } from "bun:test";

import {
  installProcessFailureHandlers,
  installProcessSignalHandlers,
  PROCESS_SIGNALS,
  type ProcessSignal,
  processSignals,
  type SignalHost,
} from "../../src/runtime/signals";

class FakeSignalHost implements SignalHost {
  readonly exits: number[] = [];
  readonly listeners = new Map<ProcessSignal, Set<() => void>>();
  readonly messages: string[] = [];
  readonly stderr = {
    write: (message: string) => {
      this.messages.push(message);
    },
  };

  exit(code: number) {
    this.exits.push(code);
  }

  off(signal: ProcessSignal, listener: () => void) {
    this.listeners.get(signal)?.delete(listener);
  }

  on(signal: ProcessSignal, listener: () => void) {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  trigger(signal: ProcessSignal) {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

test("installs and disposes all process signal listeners", async () => {
  const host = new FakeSignalHost();
  const received: ProcessSignal[] = [];
  const dispose = installProcessSignalHandlers((signal) => {
    received.push(signal);
  }, host);

  expect([...host.listeners.keys()]).toEqual([...PROCESS_SIGNALS]);
  const signal = PROCESS_SIGNALS[0] as ProcessSignal;
  host.trigger(signal);
  await flushPromises();
  expect(received).toEqual([signal]);
  expect(host.exits).toEqual([0]);

  dispose();
  expect(
    [...host.listeners.values()].every((listeners) => listeners.size === 0),
  ).toBeTrue();
});

test("reports failed cleanup and exits unsuccessfully", async () => {
  const host = new FakeSignalHost();
  installProcessSignalHandlers(() => {
    throw new Error("cleanup failed");
  }, host);

  const signal = PROCESS_SIGNALS.at(-1) as ProcessSignal;
  host.trigger(signal);
  await flushPromises();

  expect(host.messages).toEqual([
    `ast-mcp shutdown failed after ${signal}: cleanup failed\n`,
  ]);
  expect(host.exits).toEqual([1]);
});

test("a repeated signal forces exit while cleanup is pending", () => {
  const host = new FakeSignalHost();
  installProcessSignalHandlers(() => new Promise(() => undefined), host);

  host.trigger(PROCESS_SIGNALS[0] as ProcessSignal);
  host.trigger(PROCESS_SIGNALS[1] as ProcessSignal);

  expect(host.exits).toEqual([1]);
});

test("selects signals supported by each operating system", () => {
  expect(processSignals("win32")).toEqual(["SIGINT", "SIGBREAK"]);
  expect(processSignals("linux")).toEqual(["SIGTERM", "SIGINT", "SIGHUP"]);
});

test("signal cleanup has a bounded deadline", async () => {
  const host = new FakeSignalHost();
  const dispose = installProcessSignalHandlers(
    () => new Promise(() => {}),
    host,
    10,
  );
  host.trigger(PROCESS_SIGNALS[0] as ProcessSignal);
  await Bun.sleep(30);
  expect(host.exits).toEqual([1]);
  expect(host.messages[0]).toContain("timed out");
  dispose();
});

test("fatal exceptions clean up once and exit unsuccessfully", async () => {
  const listeners = new Map<string, (error: unknown) => void>();
  const exits: number[] = [];
  const messages: string[] = [];
  let cleanups = 0;
  const host = {
    exit: (code: number) => {
      exits.push(code);
    },
    off: (event: string) => {
      listeners.delete(event);
    },
    on: (event: string, listener: (error: unknown) => void) => {
      listeners.set(event, listener);
    },
    stderr: {
      write: (message: string) => {
        messages.push(message);
      },
    },
  };
  const dispose = installProcessFailureHandlers(() => {
    cleanups += 1;
  }, host);
  listeners.get("uncaughtException")?.(new Error("fatal test"));
  await flushPromises();
  expect(cleanups).toBe(1);
  expect(exits).toEqual([1]);
  expect(messages[0]).toContain("fatal test");
  dispose();
  expect(listeners.size).toBe(0);
});

test("fatal cleanup cannot hang indefinitely", async () => {
  const listeners = new Map<string, (error: unknown) => void>();
  const exits: number[] = [];
  const host = {
    exit: (code: number) => {
      exits.push(code);
    },
    off: (event: string) => {
      listeners.delete(event);
    },
    on: (event: string, listener: (error: unknown) => void) => {
      listeners.set(event, listener);
    },
    stderr: { write: () => {} },
  };
  const dispose = installProcessFailureHandlers(
    () => new Promise(() => {}),
    host,
    10,
  );
  listeners.get("unhandledRejection")?.(new Error("fatal rejection"));
  await Bun.sleep(30);
  expect(exits).toEqual([1]);
  dispose();
});

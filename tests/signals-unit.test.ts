import { expect, test } from "bun:test";

import {
  installProcessSignalHandlers,
  PROCESS_SIGNALS,
  type ProcessSignal,
  type SignalHost,
} from "../src/runtime/signals";

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
  host.trigger("SIGTERM");
  await flushPromises();
  expect(received).toEqual(["SIGTERM"]);
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

  host.trigger("SIGHUP");
  await flushPromises();

  expect(host.messages).toEqual([
    "ast-mcp shutdown failed after SIGHUP: cleanup failed\n",
  ]);
  expect(host.exits).toEqual([1]);
});

test("a repeated signal forces exit while cleanup is pending", () => {
  const host = new FakeSignalHost();
  installProcessSignalHandlers(() => new Promise(() => undefined), host);

  host.trigger("SIGINT");
  host.trigger("SIGTERM");

  expect(host.exits).toEqual([1]);
});

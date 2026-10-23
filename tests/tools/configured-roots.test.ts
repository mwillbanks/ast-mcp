import { expect, test } from "bun:test";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import {
  configuredExecution,
  localExecution,
} from "../../src/tools/configured";

type Roots = { roots: Array<{ uri: string }> };

function executor(
  listRoots: (...args: unknown[]) => Promise<Roots>,
  timeoutMs = 25,
) {
  const server = {
    server: {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots,
      setNotificationHandler: () => {},
    },
  } as unknown as McpServer;
  return configuredExecution(server, undefined, {
    clientRootsTimeoutMs: timeoutMs,
  });
}

function context(signal: AbortSignal): ServerContext {
  return { mcpReq: { signal } } as ServerContext;
}

test("client roots timeout fails closed and allows the next request to recover", async () => {
  let calls = 0;
  let rootsSignal: AbortSignal | undefined;
  const execute = executor(async (...args) => {
    calls += 1;
    rootsSignal = (args[1] as { signal: AbortSignal }).signal;
    if (calls === 1) return new Promise<Roots>(() => {});
    return { roots: [{ uri: "file:///recovered" }] };
  });
  let dispatched = false;
  await expect(
    execute({}, async () => {
      dispatched = true;
    }),
  ).rejects.toMatchObject({ code: "timeout", retryable: true });
  expect(dispatched).toBe(false);
  expect(rootsSignal?.aborted).toBe(true);
  expect(await execute.clientRoots!()).toEqual(["file:///recovered"]);
  expect(calls).toBe(2);
});

test("a rejected roots request does not poison the connection cache", async () => {
  let calls = 0;
  const failure = new Error("connection interrupted");
  const execute = executor(async () => {
    if (++calls === 1) throw failure;
    return { roots: [{ uri: "file:///ready" }] };
  });
  await expect(execute.clientRoots!()).rejects.toBe(failure);
  expect(await execute.clientRoots!()).toEqual(["file:///ready"]);
  expect(await execute.clientRoots!()).toEqual(["file:///ready"]);
  expect(calls).toBe(2);
});

test("concurrent roots requests share one host call", async () => {
  let calls = 0;
  let resolve!: (roots: Roots) => void;
  const pending = new Promise<Roots>((done) => {
    resolve = done;
  });
  const execute = executor(async () => {
    calls += 1;
    return pending;
  });
  const first = execute.clientRoots!();
  const second = execute.clientRoots!();
  resolve({ roots: [{ uri: "file:///shared" }] });
  expect(await Promise.all([first, second])).toEqual([
    ["file:///shared"],
    ["file:///shared"],
  ]);
  expect(calls).toBe(1);
});

test("cancelling one caller preserves the shared roots request", async () => {
  let resolve!: (roots: Roots) => void;
  let sharedSignal: AbortSignal | undefined;
  const pending = new Promise<Roots>((done) => {
    resolve = done;
  });
  const execute = executor(async (...args) => {
    sharedSignal = (args[1] as { signal: AbortSignal }).signal;
    return pending;
  }, 1000);
  const controller = new AbortController();
  const first = execute.clientRoots!(context(controller.signal));
  const second = execute.clientRoots!();
  await Promise.resolve();
  const failure = new Error("caller cancelled");
  controller.abort(failure);
  await expect(first).rejects.toBe(failure);
  expect(sharedSignal?.aborted).toBe(false);
  resolve({ roots: [{ uri: "file:///shared" }] });
  expect(await second).toEqual(["file:///shared"]);
});

test("an older roots failure does not evict refreshed roots", async () => {
  let reject!: (error: Error) => void;
  let calls = 0;
  const pending = new Promise<Roots>((_, fail) => {
    reject = fail;
  });
  const execute = executor(async () => {
    if (++calls === 1) return pending;
    return { roots: [{ uri: "file:///fresh" }] };
  }, 1000);
  const first = execute.clientRoots!();
  await Promise.resolve();
  execute.refreshRoots!();
  expect(await execute.clientRoots!()).toEqual(["file:///fresh"]);
  const failure = new Error("obsolete request failed");
  reject(failure);
  await expect(first).rejects.toBe(failure);
  expect(await execute.clientRoots!()).toEqual(["file:///fresh"]);
  expect(calls).toBe(2);
});

test("modern requests bypass legacy roots discovery", async () => {
  let called = false;
  const execute = executor(async () => {
    called = true;
    return { roots: [] };
  });
  const modern = { mcpReq: { envelope: {} } } as ServerContext;
  expect(await execute.clientRoots!(modern)).toEqual([]);
  expect(called).toBe(false);
});

test("configured and local execution forward the SDK cancellation signal", async () => {
  const controller = new AbortController();
  const legacy = new AbortController();
  const requestContext = {
    mcpReq: { signal: controller.signal },
    signal: legacy.signal,
  } as unknown as ServerContext;
  const server = {
    server: {
      getClientCapabilities: () => ({}),
      setNotificationHandler: () => {},
    },
  } as unknown as McpServer;
  for (const execute of [configuredExecution(server), localExecution]) {
    expect(await execute({}, async (signal) => signal, requestContext)).toBe(
      controller.signal,
    );
    expect(
      await execute({}, async (signal) => signal, {
        signal: legacy.signal,
      } as unknown as ServerContext),
    ).toBe(legacy.signal);
  }
});

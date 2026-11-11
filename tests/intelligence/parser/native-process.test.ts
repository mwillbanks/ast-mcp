import { expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  createNativeProcessTransport,
  isEmbeddedBunExecutable,
} from "../../../src/intelligence/parser/native-process.ts";

const bunEntry = Bun as { main: string };

const workerUrl = new URL(
  "../../../src/intelligence/parser/worker.ts",
  import.meta.url,
);

function fakeChild() {
  const completion = Promise.withResolvers<number>();
  const calls: unknown[] = [];
  const child = {
    exited: completion.promise,
    send(message: unknown) {
      calls.push(message);
    },
    kill(signal: string) {
      calls.push(signal);
      completion.resolve(137);
    },
    ref() {
      calls.push("ref");
    },
    unref() {
      calls.push("unref");
    },
  };
  const spawn = spyOn(Bun, "spawn").mockReturnValue(
    child as ReturnType<typeof Bun.spawn>,
  );
  const receive = (message: unknown) => {
    const options = spawn.mock.calls[0]?.[1] as {
      ipc?: (...args: unknown[]) => void;
    };
    const ipc = options.ipc;
    if (typeof ipc !== "function") throw new Error("IPC is not configured");
    Reflect.apply(ipc, undefined, [message]);
  };
  return { calls, completion, receive, spawn };
}

test("launches source workers with a scrubbed environment and forwards IPC and cancellation", async () => {
  const originalMain = Bun.main;
  const fixture = fakeChild();
  bunEntry.main = fileURLToPath(workerUrl);
  try {
    const transport = createNativeProcessTransport(workerUrl, "parser");
    expect(fixture.spawn.mock.calls[0]?.[0]).toEqual([
      process.execPath,
      "--no-env-file",
      fileURLToPath(workerUrl),
    ]);
    expect(fixture.spawn.mock.calls[0]?.[1]).toMatchObject({
      env:
        process.platform === "win32"
          ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
          : {},
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    });
    const propertyEvents: unknown[] = [];
    const listenerEvents: unknown[] = [];
    const errors: unknown[] = [];
    transport.onmessage = (event) => propertyEvents.push(event.data);
    transport.addEventListener("message", (event) =>
      listenerEvents.push((event as MessageEvent).data),
    );
    transport.onerror = (event) => errors.push(event.message);
    const request = { kind: "parse", source: "const value = 1;" };
    const reply = { kind: "result" };
    transport.ref();
    transport.postMessage(request);
    fixture.receive(reply);
    transport.unref();
    await transport.terminate();
    expect(fixture.calls).toEqual(["ref", request, "unref", "SIGKILL"]);
    expect(propertyEvents).toEqual([reply]);
    expect(listenerEvents).toEqual([reply]);
    expect(errors).toEqual([]);
  } finally {
    bunEntry.main = originalMain;
    fixture.spawn.mockRestore();
  }
});

test("launches the embedded worker entrypoint for native targets and reports an unexpected exit", async () => {
  const originalMain = Bun.main;
  const fixture = fakeChild();
  try {
    bunEntry.main = "C:\\~BUN\\root\\ast-mcp.ts";
    expect(isEmbeddedBunExecutable()).toBe(true);
    bunEntry.main = "/$bunfs/root/ast-mcp.ts";
    expect(isEmbeddedBunExecutable()).toBe(true);
    const transport = createNativeProcessTransport(
      workerUrl,
      "code-intelligence",
    );
    expect(fixture.spawn.mock.calls[0]?.[0]).toEqual([
      process.execPath,
      "--ast-mcp-internal-native-worker=code-intelligence",
    ]);
    const propertyErrors: string[] = [];
    const listenerErrors: string[] = [];
    transport.onerror = (event) => propertyErrors.push(event.message);
    const received = Promise.withResolvers<void>();
    transport.addEventListener("error", (event) => {
      listenerErrors.push((event as ErrorEvent).message);
      received.resolve();
    });
    fixture.completion.resolve(2);
    await received.promise;
    expect(propertyErrors).toEqual([
      "Native parser process exited with code 2",
    ]);
    expect(listenerErrors).toEqual(propertyErrors);
  } finally {
    bunEntry.main = originalMain;
    fixture.spawn.mockRestore();
  }
});

test("reports an IPC subprocess failure through the native process error event", async () => {
  const fixture = fakeChild();
  try {
    const transport = createNativeProcessTransport(workerUrl, "patch");
    const reported = Promise.withResolvers<string>();
    transport.onerror = (event) => reported.resolve(event.message);
    const failure = new Error("Process status unavailable");
    fixture.completion.reject(failure);
    expect(await reported.promise).toBe(failure.message);
  } finally {
    fixture.spawn.mockRestore();
  }
});

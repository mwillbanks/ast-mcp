import { expect, spyOn, test } from "bun:test";

import { globalTelemetryEnabled } from "../../src/config";
import { PROCESS_SIGNALS } from "../../src/runtime/signals";
import { createProcessServer } from "../../src/server/lifecycle";

for (const analyticsFails of [false, true]) {
  test(`process fatal forwards startup policy before cleanup when analytics fails=${analyticsFails}`, async () => {
    expect(await globalTelemetryEnabled()).toBe(false);
    const originalExitCode = process.exitCode;
    const previousListeners = new Set(process.listeners("uncaughtException"));
    const events: string[] = [];
    const server = createProcessServer();
    const fatal = process
      .listeners("uncaughtException")
      .find((listener) => !previousListeners.has(listener));
    expect(fatal).toBeDefined();
    const originalReport = server.telemetry.reportException.bind(
      server.telemetry,
    );
    const originalClose = server.telemetry.close.bind(server.telemetry);
    const error = new TypeError("startup failure fixture");
    const report = spyOn(
      server.telemetry,
      "reportException",
    ).mockImplementation((failure, startup) => {
      events.push("report");
      if (analyticsFails) throw new Error("analytics unavailable");
      originalReport(failure, startup);
    });
    const close = spyOn(server.telemetry, "close").mockImplementation(
      async () => {
        events.push("flush");
        await originalClose();
      },
    );
    const network = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          throw new Error("disabled telemetry must not transmit");
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    const exited = Promise.withResolvers<number>();
    const exit = spyOn(process, "exit").mockImplementation((code) => {
      exited.resolve(Number(code));
      return undefined as never;
    });
    try {
      fatal?.(error, "uncaughtException");
      expect(await exited.promise).toBe(1);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(error, true);
      expect(events).toEqual(["report", "flush"]);
      expect(network).not.toHaveBeenCalled();
      expect(process.listeners("uncaughtException")).not.toContain(fatal);
      expect(process.listenerCount("uncaughtException")).toBe(
        previousListeners.size,
      );
      await server.close();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
      report.mockRestore();
      close.mockRestore();
      network.mockRestore();
      stderr.mockRestore();
      exit.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }
  });
}

test("process server deadline exits nonzero while cleanup remains pending", async () => {
  const server = createProcessServer();
  const pending = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const close = spyOn(server.telemetry, "close").mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const originalTimeout = globalThis.setTimeout;
  let deadline: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign(
      (...args: Parameters<typeof setTimeout>) => {
        const [handler, milliseconds] = args;
        if (milliseconds === 5000) deadline = handler as () => void;
        return originalTimeout(...args);
      },
      { __promisify__: originalTimeout.__promisify__ },
    ),
  );
  const exit = spyOn(process, "exit").mockImplementation(
    () => undefined as never,
  );
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  const closing = server.close();
  try {
    await started.promise;
    expect(deadline).toBeDefined();
    deadline?.();
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalledWith(
      "ast-mcp connection shutdown timed out\n",
    );
    expect(server.close()).toBe(closing);
  } finally {
    pending.resolve();
    await closing;
    close.mockRestore();
    timer.mockRestore();
    exit.mockRestore();
    stderr.mockRestore();
  }
});

test("process server releases signal and fatal listeners after idempotent cleanup", async () => {
  const events = [
    ...PROCESS_SIGNALS,
    "uncaughtException",
    "unhandledRejection",
  ] as const;
  const counts = events.map((event) => process.listenerCount(event));
  const server = createProcessServer();
  for (const [index, event] of events.entries())
    expect(process.listenerCount(event)).toBe((counts[index] ?? 0) + 1);
  const closing = server.close();
  expect(server.close()).toBe(closing);
  await closing;
  for (const [index, event] of events.entries())
    expect(process.listenerCount(event)).toBe(counts[index] ?? 0);
});

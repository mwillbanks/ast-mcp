import { expect, spyOn, test } from "bun:test";
import os from "node:os";

import {
  createServicePlan,
  runServiceCommand,
  waitForService,
} from "../../src/installer/service";
import * as subprocess from "../../src/runtime/subprocess";

test("rejects unsupported service platforms before executing commands", () => {
  expect(() =>
    createServicePlan({
      cliEntry: process.execPath,
      endpoint: {
        host: "127.0.0.1",
        port: 3768,
        url: "http://127.0.0.1:3768/mcp",
      },
      home: os.tmpdir(),
      root: os.tmpdir(),
      platform: "freebsd",
      scope: "local",
    }),
  ).toThrow("not supported on freebsd");
});

test.skipIf(process.platform === "win32")(
  "reports service commands terminated by a signal",
  async () => {
    await expect(
      runServiceCommand(
        [process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")'],
        true,
      ),
    ).rejects.toThrow("SIGTERM");
  },
);

test("bounds readiness probes when a server never sends response headers", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  try {
    const started = Date.now();
    await expect(
      waitForService(new URL("/mcp", server.url).toString(), 100),
    ).rejects.toThrow("did not become ready");
    expect(Date.now() - started).toBeLessThan(1000);
  } finally {
    await server.stop(true);
  }
});

test("cancels readiness response bodies before reporting success", async () => {
  let cancelled = false;
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 400 },
    ),
  );
  try {
    await waitForService("http://localhost:3768/mcp", 100);
    expect(cancelled).toBeTrue();
  } finally {
    fetchSpy.mockRestore();
  }
});

test("terminates service commands that never exit even when failures are ignored", async () => {
  const started = Date.now();
  await expect(
    runServiceCommand(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      true,
      100,
    ),
  ).rejects.toThrow("Service command interrupted");
  expect(Date.now() - started).toBeLessThan(2000);
});

test.each([false, true])(
  "bounds service exit after its stderr reader completes with ignored failures %s",
  async (ignoreFailure) => {
    const spawn = spyOn(Bun, "spawn");
    const readOutput = subprocess.readSubprocessOutput;
    const stderrDrained = Promise.withResolvers<void>();
    const reader = spyOn(subprocess, "readSubprocessOutput").mockImplementation(
      async (_stream, ...options) => {
        // Windows does not reliably expose pipe EOF after a child closes fd 2.
        // Complete the real reader against deterministic EOF while retaining a real live child.
        const output = await readOutput(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          ...options,
        );
        stderrDrained.resolve();
        return output;
      },
    );
    let operation: Promise<void> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      operation = runServiceCommand(
        [process.execPath, "-e", "setInterval(() => {}, 1000);"],
        ignoreFailure,
        1000,
      );
      const bounded = new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("Service exit remained unbounded")),
          3000,
        );
      });
      await Promise.race([
        stderrDrained.promise,
        operation.then(() => {
          throw new Error("Service exited before its stderr reader completed");
        }),
        bounded,
      ]);
      const child = spawn.mock.results[0]?.value as Bun.Subprocess;
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      await expect(Promise.race([operation, bounded])).rejects.toThrow(
        "deadline expired",
      );
      expect(child.signalCode ?? child.exitCode).not.toBeNull();
    } finally {
      if (watchdog) clearTimeout(watchdog);
      const child = spawn.mock.results[0]?.value as Bun.Subprocess | undefined;
      if (child?.exitCode === null && child.signalCode === null) child.kill();
      await operation?.catch(() => undefined);
      if (child?.stderr instanceof ReadableStream)
        await child.stderr.cancel().catch(() => undefined);
      reader.mockRestore();
      spawn.mockRestore();
    }
  },
);

test("discards large service output while draining diagnostics", async () => {
  await runServiceCommand([
    process.execPath,
    "-e",
    'process.stdout.write("x".repeat(1024 * 1024)); process.stderr.write("diagnostic");',
  ]);
});

test("reports command diagnostics and permits explicitly ignored exit failures", async () => {
  await expect(
    runServiceCommand([
      process.execPath,
      "-e",
      'process.stderr.write("failed service"); process.exit(4)',
    ]),
  ).rejects.toThrow("failed service");
  await expect(
    runServiceCommand([process.execPath, "-e", "process.exit(3)"]),
  ).rejects.toThrow("exit 3");
  await runServiceCommand([process.execPath, "-e", "process.exit(3)"], true);
});

test("bounds diagnostic output and terminates its producer", async () => {
  await expect(
    runServiceCommand([
      process.execPath,
      "-e",
      'process.stderr.write("x".repeat(17 * 1024 * 1024)); setInterval(() => {}, 1000)',
    ]),
  ).rejects.toThrow("command output exceeded");
});

test.skipIf(process.platform === "win32")(
  "bounds inherited diagnostic pipes after the service command exits",
  async () => {
    await expect(
      runServiceCommand(
        [
          process.execPath,
          "-e",
          'Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stderr:"inherit", stdout:"ignore"}); process.exit(0)',
        ],
        false,
        100,
      ),
    ).rejects.toThrow("deadline expired");
  },
);

test("retries server failures and accepts an empty readiness body", async () => {
  const fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  try {
    await waitForService("http://localhost:3768/mcp", 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  } finally {
    fetchSpy.mockRestore();
  }
});

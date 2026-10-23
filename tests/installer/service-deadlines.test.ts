import { expect, spyOn, test } from "bun:test";
import os from "node:os";

import {
  createServicePlan,
  runServiceCommand,
  waitForService,
} from "../../src/installer/service";

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

import { beforeEach, expect, spyOn, test } from "bun:test";

import { createMockTime, type MockTime } from "../support/mock-time";
let time: MockTime;
beforeEach(() => {
  time = createMockTime();
});
import os from "node:os";

import { createServicePlan, waitForService } from "../../src/installer/service";

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

test("retries server failures and accepts an empty readiness body", async () => {
  const fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  try {
    const ready = waitForService("http://localhost:3768/mcp", 1000);
    await time.advanceBy(100);
    await ready;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  } finally {
    fetchSpy.mockRestore();
  }
});

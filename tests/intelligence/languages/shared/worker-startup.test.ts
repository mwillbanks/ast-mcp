import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

import { LanguageWorkerClient } from "../../../../src/intelligence/languages/shared/language-worker-client.ts";
import {
  createWorkerClient,
  validateWorkerEnvelope,
} from "../../../../src/intelligence/languages/shared/worker-client.ts";

const limits = {
  maxOutstandingBytes: 1024,
  maxPendingRequests: 4,
  timeoutMs: 5000,
};
const error = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
const script = new URL(
  "data:text/javascript," +
    encodeURIComponent(
      'import { parentPort } from "node:worker_threads"; parentPort.on("message", request => setTimeout(() => parentPort.postMessage({ id: request.id, ok: false, type: "result", error: "expected parse failure" }), 20));',
    ),
);
const clients = (workerUrl: URL, timeoutMs = limits.timeoutMs) => [
  createWorkerClient({
    createError: error,
    displayName: "fixture",
    limits: { ...limits, timeoutMs },
    protocolName: "fixture",
    validateResponse: validateWorkerEnvelope,
    workerUrl,
  }),
  new LanguageWorkerClient<string>({
    closeMode: "detach-first",
    createError: error,
    label: "fixture",
    limits: { ...limits, timeoutMs },
    terminateOnProtocolError: false,
    terminateOnWorkerError: false,
    validateResult: (value): value is never => {
      validateWorkerEnvelope(value);
      return true;
    },
    workerUrl,
  }),
];

test("language transports settle synchronous startup failures without uncaught microtasks", async () => {
  for (const parser of clients(new URL("https://invalid.test/worker.ts"))) {
    await expect(
      parser.analyze({ languageId: "typescript", source: "payload" }),
    ).rejects.toMatchObject({ code: "worker-exit" });
    await parser.drain();
    expect(parser.stats()).toMatchObject({
      pendingRequests: 0,
      outstandingBytes: 0,
    });
    await parser.close();
  }
});

test("language transports settle clone failures and permit a clean restart", async () => {
  for (const parser of clients(script)) {
    await expect(
      parser.analyze({
        languageId: (() => {}) as unknown as string,
        source: "payload",
      }),
    ).rejects.toMatchObject({ code: "worker-exit" });
    await parser.drain();
    await expect(
      parser.analyze({ languageId: "typescript", source: "payload" }),
    ).rejects.toThrow("expected parse failure");
    await parser.close();
  }
});

test("late responses from unrelated workers cannot terminate the active transport", async () => {
  const parser = createWorkerClient({
    createError: error,
    displayName: "fixture",
    limits,
    protocolName: "fixture",
    validateResponse: validateWorkerEnvelope,
    workerUrl: script,
  });
  const stale = new Worker(new URL("data:text/javascript,"));
  try {
    const result = parser.analyze({
      languageId: "typescript",
      source: "payload",
    });
    await Bun.sleep(1);
    parser.handleResponse(stale, null);
    await expect(result).rejects.toThrow("expected parse failure");
    expect(parser.stats()).toMatchObject({
      pendingRequests: 0,
      outstandingBytes: 0,
    });
  } finally {
    await stale.terminate();
    await parser.close();
  }
});

test("failed language termination quarantines capacity and reports close failure", async () => {
  for (const parser of clients(script)) {
    const original = Worker.prototype.terminate;
    let retired: Worker | undefined;
    Worker.prototype.terminate = function () {
      retired = this;
      return Promise.reject(new Error("termination refused"));
    };
    const request = parser
      .analyze({ languageId: "typescript", source: "payload" })
      .catch((failure: Error) => failure.message);
    await Bun.sleep(1);
    try {
      await expect(parser.close()).rejects.toThrow("termination refused");
      expect(await request).toContain("closed");
      await expect(
        parser.analyze({ languageId: "typescript", source: "replacement" }),
      ).rejects.toMatchObject({ code: "queue-full" });
      await expect(parser.close()).rejects.toThrow("termination refused");
      await expect(parser.drain()).rejects.toThrow("termination refused");
      expect(parser.stats()).toMatchObject({
        pendingRequests: 1,
        outstandingBytes: 7,
      });
    } finally {
      Worker.prototype.terminate = original;
      if (retired) await original.call(retired);
    }
  }
});

test("language close bounds stalled retirement without releasing reservations", async () => {
  for (const parser of clients(script, 20)) {
    const original = Worker.prototype.terminate;
    let retired: Worker | undefined;
    let release!: (value: number) => void;
    Worker.prototype.terminate = function () {
      retired = this;
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    };
    const request = parser
      .analyze({ languageId: "typescript", source: "payload" })
      .catch((failure: Error) => failure.message);
    await Bun.sleep(1);
    try {
      await expect(parser.close()).rejects.toThrow(
        "worker retirement timed out",
      );
      expect(await request).toContain("closed");
      await expect(
        parser.analyze({ languageId: "typescript", source: "replacement" }),
      ).rejects.toMatchObject({ code: "queue-full" });
      expect(parser.stats().pendingRequests).toBe(1);
      release(0);
      await Bun.sleep(1);
      expect(parser.stats().pendingRequests).toBe(0);
    } finally {
      Worker.prototype.terminate = original;
      if (retired) await original.call(retired);
    }
  }
});

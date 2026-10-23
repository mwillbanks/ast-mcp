import { describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

import { createLanguageLoader } from "../../../../src/intelligence/languages/shared/language-loader.ts";
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

test("language admission waits for physical retirement within bounded capacity and supports cancellation", async () => {
  for (const parser of clients(script, 500)) {
    const original = Worker.prototype.terminate;
    let release!: () => void;
    Worker.prototype.terminate = function () {
      const active = this;
      return new Promise<number>((resolve, reject) => {
        release = () => {
          void original.call(active).then(resolve, reject);
        };
      });
    };
    const controller = new AbortController();
    const active = parser
      .analyze({
        languageId: "typescript",
        source: "payload",
        signal: controller.signal,
      })
      .catch((failure: Error) => failure.message);
    await Bun.sleep(1);
    controller.abort();
    expect(await active).toContain("aborted");
    const recovery = parser
      .analyze({ languageId: "typescript", source: "payload" })
      .catch((failure: Error) => failure.message);
    const queuedAbort = new AbortController();
    const cancelled = parser
      .analyze({
        languageId: "typescript",
        source: "payload",
        signal: queuedAbort.signal,
      })
      .catch((failure: Error) => failure.message);
    const timed = parser
      .analyze({ languageId: "typescript", source: "payload", timeoutMs: 1 })
      .catch((failure: Error) => failure.message);
    try {
      await expect(
        parser.analyze({ languageId: "typescript", source: "overflow" }),
      ).rejects.toMatchObject({ code: "queue-full" });
      expect(parser.stats().pendingRequests).toBe(4);
      queuedAbort.abort();
      expect(await cancelled).toContain("aborted");
      expect(await timed).toContain("timed out");
      expect(parser.stats().pendingRequests).toBe(2);
      Worker.prototype.terminate = original;
      release();
      expect(await recovery).toBe("expected parse failure");
      await parser.drain();
      expect(parser.stats().pendingRequests).toBe(0);
    } finally {
      Worker.prototype.terminate = original;
      await parser.close();
    }
  }
});

test("language requests waiting during a failed retirement reject without replacement", async () => {
  for (const parser of clients(script)) {
    const original = Worker.prototype.terminate;
    let rejectRetirement!: (error: Error) => void;
    let retired: Worker | undefined;
    Worker.prototype.terminate = function () {
      retired = this;
      return new Promise<number>((_resolve, reject) => {
        rejectRetirement = reject;
      });
    };
    const request = parser
      .analyze({ languageId: "typescript", source: "payload" })
      .catch((failure: Error) => failure.message);
    await Bun.sleep(1);
    const closing = parser.close().catch((failure: Error) => failure.message);
    const waiting = parser
      .analyze({ languageId: "typescript", source: "recovery" })
      .catch((failure: Error & { code: string }) => failure.code);
    await Bun.sleep(1);
    try {
      rejectRetirement(new Error("retirement refused"));
      expect(await closing).toBe("retirement refused");
      expect(await request).toContain("closed");
      expect(await waiting).toBe("queue-full");
      expect(parser.stats().pendingRequests).toBe(1);
    } finally {
      Worker.prototype.terminate = original;
      if (retired) await original.call(retired);
    }
  }
});

describe("shared grammar loader contracts", () => {
  test("shares initialization and same-language loads across concurrent requests", async () => {
    let initializes = 0;
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = createLanguageLoader(
      async () => {
        initializes++;
        await gate;
      },
      async (id) => {
        loads++;
        return { id };
      },
    );
    const one = load("typescript");
    const two = load("typescript");
    const other = load("javascript");
    release();
    const values = await Promise.all([one, two, other]);
    expect(values[0]).toBe(values[1]);
    expect(values[2]).toEqual({ id: "javascript" });
    expect(initializes).toBe(1);
    expect(loads).toBe(2);
    expect(await load("typescript")).toBe(values[0]!);
    expect(loads).toBe(2);
  });

  test("retries failed initialization and grammar loads without poisoning the cache", async () => {
    let initializes = 0;
    let loads = 0;
    const load = createLanguageLoader(
      async () => {
        if (++initializes === 1) throw new Error("initialization unavailable");
      },
      async (id) => {
        if (++loads === 1) throw new Error("grammar unavailable");
        return id;
      },
    );
    const initial = await Promise.allSettled([
      load("typescript"),
      load("typescript"),
    ]);
    expect(initial.every((value) => value.status === "rejected")).toBe(true);
    await expect(load("typescript")).rejects.toThrow("grammar unavailable");
    expect(await load("typescript")).toBe("typescript");
    expect(initializes).toBe(2);
    expect(loads).toBe(2);
  });
});

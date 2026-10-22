import { describe, expect, test } from "bun:test";

import { LanguageWorkerClient } from "../../../../src/intelligence/languages/shared/language-worker-client.ts";
import type { LanguageWorkerResult } from "../../../../src/intelligence/languages/shared/worker-protocol-validator.ts";

function client(body: string, terminate = true) {
  return new LanguageWorkerClient({
    closeMode: "terminate",
    label: "fixture",
    limits: {
      maxOutstandingBytes: 1024,
      maxPendingRequests: 2,
      timeoutMs: 5000,
    },
    terminateOnProtocolError: terminate,
    terminateOnWorkerError: terminate,
    createError: (code, message) => Object.assign(new Error(message), { code }),
    validateResult: (value: unknown): value is LanguageWorkerResult => {
      if (!value || typeof value !== "object") return false;
      const result = value as Record<string, unknown>;
      return (
        result.type === "result" &&
        result.ok === false &&
        typeof result.id === "number" &&
        typeof result.error === "string"
      );
    },
    workerUrl: new URL(
      "data:text/javascript," +
        encodeURIComponent(
          'import { parentPort } from "node:worker_threads"; parentPort.on("message", (message) => { ' +
            body +
            " });",
        ),
    ),
  });
}

describe("language worker transport failures", () => {
  test("rejects malformed and unsolicited replies under both termination policies", async () => {
    for (const terminate of [true, false]) {
      for (const response of [
        "null",
        "{ id: message.id + 100, ok: true }",
        '{ id: message.id, ok: "invalid" }',
      ]) {
        const parser = client(
          "parentPort.postMessage(" + response + "); parentPort.close();",
          terminate,
        );
        try {
          await expect(
            parser.analyze({ languageId: "fixture", source: "payload" }),
          ).rejects.toMatchObject({ code: "protocol" });
          await parser.drain();
          expect(parser.stats()).toMatchObject({
            pendingRequests: 0,
            outstandingBytes: 0,
          });
        } finally {
          await parser.close();
        }
      }
    }
  });

  test("propagates worker-declared parse errors without corrupting capacity", async () => {
    const parser = client(
      'parentPort.postMessage({ type: "result", id: message.id, ok: false, error: "invalid fixture source" });',
    );
    try {
      await expect(
        parser.analyze({ languageId: "fixture", source: "payload" }),
      ).rejects.toThrow("invalid fixture source");
      expect(parser.stats().pendingRequests).toBe(0);
    } finally {
      await parser.close();
    }
  });

  test("releases all pending work after a worker crashes under both policies", async () => {
    for (const terminate of [true, false]) {
      const parser = client('throw new Error("fixture crash")', terminate);
      try {
        const failures = await Promise.allSettled([
          parser.analyze({ languageId: "fixture", source: "first" }),
          parser.analyze({ languageId: "fixture", source: "second" }),
        ]);
        expect(
          failures.every(
            (result) =>
              result.status === "rejected" &&
              result.reason.message.includes("fixture crash"),
          ),
        ).toBe(true);
        await parser.drain();
        expect(parser.stats()).toMatchObject({
          active: false,
          outstandingBytes: 0,
          pendingRequests: 0,
        });
      } finally {
        await parser.close();
      }
    }
  });

  test("reports exit status when a worker exits before replying", async () => {
    const parser = client("process.exit(7)");
    try {
      await expect(
        parser.analyze({ languageId: "fixture", source: "payload" }),
      ).rejects.toMatchObject({ code: "worker-exit" });
      expect(parser.stats().outstandingBytes).toBe(0);
    } finally {
      await parser.close();
    }
  });
});

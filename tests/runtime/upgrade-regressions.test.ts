import { expect, test } from "bun:test";

import { readSubprocessOutput } from "../../src/runtime/subprocess";
import { flushMicrotasks } from "../support/mock-time";

test("output cancellation releases the reader when stream cleanup rejects", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      throw new Error("fixture cancellation failure");
    },
  });
  const completion = readSubprocessOutput(stream, abort.signal, async () => {
    throw new Error("unexpected overflow");
  });
  abort.abort();
  await expect(completion).rejects.toBe(abort.signal.reason);
  await flushMicrotasks();
  expect(cancelled).toBeTrue();
  expect(stream.locked).toBeFalse();
});

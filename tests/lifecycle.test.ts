import { expect, test } from "bun:test";

import { createProcessServer } from "../src/lifecycle";
import { PROCESS_SIGNALS } from "../src/runtime/signals";

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

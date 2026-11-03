import { expect, test } from "bun:test";

import { createMockTime, deferred, MOCK_EPOCH } from "../support/mock-time";

test("clock advances sleeps and intervals without host waiting", async () => {
  const time = createMockTime();
  const events: number[] = [];
  const interval = time.timers.setInterval(() => events.push(time.now()), 10);
  const sleeping = time.sleep(25);
  await time.advanceBy(25);
  await sleeping;
  expect(events).toEqual([MOCK_EPOCH + 10, MOCK_EPOCH + 20]);
  time.timers.clearInterval(interval);
  expect(time.pending()).toBe(0);
  time.dispose();
  expect(() => time.now()).toThrow("disposed");
  time.dispose();
});

test("clock cancellation next timer and fixed dates are deterministic", async () => {
  const time = createMockTime({ now: 1000 });
  const gate = deferred();
  const cancelled = time.timers.setTimeout(() => {
    throw new Error("cancelled");
  }, 1);
  time.timers.clearTimeout(cancelled);
  time.timers.setTimeout(gate.resolve, 50);
  await time.runNext();
  await gate.promise;
  expect(time.date().toISOString()).toBe("1970-01-01T00:00:01.050Z");
  expect(time.pending()).toBe(0);
  await expect(time.advanceBy(-1)).rejects.toThrow("nonnegative");
  expect(() => createMockTime()).toThrow("already active");
});

test("automatic cleanup restores clock ownership between tests", () => {
  const time = createMockTime();
  expect(time.now()).toBe(MOCK_EPOCH);
  time.timers.setTimeout(() => {
    throw new Error("leaked");
  }, 100);
  expect(() => time.dispose()).toThrow("leaked 1 pending timers");
  const restored = createMockTime();
  expect(restored.now()).toBe(MOCK_EPOCH);
  restored.dispose();
});
test("async timer chains advance at explicit phase boundaries", async () => {
  const time = createMockTime();
  const started = time.monotonic();
  const phase = deferred();
  const operation = (async () => {
    await time.sleep(5);
    phase.resolve();
    await time.sleep(5);
    return time.now();
  })();
  await time.advanceBy(5);
  await phase.promise;
  expect(time.pending()).toBe(1);
  await time.advanceBy(5);
  expect(await operation).toBe(MOCK_EPOCH + 10);
  expect(time.monotonic() - started).toBe(10);
  expect(time.pending()).toBe(0);
  expect(() => time.sleep(-1)).toThrow("nonnegative");
  expect(() => createMockTime({ now: Number.NaN })).toThrow();
});

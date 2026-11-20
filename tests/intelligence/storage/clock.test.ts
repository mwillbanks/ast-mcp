import { expect, test } from "bun:test";

import { StorageClock } from "./clock.ts";

test.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  "storage clock rejects invalid advancement %s without changing time",
  (milliseconds) => {
    const clock = new StorageClock();
    const initial = clock.now();
    expect(() => clock.advanceBy(milliseconds)).toThrow(
      "Storage clock advancement must be finite and nonnegative",
    );
    expect(clock.now()).toBe(initial);
    clock.assertDrained();
  },
);

test("storage clock orders heartbeat boundaries and detects uncancelled owners", () => {
  const clock = new StorageClock();
  const initial = clock.now();
  const calls: string[] = [];
  const cancelLong = clock.scheduleHeartbeat(() => {
    calls.push(`long ${clock.now() - initial}`);
  }, 10);
  const cancelShort = clock.scheduleHeartbeat(() => {
    calls.push(`short ${clock.now() - initial}`);
  }, 5);
  try {
    expect(() => clock.assertDrained()).toThrow(
      "Storage clock leaked 2 heartbeat timers",
    );
    clock.advanceBy(4);
    expect(calls).toEqual([]);
    clock.advanceBy(1);
    expect(calls).toEqual(["short 5"]);
    clock.advanceBy(5);
    expect(calls).toEqual(["short 5", "long 10", "short 10"]);
    expect(clock.date()).toEqual(new Date(initial + 10));
    cancelLong();
    expect(() => clock.assertDrained()).toThrow(
      "Storage clock leaked 1 heartbeat timers",
    );
  } finally {
    cancelLong();
    cancelShort();
    clock.assertDrained();
  }
  clock.advanceBy(20);
  expect(calls).toHaveLength(3);
});

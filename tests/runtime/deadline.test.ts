import { expect, test } from "bun:test";

import { createDeadline } from "../../src/runtime/deadline";
import { createMockTime } from "../support/mock-time";

test("deadlines expire at controlled time and dispose without pending timers", async () => {
  const time = createMockTime();
  using deadline = createDeadline(10.9);
  expect(deadline.signal.aborted).toBeFalse();
  await time.advanceBy(9);
  expect(deadline.signal.aborted).toBeFalse();
  await time.advanceBy(1);
  expect(deadline.signal.reason).toMatchObject({ name: "TimeoutError" });
  expect(time.pending()).toBe(0);
});

test("disposal cancels deadlines and preserves external cancellation", async () => {
  const time = createMockTime();
  const external = new AbortController();
  const reason = new Error("request cancelled");
  using deadline = createDeadline(1000, external.signal);
  external.abort(reason);
  expect(deadline.signal.reason).toBe(reason);
  deadline.dispose();
  expect(time.pending()).toBe(0);
  await time.advanceBy(1000);
  expect(deadline.signal.reason).toBe(reason);
});

test("invalid deadlines allocate no timer", () => {
  const time = createMockTime();
  for (const value of [-1, NaN, Infinity, -Infinity])
    expect(() => createDeadline(value)).toThrow(TypeError);
  expect(time.pending()).toBe(0);
});

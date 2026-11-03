import { afterEach, jest } from "bun:test";

const activeClocks = new Set<() => void>();
afterEach(() => {
  for (const dispose of activeClocks) dispose();
});

/** Fixed epoch shared by deterministic test clocks. */
export const MOCK_EPOCH = 1_700_000_000_000;

export function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

/** Flush promise continuations without advancing time or waiting for the host. */
export async function flushMicrotasks() {
  for (let turn = 0; turn < 16; turn++) await Promise.resolve();
}

/**
 * Own the process-local fake clock for one serial test. Dispose in finally.
 * Production code must obtain timer functions after installation or accept timers.
 */
export function createMockTime(options: { now?: number } = {}) {
  if (jest.isFakeTimers()) throw new Error("A mock clock is already active");
  if (!Number.isFinite(options.now ?? MOCK_EPOCH))
    throw new Error("Mock epoch must be finite");
  jest.useFakeTimers({ now: options.now ?? MOCK_EPOCH });
  let disposed = false;
  const assertActive = () => {
    if (disposed) throw new Error("Mock clock has been disposed");
  };
  const delay = (milliseconds: number) => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new Error("Mock delays must be finite and nonnegative");
    return milliseconds;
  };
  const timers = {
    setTimeout(callback: () => void, delay: number) {
      assertActive();
      return setTimeout(callback, delay);
    },
    clearTimeout(timer: ReturnType<typeof setTimeout> | undefined) {
      clearTimeout(timer);
    },
    setInterval(callback: () => void, delay: number) {
      assertActive();
      return setInterval(callback, delay);
    },
    clearInterval(timer: ReturnType<typeof setInterval> | undefined) {
      clearInterval(timer);
    },
  };
  const clock = {
    timers,
    now() {
      assertActive();
      return Date.now();
    },
    date() {
      assertActive();
      return new Date(Date.now());
    },
    monotonic() {
      assertActive();
      return performance.now();
    },
    sleep(milliseconds: number) {
      assertActive();
      return new Promise<void>((resolve) =>
        timers.setTimeout(resolve, delay(milliseconds)),
      );
    },
    async advanceBy(milliseconds: number) {
      assertActive();
      if (!Number.isFinite(milliseconds) || milliseconds < 0)
        throw new Error("Clock advancement must be finite and nonnegative");
      await flushMicrotasks();
      jest.advanceTimersByTime(milliseconds);
      await flushMicrotasks();
    },
    async runNext() {
      assertActive();
      await flushMicrotasks();
      jest.advanceTimersToNextTimer();
      await flushMicrotasks();
    },
    pending() {
      assertActive();
      return jest.getTimerCount();
    },
    dispose() {
      if (disposed) return;
      const pending = jest.getTimerCount();
      disposed = true;
      jest.clearAllTimers();
      jest.useRealTimers();
      activeClocks.delete(clock.dispose);
      if (pending !== 0)
        throw new Error(`Mock clock leaked ${pending} pending timers`);
    },
  };
  activeClocks.add(clock.dispose);
  return clock;
}

export type MockTime = ReturnType<typeof createMockTime>;

/** Drive a mocked deadline protocol with a finite virtual-timer budget. */
export async function settleWithMockTime<T>(
  time: MockTime,
  pending: Promise<T>,
  limit = 32,
): Promise<T> {
  let settled = false;
  const observed = pending.then(
    (value) => {
      settled = true;
      return { ok: true as const, value };
    },
    (error) => {
      settled = true;
      return { ok: false as const, error };
    },
  );
  for (let step = 0; step < limit && !settled; step++) await time.runNext();
  if (!settled)
    throw new Error(
      "Mock operation did not settle within its timer budget; add a phase gate",
    );
  const result = await observed;
  if (!result.ok) throw result.error;
  return result.value;
}

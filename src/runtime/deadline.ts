/** A cooperative deadline whose owner releases its timer on every exit path. */
export function createDeadline(timeoutMs: number, signal?: AbortSignal) {
  // Match Bun's numeric AbortSignal.timeout conversion before allocating a timer.
  const milliseconds = Math.trunc(timeoutMs);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new TypeError("Deadline must be a nonnegative finite integer");
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(new DOMException("Deadline elapsed", "TimeoutError")),
    milliseconds,
  );
  timer.unref?.();
  const dispose = () => clearTimeout(timer);
  return {
    signal: signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal,
    dispose,
    [Symbol.dispose]: dispose,
  };
}

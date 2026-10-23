import { Worker as ThreadWorker } from "node:worker_threads";

/** Adapt the existing browser-style factory contract to awaitable thread retirement. */
export function createParserTransport(workerUrl: string): Worker {
  const active = new ThreadWorker(new URL(workerUrl));
  let closing = false;
  const transport = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage(message: unknown) {
      active.postMessage(message);
    },
    terminate() {
      closing = true;
      return active.terminate();
    },
  };
  active.unref();
  active.on("message", (data: unknown) =>
    transport.onmessage?.({ data } as MessageEvent),
  );
  active.on("error", (error: Error) =>
    transport.onerror?.({ message: error.message } as ErrorEvent),
  );
  active.on("exit", (code) => {
    if (!closing)
      transport.onerror?.({
        message: `Parser worker exited with code ${code}`,
      } as ErrorEvent);
  });
  return transport as unknown as Worker;
}

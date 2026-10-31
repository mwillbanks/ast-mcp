import { spyOn } from "bun:test";
import { Worker } from "node:worker_threads";

/** Observe an actual worker start; optionally withhold its payload until lifecycle teardown. */
export function observeWorkerDispatch(options: { holdStart?: boolean } = {}) {
  let started!: (value: { worker: Worker; id: number }) => void;
  const dispatched = new Promise<{ worker: Worker; id: number }>((resolve) => {
    started = resolve;
  });
  const original = Worker.prototype.postMessage;
  const post = spyOn(Worker.prototype, "postMessage").mockImplementation(
    function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      const message = args[0] as { type?: string; id: number };
      if (message.type === "start") {
        if (!options.holdStart) original.apply(this, args);
        started({ worker: this, id: message.id });
      } else {
        original.apply(this, args);
      }
    },
  );
  return { dispatched, restore: () => post.mockRestore() };
}

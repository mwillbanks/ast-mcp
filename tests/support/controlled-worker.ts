import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";

import { deferred } from "./mock-time";

/** Protocol-level worker double with explicit message and retirement completion. */
export class ControlledWorker extends EventEmitter {
  readonly posted = deferred<unknown>();
  readonly terminationRequested = deferred<void>();
  readonly retired = deferred<number>();
  readonly messages: unknown[] = [];

  constructor(
    readonly respond?: (message: any, worker: ControlledWorker) => void,
    readonly automaticRetirement = true,
  ) {
    super();
  }

  postMessage(message: unknown) {
    this.messages.push(message);
    this.posted.resolve(message);
    this.respond?.(message, this);
  }

  terminate(): Promise<number> {
    this.terminationRequested.resolve();
    if (this.automaticRetirement) this.retired.resolve(0);
    return this.retired.promise;
  }

  asWorker(): Worker {
    return Object.assign(this, { unref: () => this }) as unknown as Worker;
  }
}

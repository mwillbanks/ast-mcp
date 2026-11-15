import { expect, test } from "bun:test";

import type * as Scheduler from "../../../src/intelligence/mutation/experimental-deferred-refresh.ts";
import { createMockTime, deferred } from "../../support/mock-time.ts";

test.skipIf(typeof Bun.ModuleGraph !== "function")(
  "scheduler discards debounce and joins active work at broker shutdown",
  async () => {
    const time = createMockTime();
    const graph = new Bun.ModuleGraph();
    const release = deferred();
    try {
      const entry = new URL(
        "../../../src/intelligence/mutation/experimental-deferred-refresh.ts",
        import.meta.url,
      );
      const scheduler = await graph.import<typeof Scheduler>(entry.href);
      await graph.run(async () => {
        const { scheduleMutationRefresh, stopMutationRefreshes } = scheduler;
        const marker = {
          kind: "pending",
          epoch: "d7449186-3320-41d1-bf5d-2abd3d65c286",
          firstDirtyAt: time.now(),
          lastDirtyAt: time.now(),
          inFlight: false,
          paths: null,
          scope: "a".repeat(64),
          storageScope: "b".repeat(64),
        } as const;
        const active = deferred<AbortSignal>();
        const ignored = () => Promise.reject(new Error("debounced work ran"));
        scheduleMutationRefresh("active", marker, async (_state, signal) => {
          if (!signal) throw new Error("Missing scheduler signal");
          active.resolve(signal);
          await release.promise;
          return "retry";
        });
        await time.advanceBy(75);
        const signal = await active.promise;
        scheduleMutationRefresh("pending", marker, ignored);
        expect(time.pending()).toBe(1);
        const stopped = stopMutationRefreshes();
        expect(stopMutationRefreshes()).toBe(stopped);
        let settled = false;
        void stopped.then(() => {
          settled = true;
        });
        await time.advanceBy(75);
        expect(time.pending()).toBe(0);
        expect(signal.aborted).toBeTrue();
        expect(settled).toBeFalse();
        scheduleMutationRefresh("late", marker, ignored);
        release.resolve();
        await stopped;
        expect(time.pending()).toBe(0);
      });
    } finally {
      release.resolve();
      graph.dispose();
      time.dispose();
    }
  },
);

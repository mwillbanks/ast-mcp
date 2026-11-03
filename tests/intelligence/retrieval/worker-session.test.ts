import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";

import {
  EmbeddingWorkerPool,
  TransformersEmbeddingProvider,
  PotionStaticEmbeddingProvider,
} from "../../../src/intelligence/retrieval/embedding.ts";
import {
  EmbeddingModelConfigSchema,
  POTION_CODE_BENCHMARK_MODEL,
} from "../../../src/intelligence/retrieval/types.ts";
import {
  ManagedModelSession,
  type ModelWorkerRequest,
} from "../../../src/intelligence/retrieval/worker-session.ts";
import { createMockTime, type MockTime } from "../../support/mock-time.ts";

const { runtime: _runtime, ...potionConfig } = POTION_CODE_BENCHMARK_MODEL;
const config = EmbeddingModelConfigSchema.parse({
  artifacts: {},
  dimensions: 2,
  batchSize: 1,
});
const url = (body: string, notifyStarted = true) =>
  new URL(
    "data:text/javascript," +
      encodeURIComponent(
        'import { parentPort } from "node:worker_threads"; parentPort.on("message", request => {' +
          (notifyStarted
            ? 'parentPort.postMessage({id: request.id, type: "started"});'
            : "") +
          body +
          "});",
      ),
  );
const session = (body: string, timeout = 500) =>
  new ManagedModelSession(config, "transformers", false, timeout, url(body));

let clock: MockTime | undefined;
beforeEach(() => {
  clock = createMockTime();
});
afterEach(() => {
  clock?.dispose();
  clock = undefined;
});

class ControlledWorker extends EventEmitter {
  readonly requests: ModelWorkerRequest[] = [];
  readonly firstStarted = Promise.withResolvers<void>();
  readonly retiring = Promise.withResolvers<void>();
  readonly retirement = Promise.withResolvers<number>();
  terminateCalls = 0;

  constructor(
    private readonly onRequest?: (
      request: ModelWorkerRequest,
      worker: ControlledWorker,
    ) => void,
    private readonly notifyStarted = true,
  ) {
    super();
  }

  unref() {}

  postMessage(request: ModelWorkerRequest) {
    this.requests.push(request);
    if (this.notifyStarted) this.started(request);
    this.onRequest?.(request, this);
  }

  started(request: ModelWorkerRequest) {
    this.emit("message", { id: request.id, type: "started" });
    this.firstStarted.resolve();
  }

  finish(request: ModelWorkerRequest) {
    this.emit("message", { id: request.id, vectors: [[1, 0]] });
  }

  terminate() {
    this.terminateCalls++;
    this.retiring.resolve();
    return this.retirement.promise;
  }

  asWorker() {
    return this as unknown as Worker;
  }
}

async function closeControlled(
  model: ManagedModelSession,
  workers: ControlledWorker[],
) {
  const closing = model.close();
  for (const worker of workers) worker.retirement.resolve(0);
  await closing.catch(() => {});
}

describe("isolated model session lifecycle", () => {
  test("bounds close while a native thread cannot finish termination", async () => {
    const timers = clock!;
    const active = new ControlledWorker();
    const model = new ManagedModelSession(
      config,
      "transformers",
      false,
      20,
      url(""),
      () => active.asWorker(),
      300_000,
      timers.timers,
    );
    const pending = model
      .embed(["query"])
      .catch((error: Error) => error.message);
    try {
      await active.firstStarted.promise;
      const closing = model.close().catch((error: Error) => error);
      await active.retiring.promise;
      await timers.advanceBy(19);
      expect(timers.pending()).toBe(1);
      await timers.advanceBy(1);
      expect(await closing).toMatchObject({
        message: "embedding_worker_retirement_timeout",
      });
      expect(await pending).toBe("embedding_session_closed");
      expect(active.terminateCalls).toBe(1);
      active.retirement.resolve(0);
      await model.close();
      expect(timers.pending()).toBe(0);
    } finally {
      await closeControlled(model, [active]);
    }
  });

  test("quarantines failed termination and reports repeated close failures", async () => {
    const timers = clock!;
    const active = new ControlledWorker();
    const model = new ManagedModelSession(
      config,
      "transformers",
      false,
      100,
      url(""),
      () => active.asWorker(),
      300_000,
      timers.timers,
    );
    const pending = model
      .embed(["query"])
      .catch((error: Error) => error.message);
    try {
      await active.firstStarted.promise;
      const closing = model.close().catch((error: Error) => error);
      await active.retiring.promise;
      active.retirement.reject(new Error("termination unavailable"));
      expect(await closing).toMatchObject({
        message: "termination unavailable",
      });
      await expect(model.close()).rejects.toThrow("termination unavailable");
      expect(await pending).toBe("embedding_session_closed");
      expect(active.terminateCalls).toBe(1);
      expect(timers.pending()).toBe(0);
    } finally {
      await closeControlled(model, [active]);
    }
  });

  test("bounds recovery admission and expires waiters while retirement remains pending", async () => {
    const timers = clock!;
    const active = new ControlledWorker();
    let creates = 0;
    const model = new ManagedModelSession(
      config,
      "transformers",
      false,
      10,
      url(""),
      () => {
        creates++;
        return active.asWorker();
      },
      100,
      timers.timers,
    );
    try {
      const pending = model
        .embed(["stuck"])
        .catch((error: Error) => error.message);
      await active.firstStarted.promise;
      await timers.advanceBy(10);
      expect(await pending).toBe("embedding_worker_timeout");
      await active.retiring.promise;
      const waiting = Array.from({ length: 128 }, () =>
        model.embed(["recovery"]).catch((error: Error) => error.message),
      );
      await expect(model.embed(["overflow"])).rejects.toThrow(
        "embedding_queue_full",
      );
      await timers.advanceBy(99);
      expect(timers.pending()).toBe(128);
      expect(creates).toBe(1);
      await timers.advanceBy(1);
      expect(await Promise.all(waiting)).toEqual(
        Array(128).fill("embedding_worker_retirement_timeout"),
      );
      expect(timers.pending()).toBe(0);
      const closingWaiter = model
        .embed(["close"])
        .catch((error: Error) => error.message);
      const closing = model.close();
      expect(await closingWaiter).toBe("embedding_session_closed");
      active.retirement.resolve(0);
      await closing;
      expect(creates).toBe(1);
      expect(timers.pending()).toBe(0);
    } finally {
      await closeControlled(model, [active]);
    }
  });

  test("rejects bounded recovery callers when physical retirement fails", async () => {
    const timers = clock!;
    const active = new ControlledWorker();
    const model = new ManagedModelSession(
      config,
      "transformers",
      false,
      10,
      url(""),
      () => active.asWorker(),
      200,
      timers.timers,
    );
    try {
      const pending = model
        .embed(["stuck"])
        .catch((error: Error) => error.message);
      await active.firstStarted.promise;
      await timers.advanceBy(10);
      expect(await pending).toBe("embedding_worker_timeout");
      await active.retiring.promise;
      const recovery = model.embed(["recovery"]).catch((error: Error) => error);
      active.retirement.reject(new Error("termination failed"));
      expect(await recovery).toMatchObject({
        message: "embedding_worker_retiring",
      });
      await expect(model.embed(["later"])).rejects.toThrow(
        "embedding_worker_retiring",
      );
      await expect(model.close()).rejects.toThrow("termination failed");
      expect(timers.pending()).toBe(0);
      expect(active.terminateCalls).toBe(1);
    } finally {
      await closeControlled(model, [active]);
    }
  });

  test("preserves typed worker failures and rejects invalid batch counts", async () => {
    const typed = session(
      'parentPort.postMessage({ id: request.id, error: "bad dimensions", errorName: "TypeError" });',
    );
    await expect(typed.embed(["query"])).rejects.toBeInstanceOf(TypeError);
    await typed.close();
    const mismatch = session(
      "parentPort.postMessage({ id: request.id, vectors: [] });",
    );
    await expect(mismatch.embed(["query"])).rejects.toThrow(
      "embedding_worker_protocol_error",
    );
    await mismatch.close();
  });

  test("returns model failures without destroying a usable thread", async () => {
    const model = session(
      'parentPort.postMessage(request.id === 1 ? { id: request.id, error: "model corrupt" } : { id: request.id, vectors: [[1, 0]] });',
    );
    try {
      await expect(model.embed(["bad"])).rejects.toThrow("model corrupt");
      expect(await model.embed(["good"])).toEqual([[1, 0]]);
    } finally {
      await model.close();
    }
  });

  test("terminates a stuck thread, rejects all callers, then permits replacement", async () => {
    const timers = clock!;
    const started = Promise.withResolvers<void>();
    let creates = 0;
    const model = new ManagedModelSession(
      config,
      "transformers",
      false,
      100,
      url(
        'if (request.texts[0] === "hang") { while (true) {} } else parentPort.postMessage({ id: request.id, vectors: [[1, 0]] });',
      ),
      (workerUrl) => {
        creates++;
        const worker = new Worker(workerUrl);
        worker.on("message", (message) => {
          if (message.type === "started") started.resolve();
        });
        return worker;
      },
      300_000,
      timers.timers,
    );
    try {
      const one = model.embed(["hang"]).catch((error: Error) => error.message);
      const two = model
        .embed(["queued"])
        .catch((error: Error) => error.message);
      await started.promise;
      await timers.advanceBy(100);
      expect(await one).toBe("embedding_worker_timeout");
      expect(await two).toBe("embedding_worker_timeout");
      expect(await model.embed(["healthy"])).toEqual([[1, 0]]);
      expect(creates).toBe(2);
    } finally {
      await model.close();
    }
    expect(timers.pending()).toBe(0);
  });

  test("settles startup, process, protocol, and clone failures", async () => {
    const startup = new ManagedModelSession(
      config,
      "transformers",
      false,
      100,
      new URL("https://invalid.test/worker.ts"),
    );
    await expect(startup.embed(["query"])).rejects.toThrow();
    await startup.close();
    for (const [body, error] of [
      ['throw new Error("crash")', "embedding_worker_error"],
      ["process.exit(0)", "embedding_worker_exit"],
      ["parentPort.postMessage(null)", "embedding_worker_protocol_error"],
      [
        "parentPort.postMessage({ id: request.id, vectors: [[NaN, 0]] })",
        "embedding_worker_protocol_error",
      ],
    ]) {
      const model = session(body!);
      await expect(model.embed(["query"])).rejects.toThrow(error);
      await model.close();
    }
    const clone = session("");
    await expect(
      clone.embed([(() => {}) as unknown as string]),
    ).rejects.toThrow("embedding_worker_post_failed");
    await clone.close();
  });

  test("close promptly rejects in-flight calls and prevents replacement", async () => {
    const model = session("");
    const pending = model
      .embed(["query"])
      .catch((error: Error) => error.message);
    await model.close();
    expect(await pending).toBe("embedding_session_closed");
    await expect(model.embed(["query"])).rejects.toThrow(
      "embedding_session_closed",
    );
    const unused = session("");
    await unused.close();
  });

  test("default production providers execute their model checks in the actual worker", async () => {
    const transformer = new TransformersEmbeddingProvider({
      artifacts: {},
      dimensions: 2,
    });
    await expect(transformer.embed(["query"])).rejects.toThrow(
      "embedding_model_not_configured",
    );
    await transformer.close();
    const potion = new PotionStaticEmbeddingProvider(potionConfig);
    await expect(potion.embed(["query"])).rejects.toThrow(
      "embedding_model_not_configured",
    );
    await potion.close();
    await expect(transformer.embed(["after close"])).rejects.toThrow(
      "embedding_session_closed",
    );
    await expect(potion.embed(["after close"])).rejects.toThrow(
      "embedding_session_closed",
    );
  });
});

describe("embedding ownership and cancellation", () => {
  test("close settles an active failure without requeueing retries", async () => {
    let fail!: (error: Error) => void;
    const gate = new Promise<readonly number[][]>((_, reject) => {
      fail = reject;
    });
    const pool = new EmbeddingWorkerPool(config, () => ({
      config,
      embed: () => gate,
      close: async () => {},
    }));
    const result = pool.embed("query").catch((error: Error) => error.message);
    const closing = pool.close();
    fail(new Error("native failure"));
    await closing;
    expect(await result).toBe("embedding_cancelled");
    expect(pool.pending).toBe(0);
  });

  test("abort settles queued and active promises before inference returns", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pool = new EmbeddingWorkerPool(config, () => ({
      config,
      embed: async () => {
        await gate;
        return [[1, 0]];
      },
      close: async () => {},
    }));
    const controller = new AbortController();
    const active = pool
      .embed("active", { signal: controller.signal })
      .catch((error: Error) => error.message);
    const queued = pool
      .embed("queued", { signal: controller.signal })
      .catch((error: Error) => error.message);
    controller.abort();
    expect(await active).toBe("embedding_cancelled");
    expect(await queued).toBe("embedding_cancelled");
    release();
    await pool.close();
  });

  test("failed injected session factories can recover on the next request", async () => {
    let transformerLoads = 0;
    const transformer = new TransformersEmbeddingProvider(
      { artifacts: {}, dimensions: 2 },
      true,
      async () => {
        if (++transformerLoads === 1) throw new Error("temporary load failure");
        return async () => ({ data: [1, 0] });
      },
    );
    await expect(transformer.embed(["query"])).rejects.toThrow(
      "temporary load failure",
    );
    expect(await transformer.embed(["query"])).toEqual([[1, 0]]);
    await transformer.close();
    let potionLoads = 0;
    const potion = new PotionStaticEmbeddingProvider(potionConfig, async () => {
      if (++potionLoads === 1) throw new Error("temporary load failure");
      return { embed: async () => [Array.from({ length: 256 }, () => 1)] };
    });
    await expect(potion.embed(["query"])).rejects.toThrow(
      "temporary load failure",
    );
    expect((await potion.embed(["query"]))[0]).toHaveLength(256);
    await potion.close();
  });
});

test("default provider wrappers retain failed retirement ownership across close calls", async () => {
  const original = Worker.prototype.terminate;
  const retired: Worker[] = [];
  Worker.prototype.terminate = function () {
    retired.push(this);
    return Promise.reject(new Error("native retirement refused"));
  };
  try {
    const providers = [
      new TransformersEmbeddingProvider({ artifacts: {}, dimensions: 2 }),
      new PotionStaticEmbeddingProvider(potionConfig),
    ];
    for (const provider of providers) {
      await expect(provider.embed(["query"])).rejects.toThrow(
        "embedding_model_not_configured",
      );
      await expect(provider.close()).rejects.toThrow(
        "native retirement refused",
      );
      await expect(provider.close()).rejects.toThrow(
        "native retirement refused",
      );
      await expect(provider.embed(["new request"])).rejects.toThrow(
        "embedding_session_closed",
      );
    }
    expect(retired).toHaveLength(2);
  } finally {
    Worker.prototype.terminate = original;
    await Promise.all(retired.map((worker) => original.call(worker)));
  }
});

test("injected Potion close shares and retains failure until a new session loads", async () => {
  let closes = 0;
  let loads = 0;
  const provider = new PotionStaticEmbeddingProvider(potionConfig, async () => {
    loads++;
    return {
      embed: async () => [Array.from({ length: 256 }, () => 1)],
      close: async () => {
        closes++;
        throw new Error("session close refused");
      },
    };
  });
  await provider.embed(["first"]);
  const first = provider.close();
  const second = provider.close();
  const outcomes = await Promise.allSettled([first, second]);
  for (const outcome of outcomes) {
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected")
      expect(outcome.reason.message).toBe("session close refused");
  }
  await expect(provider.close()).rejects.toThrow("session close refused");
  expect(closes).toBe(1);
  await provider.embed(["second"]);
  expect(loads).toBe(2);
  await expect(provider.close()).rejects.toThrow("session close refused");
  expect(closes).toBe(2);
});

test("inline model engines reject missing offline models without a worker dependency", async () => {
  const { InlineTransformersProvider, createPotionStaticSession } =
    await import("../../../src/intelligence/retrieval/model-provider.ts");
  const inline = new InlineTransformersProvider({
    artifacts: {},
    dimensions: 2,
  });
  await expect(inline.embed(["query"])).rejects.toThrow(
    "embedding_model_not_configured",
  );
  await inline.close();
  await expect(
    createPotionStaticSession(
      { ...config, localPath: "/missing-ast-mcp-offline-model" },
      { verifyArtifacts: async () => {} },
    ),
  ).rejects.toThrow();
});

test("model requests use separate queue and initialization budgets before inference starts", async () => {
  const timers = clock!;
  const active = new ControlledWorker(undefined, false);
  const model = new ManagedModelSession(
    config,
    "transformers",
    false,
    250,
    url(""),
    () => active.asWorker(),
    5000,
    timers.timers,
  );
  try {
    const first = model.embed(["first"]);
    const second = model.embed(["second"]);
    expect(active.requests).toHaveLength(2);
    await timers.advanceBy(300);
    active.started(active.requests[0]!);
    await timers.advanceBy(5);
    active.finish(active.requests[0]!);
    await timers.advanceBy(300);
    active.started(active.requests[1]!);
    await timers.advanceBy(5);
    active.finish(active.requests[1]!);
    expect(await Promise.all([first, second])).toEqual([[[1, 0]], [[1, 0]]]);
    expect(timers.pending()).toBe(0);
  } finally {
    await closeControlled(model, [active]);
  }
  const stalledWorker = new ControlledWorker(undefined, false);
  const stalled = new ManagedModelSession(
    config,
    "transformers",
    false,
    500,
    url(""),
    () => stalledWorker.asWorker(),
    20,
    timers.timers,
  );
  try {
    const pending = stalled.embed(["query"]).catch((error: Error) => error);
    expect(stalledWorker.requests).toHaveLength(1);
    await timers.advanceBy(19);
    expect(timers.pending()).toBe(1);
    await timers.advanceBy(1);
    expect(await pending).toMatchObject({
      message: "embedding_worker_load_timeout",
    });
    await stalledWorker.retiring.promise;
  } finally {
    await closeControlled(stalled, [stalledWorker]);
  }
  expect(timers.pending()).toBe(0);
  // Keep the actual worker protocol boundary covered independently of fake time.
  const duplicate = session(
    'parentPort.postMessage({id:request.id,type:"started"});',
  );
  try {
    await expect(duplicate.embed(["query"])).rejects.toThrow(
      "embedding_worker_protocol_error",
    );
  } finally {
    await duplicate.close();
  }
});

test("embedding retries wait for retirement before spending their next inference attempt", async () => {
  const timers = clock!;
  const first = new ControlledWorker();
  const second = new ControlledWorker((request, worker) =>
    worker.finish(request),
  );
  const retryQueued = Promise.withResolvers<void>();
  let creates = 0;
  let attempts = 0;
  const model = new ManagedModelSession(
    config,
    "transformers",
    false,
    20,
    url(""),
    () => (++creates === 1 ? first : second).asWorker(),
    500,
    timers.timers,
  );
  const pool = new EmbeddingWorkerPool(config, () => ({
    config,
    embed: (texts) => {
      attempts++;
      const pending = model.embed(texts);
      if (attempts === 2) retryQueued.resolve();
      return pending;
    },
    close: () => model.close(),
  }));
  try {
    let settled = false;
    const result = pool.embed("query", { retries: 1 }).finally(() => {
      settled = true;
    });
    void result.catch(() => {});
    await first.firstStarted.promise;
    await timers.advanceBy(20);
    await first.retiring.promise;
    await retryQueued.promise;
    expect(creates).toBe(1);
    expect(attempts).toBe(2);
    expect(first.requests).toHaveLength(1);
    await timers.advanceBy(499);
    expect(settled).toBeFalse();
    expect(creates).toBe(1);
    expect(attempts).toBe(2);
    first.retirement.resolve(0);
    expect(await result).toEqual([1, 0]);
    expect(creates).toBe(2);
    expect(attempts).toBe(2);
    expect(second.requests).toHaveLength(1);
    const closing = pool.close();
    await second.retiring.promise;
    expect(second.terminateCalls).toBe(1);
    second.retirement.resolve(0);
    await closing;
    expect(timers.pending()).toBe(0);
  } finally {
    await closeControlled(model, [first, second]);
    await pool.close();
  }
});

test("inline provider initialization finishes before any inference begins", async () => {
  const { InlineTransformersProvider, InlinePotionProvider } =
    await import("../../../src/intelligence/retrieval/model-provider.ts");
  let inference = 0;
  const transformer = new InlineTransformersProvider(
    config,
    true,
    async () => async () => {
      inference++;
      return { data: [1, 0] };
    },
  );
  const potion = new InlinePotionProvider(potionConfig, async () => ({
    embed: async () => {
      inference++;
      return [Array.from({ length: 256 }, () => 1)];
    },
  }));
  await Promise.all([transformer.initialize(), potion.initialize()]);
  expect(inference).toBe(0);
  await transformer.embed(["query"]);
  await potion.embed(["query"]);
  expect(inference).toBe(2);
  await Promise.all([transformer.close(), potion.close()]);
});

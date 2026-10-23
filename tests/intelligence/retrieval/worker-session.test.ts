import { describe, expect, test } from "bun:test";
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
import { ManagedModelSession } from "../../../src/intelligence/retrieval/worker-session.ts";

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

describe("isolated model session lifecycle", () => {
  test("bounds close while a native thread cannot finish termination", async () => {
    const active = new Worker(url(""));
    const terminate = active.terminate.bind(active);
    let finish!: (code: number) => void;
    active.terminate = () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      });
    const model = new ManagedModelSession(
      config,
      "transformers",
      false,
      20,
      url(""),
      () => active,
    );
    const pending = model
      .embed(["query"])
      .catch((error: Error) => error.message);
    try {
      await expect(model.close()).rejects.toThrow(
        "embedding_worker_retirement_timeout",
      );
      expect(await pending).toBe("embedding_session_closed");
      finish(0);
      await Bun.sleep(1);
    } finally {
      await terminate();
    }
  });

  test("quarantines failed termination and reports repeated close failures", async () => {
    const active = new Worker(url(""));
    const terminate = active.terminate.bind(active);
    active.terminate = () =>
      Promise.reject(new Error("termination unavailable"));
    const model = new ManagedModelSession(
      config,
      "transformers",
      false,
      100,
      url(""),
      () => active,
    );
    const pending = model
      .embed(["query"])
      .catch((error: Error) => error.message);
    try {
      await expect(model.close()).rejects.toThrow("termination unavailable");
      await expect(model.close()).rejects.toThrow("termination unavailable");
      expect(await pending).toBe("embedding_session_closed");
    } finally {
      await terminate();
    }
  });

  test("bounds recovery admission and expires waiters while retirement remains pending", async () => {
    const active = new Worker(url(""));
    const terminate = active.terminate.bind(active);
    let retire!: (code: number) => void;
    active.terminate = () =>
      new Promise<number>((resolve) => {
        retire = resolve;
      });
    let creates = 0;
    const model = new ManagedModelSession(
      config,
      "transformers",
      false,
      10,
      url(""),
      () => {
        creates++;
        return active;
      },
      100,
    );
    try {
      await expect(model.embed(["stuck"])).rejects.toThrow(
        "embedding_worker_timeout",
      );
      const waiting = Array.from({ length: 128 }, () =>
        model.embed(["recovery"]).catch((error: Error) => error.message),
      );
      await expect(model.embed(["overflow"])).rejects.toThrow(
        "embedding_queue_full",
      );
      expect(await Promise.all(waiting)).toEqual(
        Array(128).fill("embedding_worker_retirement_timeout"),
      );
      expect(creates).toBe(1);
      const closingWaiter = model
        .embed(["close"])
        .catch((error: Error) => error.message);
      const closing = model.close().catch((error: Error) => error.message);
      expect(await closingWaiter).toBe("embedding_session_closed");
      retire(await terminate());
      await closing;
    } finally {
      await terminate();
    }
  });

  test("rejects bounded recovery callers when physical retirement fails", async () => {
    const active = new Worker(url(""));
    const terminate = active.terminate.bind(active);
    let failRetirement!: (error: Error) => void;
    active.terminate = () =>
      new Promise<number>((_resolve, reject) => {
        failRetirement = reject;
      });
    const model = new ManagedModelSession(
      config,
      "transformers",
      false,
      10,
      url(""),
      () => active,
      200,
    );
    try {
      await expect(model.embed(["stuck"])).rejects.toThrow(
        "embedding_worker_timeout",
      );
      const recovery = model.embed(["recovery"]);
      failRetirement(new Error("termination failed"));
      await expect(recovery).rejects.toThrow("embedding_worker_retiring");
      await expect(model.embed(["later"])).rejects.toThrow(
        "embedding_worker_retiring",
      );
      await expect(model.close()).rejects.toThrow("termination failed");
    } finally {
      await terminate();
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

  test("correlates parallel requests, ignores stale IDs, and reuses the live worker", async () => {
    const model = session(
      "parentPort.postMessage({ id: 99999, vectors: [] }); setTimeout(() => parentPort.postMessage({ id: request.id, vectors: request.texts.map(() => [request.id, 1]) }), request.id === 1 ? 25 : 0);",
    );
    try {
      expect(
        await Promise.all([model.embed(["one"]), model.embed(["two"])]),
      ).toEqual([[[1, 1]], [[2, 1]]]);
      expect(await model.embed(["three"])).toEqual([[3, 1]]);
    } finally {
      await model.close();
    }
    await model.close();
    await expect(model.embed(["closed"])).rejects.toThrow(
      "embedding_session_closed",
    );
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
    const model = session(
      'if (request.texts[0] === "hang") { while (true) {} } else parentPort.postMessage({ id: request.id, vectors: [[1, 0]] });',
      100,
    );
    const one = model.embed(["hang"]).catch((error: Error) => error.message);
    const two = model.embed(["queued"]).catch((error: Error) => error.message);
    expect(await one).toBe("embedding_worker_timeout");
    expect(await two).toBe("embedding_worker_timeout");
    // Retirement finishes before another native model may be admitted.
    for (let attempt = 0; ; attempt++) {
      try {
        expect(await model.embed(["healthy"])).toEqual([[1, 0]]);
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "embedding_worker_retiring" ||
          attempt > 50
        )
          throw error;
        await Bun.sleep(5);
      }
    }
    await model.close();
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
  const model = new ManagedModelSession(
    config,
    "transformers",
    false,
    25,
    url(
      'globalThis.tail = (globalThis.tail ?? Promise.resolve()).then(async () => { await new Promise(resolve => setTimeout(resolve, 40)); parentPort.postMessage({id:request.id,type:"started"}); await new Promise(resolve => setTimeout(resolve,5)); parentPort.postMessage({id:request.id,vectors:[[1,0]]}); });',
      false,
    ),
    undefined,
    250,
  );
  try {
    expect(
      await Promise.all([model.embed(["first"]), model.embed(["second"])]),
    ).toEqual([[[1, 0]], [[1, 0]]]);
  } finally {
    await model.close();
  }
  const stalled = new ManagedModelSession(
    config,
    "transformers",
    false,
    5,
    url("", false),
    undefined,
    20,
  );
  await expect(stalled.embed(["query"])).rejects.toThrow(
    "embedding_worker_load_timeout",
  );
  await stalled.close();
  const duplicate = session(
    'parentPort.postMessage({id:request.id,type:"started"});',
  );
  await expect(duplicate.embed(["query"])).rejects.toThrow(
    "embedding_worker_protocol_error",
  );
  await duplicate.close();
});

test("embedding retries wait for retirement before spending their next inference attempt", async () => {
  let creates = 0;
  let release!: () => void;
  const model = new ManagedModelSession(
    config,
    "transformers",
    false,
    20,
    url(""),
    () => {
      const active = new Worker(
        url(
          ++creates === 1
            ? "while(true){}"
            : "parentPort.postMessage({id:request.id,vectors:[[1,0]]});",
        ),
      );
      if (creates === 1) {
        const terminate = active.terminate.bind(active);
        active.terminate = () =>
          new Promise<number>((resolve, reject) => {
            release = () => {
              void terminate().then(resolve, reject);
            };
          });
      }
      return active;
    },
    500,
  );
  const pool = new EmbeddingWorkerPool(config, () => ({
    config,
    embed: (texts) => model.embed(texts),
    close: () => model.close(),
  }));
  const result = pool.embed("query", { retries: 1 });
  for (let attempt = 0; !release && attempt < 100; attempt++)
    await Bun.sleep(2);
  expect(creates).toBe(1);
  release();
  expect(await result).toEqual([1, 0]);
  expect(creates).toBe(2);
  await pool.close();
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

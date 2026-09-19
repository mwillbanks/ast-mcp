import { expect, test } from "bun:test";

import type { ResolvedConfig } from "../src/config.ts";
import { dynamicWorkerStats } from "../src/intelligence/languages/dynamic/analyzer.ts";
import { IntelligenceSourceDispatcher } from "../src/intelligence/lifecycle/dispatcher.ts";
import { IntelligenceRuntime } from "../src/intelligence/lifecycle/service.ts";
import {
  type EmbeddingModelConfig,
  EmbeddingModelConfigSchema,
  type EmbeddingProvider,
} from "../src/intelligence/retrieval/index.ts";
import { createServer } from "../src/server.ts";

function resolvedConfig(modelId: string): ResolvedConfig {
  const embedding = EmbeddingModelConfigSchema.parse({
    artifacts: {},
    batchSize: 1,
    dimensions: 2,
    maxQueue: 4,
    modelId,
    revision: "fixture-revision",
    workers: 1,
  });
  return {
    intelligence: {
      federation: { enabled: false },
      generation: { enabled: false, provider: null },
      retrieval: { embedding, semantic: true },
      storage: { placement: { kind: "global" } },
    },
  } as ResolvedConfig;
}

test("createServer drains its lifecycle-owned workers on close", async () => {
  const closeOptions: Array<{ drain?: boolean } | undefined> = [];
  const dispatcher = new IntelligenceSourceDispatcher({
    async parse() {
      throw new Error("unused");
    },
  });
  const server = createServer({
    dispatcher,
    parserPool: {
      async close(options) {
        closeOptions.push(options);
      },
      async parse() {
        throw new Error("unused");
      },
    },
  });
  expect(
    (
      await dispatcher.analyze({
        filePath: "server-lifecycle.py",
        source: "def server_lifecycle():\n    return True\n",
      })
    )?.group,
  ).toBe("dynamic");
  expect(dynamicWorkerStats().active).toBeTrue();
  await server.close();
  await server.close();
  expect(closeOptions).toEqual([{ drain: true }]);
  expect(dynamicWorkerStats().active).toBeFalse();
});

test("closing one dispatcher preserves another session's worker request", async () => {
  const parse = async () => {
    throw new Error("unused_parser");
  };
  const first = new IntelligenceSourceDispatcher({ parse });
  const second = new IntelligenceSourceDispatcher({ parse });
  try {
    const pending = second.analyze({
      filePath: "session.py",
      source: "def session_marker():\n    return True\n",
    });
    await first.close();
    expect((await pending)?.group).toBe("dynamic");
    expect(
      (
        await second.analyze({
          filePath: "continued.py",
          source: "def continued_marker():\n    return True\n",
        })
      )?.group,
    ).toBe("dynamic");
  } finally {
    await first.close();
    await second.close();
  }
});

test("a new session waits for final-session worker shutdown before dispatching", async () => {
  const parse = async () => {
    throw new Error("unused_parser");
  };
  const first = new IntelligenceSourceDispatcher({ parse });
  const pending = first.analyze({
    filePath: "closing-session.py",
    source: Array.from(
      { length: 200 },
      (_, index) => `def closing_${index}():\n    return ${index}\n`,
    ).join("\n"),
  });
  const closing = first.close();
  await Bun.sleep(0);

  const next = new IntelligenceSourceDispatcher({ parse });
  try {
    const nextAnalysis = next.analyze({
      filePath: "new-session.py",
      source: "def new_session():\n    return True\n",
    });
    expect((await pending)?.group).toBe("dynamic");
    await closing;
    expect((await nextAnalysis)?.group).toBe("dynamic");
    expect(dynamicWorkerStats().active).toBeTrue();
  } finally {
    await first.close();
    await next.close();
  }
  expect(dynamicWorkerStats().active).toBeFalse();
});

test("runtime drains embeddings and retires old model pools within its bound", async () => {
  let selectedModel = "fixture/model-a";
  let release!: () => void;
  let started!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const closed: string[] = [];
  class Provider implements EmbeddingProvider {
    constructor(readonly config: EmbeddingModelConfig) {}
    async close() {
      closed.push(this.config.modelId);
    }
    async embed(texts: readonly string[]) {
      if (this.config.modelId === "fixture/model-a") {
        started();
        await releasePromise;
      }
      return texts.map(() => [1, 0]);
    }
  }
  const runtime = new IntelligenceRuntime({
    config: async () => resolvedConfig(selectedModel),
    embeddingProviderFactory: (config) => new Provider(config),
  });

  const pending = runtime.queryVector("first", true);
  await startedPromise;
  const closing = runtime.close();
  expect(closed).toEqual([]);
  release();
  await pending;
  await closing;
  expect(closed).toEqual(["fixture/model-a"]);

  const retired: string[] = [];
  const rotating = new IntelligenceRuntime({
    config: async () => resolvedConfig(selectedModel),
    embeddingProviderFactory: (config) => ({
      async close() {
        retired.push(config.modelId);
      },
      config,
      async embed(texts) {
        return texts.map(() => [1, 0]);
      },
    }),
  });
  for (const suffix of ["a", "b", "c"]) {
    selectedModel = `fixture/model-${suffix}`;
    await rotating.queryVector(suffix, true);
  }
  await Bun.sleep(0);
  expect(retired).toContain("fixture/model-a");
  await rotating.close();
  expect(new Set(retired)).toEqual(
    new Set(["fixture/model-a", "fixture/model-b", "fixture/model-c"]),
  );
});

test("runtime close drains an active index operation before workers close", async () => {
  let release!: () => void;
  let started!: () => void;
  const releaseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startedGate = new Promise<void>((resolve) => {
    started = resolve;
  });
  let dispatcherCloses = 0;
  let parserCloses = 0;
  const runtime = new IntelligenceRuntime({
    config: async () => resolvedConfig("fixture/index-operation"),
    dispatcher: {
      async analyze() {
        throw new Error("unused");
      },
      async close() {
        dispatcherCloses += 1;
      },
    },
    parserPool: {
      async close() {
        parserCloses += 1;
      },
      async parse() {
        throw new Error("unused");
      },
    },
  });

  const pending = runtime.runIndexOperation(undefined, async () => {
    started();
    await releaseGate;
    return "published";
  });
  await startedGate;
  const closing = runtime.close();
  await Bun.sleep(0);
  expect(dispatcherCloses).toBe(0);
  expect(parserCloses).toBe(0);

  release();
  expect(await pending).toBe("published");
  await closing;
  expect(dispatcherCloses).toBe(1);
  expect(parserCloses).toBe(1);
});

test("runtime close drains admitted configuration before provider creation", async () => {
  let releaseConfig!: () => void;
  let configStarted!: () => void;
  const configGate = new Promise<void>((resolve) => {
    releaseConfig = resolve;
  });
  const configStartedGate = new Promise<void>((resolve) => {
    configStarted = resolve;
  });
  let providerCloses = 0;
  const runtime = new IntelligenceRuntime({
    config: async () => {
      configStarted();
      await configGate;
      return resolvedConfig("fixture/deferred");
    },
    embeddingProviderFactory: (config) => ({
      async close() {
        providerCloses += 1;
      },
      config,
      async embed(texts) {
        return texts.map(() => [1, 0]);
      },
    }),
  });

  const pending = runtime.queryVector("deferred", true);
  await configStartedGate;
  const closing = runtime.close();
  await Bun.sleep(0);
  expect(providerCloses).toBe(0);

  releaseConfig();
  expect(await pending).toMatchObject({ vector: [1, 0] });
  await closing;
  expect(providerCloses).toBe(1);
  await expect(runtime.queryVector("closed", true)).rejects.toThrow(
    "intelligence_runtime_closed",
  );
});

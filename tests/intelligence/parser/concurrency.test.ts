import { beforeEach, describe, expect, test } from "bun:test";

import {
  type MockTime,
  createMockTime,
  deferred,
} from "../../support/mock-time.ts";
let mockTime: MockTime;
beforeEach(() => {
  mockTime = createMockTime();
});
import { resolve } from "node:path";

import {
  LanguageRegistry,
  ParserWorkerPool,
  parseSource,
} from "../../../src/intelligence/parser/index.ts";
import { createParserTransport } from "../../../src/intelligence/parser/transport.ts";

const request = { languageId: "typescript", source: "export const value = 1;" };

describe("parser transport and registration races", () => {
  test("settles accepted jobs after synchronous constructor and initialization failures", async () => {
    for (const failure of ["constructor", "initialize"]) {
      const pool = new ParserWorkerPool({
        minWorkers: 0,
        maxWorkers: 1,
        workerFactory: () => {
          if (failure === "constructor") throw new Error("construction failed");
          return {
            postMessage() {
              throw new Error("initialization failed");
            },
            terminate() {},
          } as unknown as Worker;
        },
      });
      await expect(pool.parse(request)).rejects.toMatchObject({
        code: "worker-error",
      });
      expect(pool.stats).toMatchObject({
        outstandingBytes: 0,
        queued: 0,
        workers: 0,
        state: "closed",
      });
      await pool.close({ drain: true });
    }
    const prewarmed = new ParserWorkerPool({
      minWorkers: 1,
      workerFactory: () => {
        throw new Error("startup failed");
      },
    });
    expect(prewarmed.stats.state).toBe("closed");
    await prewarmed.close();
  });

  test("settles parse message failures and ignores events from retired workers", async () => {
    const transports: Array<{
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: ((event: ErrorEvent) => void) | null;
      postMessage(message: { type: string; id?: number }): void;
      terminate(): void;
    }> = [];
    let terminations = 0;
    const pool = new ParserWorkerPool({
      minWorkers: 0,
      maxWorkers: 1,
      workerFactory: () => {
        const worker = {
          onmessage: null as ((event: MessageEvent) => void) | null,
          onerror: null as ((event: ErrorEvent) => void) | null,
          postMessage(message: { type: string; id?: number }) {
            if (message.type === "initialize")
              queueMicrotask(() =>
                worker.onmessage?.({
                  data: { type: "ready", ok: true },
                } as MessageEvent),
              );
            else if (transports.length === 1) throw new Error("post failed");
            else
              queueMicrotask(() =>
                worker.onmessage?.({
                  data: {
                    type: "result",
                    ok: true,
                    id: message.id,
                    facts: parseSource(request),
                  },
                } as MessageEvent),
              );
          },
          terminate() {
            terminations++;
          },
        };
        transports.push(worker);
        return worker as unknown as Worker;
      },
    });
    await expect(pool.parse(request)).rejects.toMatchObject({
      code: "worker-error",
      retryable: true,
    });
    const recovered = pool.parse(request);
    transports[0]!.onerror?.({ message: "late failure" } as ErrorEvent);
    transports[0]!.onmessage?.({
      data: { type: "ready", ok: false },
    } as MessageEvent);
    expect((await recovered).symbols[0]?.name).toBe("value");
    expect(terminations).toBe(1);
    expect(pool.stats.outstandingBytes).toBe(0);
    await pool.close();
  });

  test("atomically publishes dynamic grammars after asynchronous validation", async () => {
    const bindings = await Array.fromAsync(
      new Bun.Glob("node_modules/@ast-grep/napi-*/ast-grep-napi.*.node").scan({
        cwd: process.cwd(),
        onlyFiles: true,
      }),
    );
    const libraryPath = resolve(bindings[0]!);
    const sha256 = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(libraryPath).arrayBuffer())
      .digest("hex");
    const descriptor = {
      astGrepLanguage: "Fixture",
      dynamicAsset: { libraryPath, sha256 },
      extensions: [".fixture"],
      grammarVersion: "fixture",
      languageId: "fixture-concurrent",
    };
    const implementation = {
      callResolution: false,
      embeddedLanguages: false,
      exportResolution: false,
      importResolution: false,
      inheritanceResolution: false,
      match: true,
      parse: true,
      rewrite: true,
      structuralRead: true,
      symbolExtraction: false,
    };
    const duplicate = new LanguageRegistry(() => {});
    const results = await Promise.allSettled([
      duplicate.addDynamic(descriptor, implementation),
      duplicate.addDynamic(descriptor, implementation),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: {
        message: "Parser language is already registered: fixture-concurrent",
      },
    });
    const parsing = new LanguageRegistry(() => {});
    const registering = parsing.addDynamic(descriptor, implementation);
    parsing.registerDynamicGrammars();
    await expect(registering).rejects.toThrow("before parsing");
    expect(
      parsing
        .list()
        .some((entry) => entry.languageId === descriptor.languageId),
    ).toBe(false);

    const registrar = () => {};
    const sealed = new LanguageRegistry(registrar);
    sealed.registerDynamicGrammars();
    const lateRegistry = new LanguageRegistry(registrar);
    await expect(
      lateRegistry.addDynamic(descriptor, implementation),
    ).rejects.toThrow("before parsing");
    expect(lateRegistry.dynamicManifest().entries).toHaveLength(0);

    const sharedRegistrar = () => {};
    const validating = new LanguageRegistry(sharedRegistrar);
    const pending = validating.addDynamic(descriptor, implementation);
    new LanguageRegistry(sharedRegistrar).registerDynamicGrammars();
    await expect(pending).rejects.toThrow("before parsing");
    expect(validating.dynamicManifest().entries).toHaveLength(0);

    // Registration failures do not seal the backend or prevent a later retry.
    let calls = 0;
    const retrying = new LanguageRegistry(() => {
      if (++calls === 1) throw new Error("native startup failed");
    });
    expect(() => retrying.registerDynamicGrammars()).toThrow(
      "native startup failed",
    );
    await retrying.addDynamic(descriptor, implementation);
    retrying.registerDynamicGrammars();
    retrying.registerDynamicGrammars();
    expect(calls).toBe(2);
  });
});

describe("parser physical retirement", () => {
  const request = { languageId: "typescript", source: "const recovered = 1;" };
  const url = (code: string) =>
    "data:text/javascript," +
    encodeURIComponent(
      'import { parentPort } from "node:worker_threads"; ' + code,
    );

  test("the production transport forwards crashes and unexpected exits", async () => {
    for (const [code, message] of [
      ['throw new Error("transport crash")', "transport crash"],
      ["process.exit(7)", "code 7"],
    ]) {
      const worker = createParserTransport(url(code!));
      try {
        const failure = await new Promise<string>((resolve) => {
          worker.onerror = (event) => resolve(event.message);
        });
        expect(failure).toContain(message!);
      } finally {
        await Promise.resolve(worker.terminate());
      }
    }
  });

  function factory(
    terminate: () => Promise<number>,
    counts: { created: number },
    dispatched?: () => void,
  ) {
    return () => {
      const ordinal = ++counts.created;
      const worker = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null,
        postMessage(message: { type: string; id?: number }) {
          if (message.type === "initialize")
            queueMicrotask(() =>
              worker.onmessage?.({
                data: { type: "ready", ok: true },
              } as MessageEvent),
            );
          else {
            dispatched?.();
            if (ordinal > 1)
              queueMicrotask(() =>
                worker.onmessage?.({
                  data: {
                    type: "result",
                    ok: true,
                    id: message.id,
                    facts: parseSource(request),
                  },
                } as MessageEvent),
              );
          }
        },
        terminate,
      };
      return worker as unknown as Worker;
    };
  }

  test("replacement waits for physical retirement instead of exceeding the worker bound", async () => {
    let finish!: (code: number) => void;
    const retirement = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const counts = { created: 0 };
    const dispatched = deferred<void>();
    const pool = new ParserWorkerPool({
      minWorkers: 0,
      maxWorkers: 1,
      defaultTimeoutMs: 1000,
      workerFactory: factory(
        () => (counts.created === 1 ? retirement : Promise.resolve(0)),
        counts,
        () => dispatched.resolve(),
      ),
    });
    const controller = new AbortController();
    const first = pool
      .parse(request, { signal: controller.signal })
      .catch((error: unknown) => error);
    await dispatched.promise;
    controller.abort();
    expect(await first).toMatchObject({ code: "aborted" });
    const next = pool.parse(request);
    expect(pool.stats.queued).toBe(1);
    expect(counts.created).toBe(1);
    finish(0);
    expect((await next).symbols[0]?.name).toBe("recovered");
    expect(counts.created).toBe(2);
    await pool.close();
  });

  test("close reports failed or stalled retirement and retains ownership", async () => {
    const failing = new ParserWorkerPool({
      minWorkers: 1,
      workerFactory: factory(
        () => Promise.reject(new Error("retirement failed")),
        { created: 0 },
      ),
    });
    await expect(failing.close()).rejects.toThrow("retirement failed");
    await expect(failing.close()).rejects.toThrow("retirement failed");
    const time = mockTime;
    let finish!: (code: number) => void;
    const gate = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const stuck = new ParserWorkerPool({
      minWorkers: 1,
      defaultTimeoutMs: 20,
      workerFactory: factory(() => gate, { created: 0 }),
    });
    try {
      const closing = stuck.close().catch((error: unknown) => error);
      await time.advanceBy(20);
      expect(await closing).toMatchObject({
        message: "Parser worker retirement timed out",
      });
      finish(0);
      await stuck.close();
    } finally {
      finish(0);
      await stuck.close();
      time.dispose();
    }
  });
});

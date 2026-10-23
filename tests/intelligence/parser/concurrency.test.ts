import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  LanguageRegistry,
  ParserWorkerPool,
  parseSource,
} from "../../../src/intelligence/parser/index.ts";

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
  });
});

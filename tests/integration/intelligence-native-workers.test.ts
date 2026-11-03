import { expect, test } from "bun:test";

import { EmbeddingModelConfigSchema } from "../../src/intelligence/retrieval/types.ts";
import { ManagedModelSession } from "../../src/intelligence/retrieval/worker-session.ts";
const config = EmbeddingModelConfigSchema.parse({
  artifacts: {},
  dimensions: 2,
  batchSize: 1,
});
import {
  ParserError,
  ParserWorkerPool,
} from "../../src/intelligence/parser/index.ts";
import { createParserTransport } from "../../src/intelligence/parser/transport.ts";
const expectParserCode = async (
  promise: Promise<unknown>,
  code: ParserError["code"],
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected parser request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ParserError);
    expect((error as ParserError).code).toBe(code);
  }
};

const url = (code: string) =>
  "data:text/javascript," +
  encodeURIComponent(
    'import { parentPort } from "node:worker_threads"; ' + code,
  );
test("the production transport waits for physical worker stop", async () => {
  const worker = createParserTransport(
    url(
      "const counter = new Int32Array(new SharedArrayBuffer(4)); parentPort.postMessage(counter); while (true) Atomics.add(counter, 0, 1);",
    ),
  );
  const counter = await new Promise<Int32Array>((resolve) => {
    worker.onmessage = (event) => resolve(event.data);
  });
  await Promise.resolve(worker.terminate());
  const stopped = Atomics.load(counter, 0);
  await Bun.sleep(10);
  expect(Atomics.load(counter, 0)).toBe(stopped);
});

test("timeouts replace a worker and later jobs succeed", async () => {
  const pool = new ParserWorkerPool({
    maxOutstandingBytes: 512 * 1024,
    maxSourceBytes: 512 * 1024,
    maxWorkers: 1,
    minWorkers: 0,
  });
  try {
    const largeSource = Array.from(
      { length: 12_000 },
      (_, index) => `const value${index} = ${index};`,
    ).join("\n");
    await expectParserCode(
      pool.parse(
        { languageId: "typescript", source: largeSource },
        { timeoutMs: 1 },
      ),
      "timeout",
    );
    const facts = await pool.parse(
      { languageId: "typescript", source: "export function ready() {}" },
      { timeoutMs: 10_000 },
    );
    expect(facts.symbols.map((symbol) => symbol.name)).toContain("ready");
  } finally {
    await pool.close({ drain: true });
  }
});

test("correlates parallel requests, ignores stale IDs, and reuses the live worker", async () => {
  const model = new ManagedModelSession(
    config,
    "transformers",
    false,
    500,
    new URL(
      "data:text/javascript," +
        encodeURIComponent(
          'import { parentPort } from "node:worker_threads"; let first; const reply = request => parentPort.postMessage({id:request.id,vectors:request.texts.map(() => [request.id,1])}); parentPort.on("message", request => {' +
            'parentPort.postMessage({id:request.id,type:"started"}); parentPort.postMessage({id:99999,vectors:[]}); if(request.id===1) {first=request;return;} reply(request); if(first) {reply(first);first=undefined;}' +
            "});",
        ),
    ),
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

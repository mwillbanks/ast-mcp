import { expect, test } from "bun:test";

import {
  ParserWorkerPool,
  parseSource,
} from "../../../src/intelligence/parser/index.ts";
import { createParserTransport } from "../../../src/intelligence/parser/transport.ts";

const request = { languageId: "typescript", source: "const recovered = 1;" };
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
        else if (ordinal > 1)
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
  const pool = new ParserWorkerPool({
    minWorkers: 0,
    maxWorkers: 1,
    defaultTimeoutMs: 1000,
    workerFactory: factory(
      () => (counts.created === 1 ? retirement : Promise.resolve(0)),
      counts,
    ),
  });
  const controller = new AbortController();
  const first = pool
    .parse(request, { signal: controller.signal })
    .catch((error: unknown) => error);
  await Bun.sleep(1);
  controller.abort();
  expect(await first).toMatchObject({ code: "aborted" });
  const next = pool.parse(request);
  await Bun.sleep(5);
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
  let finish!: (code: number) => void;
  const gate = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const stuck = new ParserWorkerPool({
    minWorkers: 1,
    defaultTimeoutMs: 20,
    workerFactory: factory(() => gate, { created: 0 }),
  });
  await expect(stuck.close()).rejects.toThrow("retirement timed out");
  finish(0);
  await stuck.close();
});

import { createHash } from "node:crypto";

import type { SyntaxFacts } from "../intelligence/parser/index.ts";

const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 512;
const MAX_IDLE_WORKERS = 4;

type CachedParse = { payload: Buffer; transferredBytes: number };

const idleWorkers = new Map<Worker, { fail: () => void; grammar?: string }>();

export function parseCacheKey(
  scope: string,
  languageId: string,
  source: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([scope, languageId]))
    .update(source)
    .digest("hex");
}

export class ParseFactsCache {
  readonly #entries = new Map<string, CachedParse>();
  #bytes = 0;

  constructor(
    readonly maxBytes = MAX_CACHE_BYTES,
    readonly maxEntries = MAX_CACHE_ENTRIES,
  ) {}

  get(key: string): CachedParse | undefined {
    const entry = this.#entries.get(key);
    if (entry) {
      this.#entries.delete(key);
      this.#entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, facts: SyntaxFacts, transferredBytes: number): void {
    const json = JSON.stringify(facts);
    const bytes = Buffer.byteLength(json);
    if (bytes > this.maxBytes || this.maxEntries < 1) return;
    this.#remove(key);
    while (
      this.#bytes + bytes > this.maxBytes ||
      this.#entries.size >= this.maxEntries
    ) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#remove(oldest);
    }

    // Each entry owns its exact-size allocation instead of retaining a shared slab.
    const payload = Buffer.allocUnsafeSlow(bytes);
    payload.write(json);
    this.#entries.set(key, { payload, transferredBytes });
    this.#bytes += payload.buffer.byteLength;
  }

  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (entry) this.#bytes -= entry.payload.buffer.byteLength;
    this.#entries.delete(key);
  }
}

export const parsedFacts = new ParseFactsCache();

export function acquireWorker(factory: () => Worker, grammar?: string): Worker {
  const entry = [...idleWorkers].find(([, slot]) => slot.grammar === grammar);
  if (!entry) return factory();
  const [worker, { fail }] = entry;
  idleWorkers.delete(worker);
  worker.removeEventListener("error", fail);
  worker.ref();
  return worker;
}

export function releaseWorker(worker: Worker, grammar?: string): void {
  if (idleWorkers.size >= MAX_IDLE_WORKERS) {
    const stale = [...idleWorkers].find(([, slot]) => slot.grammar !== grammar);
    if (!stale) {
      worker.terminate();
      return;
    }
    const [previous, { fail }] = stale;
    idleWorkers.delete(previous);
    previous.removeEventListener("error", fail);
    previous.terminate();
  }
  const fail = () => {
    idleWorkers.delete(worker);
    worker.terminate();
  };
  idleWorkers.set(worker, { fail, grammar });
  worker.addEventListener("error", fail, { once: true });
  worker.unref();
}

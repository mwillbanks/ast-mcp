import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { addAbortSignal, PassThrough } from "node:stream";

import { ParserError, ParserWorkerPool } from "../../src/intelligence/parser";
import {
  hashFilesSafely,
  inspectWorkspaceFileCapabilitiesSafely,
  readFilesSafely,
} from "../../src/runtime/file-read";
import { sha256File } from "../../src/runtime/hash";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function fixture(extension = "txt", source = "content\n") {
  const folder = await mkdtemp(
    path.join(path.resolve(import.meta.dir, "../.."), ".tmp-read-abort-"),
  );
  folders.push(folder);
  const filePath = path.join(folder, `value.${extension}`);
  await writeFile(filePath, source);
  return filePath;
}

function stalledStream() {
  const opened = Promise.withResolvers<PassThrough>();
  const streams: PassThrough[] = [];
  const spy = spyOn(fs, "createReadStream").mockImplementation((_, options) => {
    const signal = typeof options === "object" ? options.signal : undefined;
    expect(signal).toBeDefined();
    const stream = addAbortSignal(signal!, new PassThrough());
    streams.push(stream);
    opened.resolve(stream);
    return stream as unknown as ReturnType<typeof fs.createReadStream>;
  });
  return { opened: opened.promise, streams, restore: () => spy.mockRestore() };
}

test("hash stream cancellation destroys a stalled stream", async () => {
  const filePath = await fixture();
  const stalled = stalledStream();
  try {
    const controller = new AbortController();
    const pending = sha256File(filePath, controller.signal);
    const stream = await stalled.opened;
    controller.abort(new Error("cancelled read"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.destroyed).toBe(true);
  } finally {
    stalled.restore();
  }
});

for (const kind of ["read", "hash", "capabilities"] as const)
  test(`${kind} deadline rejects stalled I/O and destroys every stream`, async () => {
    const filePath = await fixture();
    const stalled = stalledStream();
    try {
      const options = { timeoutMs: 30 };
      const operation =
        kind === "read"
          ? readFilesSafely([{ filePath, mode: "text" }], options)
          : kind === "hash"
            ? hashFilesSafely([filePath], options)
            : inspectWorkspaceFileCapabilitiesSafely([filePath], options);
      await stalled.opened;
      await expect(operation).rejects.toMatchObject({
        code: "timeout",
        retryable: true,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stalled.streams.length).toBeGreaterThan(0);
      expect(stalled.streams.every((stream) => stream.destroyed)).toBe(true);
      const count = stalled.streams.length;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stalled.streams).toHaveLength(count);
    } finally {
      stalled.restore();
    }
  });

for (const kind of ["read", "capabilities"] as const)
  test(`${kind} cancels a stalled parser while the event loop stays responsive`, async () => {
    const filePath = await fixture("ts", "export const value = 1;\n");
    const started = Promise.withResolvers<AbortSignal>();
    const parse = spyOn(ParserWorkerPool.prototype, "parse").mockImplementation(
      (_, options) =>
        new Promise((_, reject) => {
          const signal = options?.signal;
          if (!signal) throw new Error("Parser cancellation signal missing");
          started.resolve(signal);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const close = spyOn(ParserWorkerPool.prototype, "close");
    try {
      const options = { timeoutMs: 100 };
      const operation =
        kind === "read"
          ? readFilesSafely([{ filePath, mode: "text" }], options)
          : inspectWorkspaceFileCapabilitiesSafely([filePath], options);
      const signal = await started.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(signal.aborted).toBe(false);
      await expect(operation).rejects.toMatchObject({ code: "timeout" });
      expect(signal.aborted).toBe(true);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
      close.mockRestore();
    }
  });

test("oversized sources keep bounded text reads without parser jobs", async () => {
  const filePath = await fixture("ts", "//" + "x".repeat(2 * 1024 * 1024));
  const parse = spyOn(ParserWorkerPool.prototype, "parse");
  try {
    const [result] = await readFilesSafely([
      { filePath, mode: "auto", maxBytes: 100 },
    ]);
    expect(result?.resolvedMode).toBe("text");
    expect(result?.capabilities?.parseStatus).toBe("unsupported");
    expect(result?.truncated).toBe(true);
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

for (const extension of ["json", "yaml"])
  test(`oversized ${extension} documents retain bounded text reads`, async () => {
    const filePath = await fixture(extension, "x".repeat(1024 * 1024 + 1));
    const [result] = await readFilesSafely([
      { filePath, mode: "auto", maxBytes: 100 },
    ]);
    expect(result?.resolvedMode).toBe("text");
    expect(result?.capabilities?.parseStatus).toBe("unsupported");
    expect(result?.truncated).toBe(true);
  });

test("parser infrastructure failures remain observable", async () => {
  const filePath = await fixture("ts", "export const value = 1;");
  const failure = new ParserError({
    code: "worker-error",
    message: "Worker failed",
    retryable: true,
  });
  const parse = spyOn(ParserWorkerPool.prototype, "parse").mockRejectedValue(
    failure,
  );
  try {
    await expect(readFilesSafely([{ filePath, mode: "text" }])).rejects.toBe(
      failure,
    );
  } finally {
    parse.mockRestore();
  }
});

test("pre-cancelled batches never open streams", async () => {
  const controller = new AbortController();
  const failure = new Error("cancelled before dispatch");
  controller.abort(failure);
  const options = { signal: controller.signal };
  const stalled = stalledStream();
  try {
    const filePath = "/not-opened.txt";
    for (const operation of [
      () => readFilesSafely([{ filePath }], options),
      () => hashFilesSafely([filePath], options),
      () => inspectWorkspaceFileCapabilitiesSafely([filePath], options),
      () => sha256File(filePath, controller.signal),
    ])
      await expect(operation()).rejects.toBe(failure);
    expect(stalled.streams).toHaveLength(0);
  } finally {
    stalled.restore();
  }
});

import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { readFileSafely } from "../../src/runtime/file-read";
import { FILE_HASH_CHUNK_BYTES, sha256Handle } from "../../src/runtime/hash";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function fixture(content: string) {
  const folder = await mkdtemp(
    path.join(path.resolve(import.meta.dir, "../.."), ".tmp-read-streaming-"),
  );
  folders.push(folder);
  const filePath = path.join(folder, "value.txt");
  await writeFile(filePath, content);
  return filePath;
}

function digest(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

test("text reads hash the complete file and collect Unicode CRLF lines in one stream", async () => {
  const content = "α\r\nβ🙂\r\n終";
  const filePath = await fixture(content);
  const original = fs.createReadStream;
  let fullStreams = 0;
  const streams = spyOn(fs, "createReadStream").mockImplementation(
    (input, options) => {
      if (
        input === filePath &&
        !(typeof options === "object" && options.end !== undefined)
      )
        fullStreams += 1;
      return original(input, options);
    },
  );
  try {
    const result = await readFileSafely({
      filePath,
      mode: "text",
      lines: [1, 3],
    });
    expect(result).toMatchObject({
      content: "β🙂\r\n終",
      hasMore: false,
      lines: { requested: [1, 3], returned: [1, 3] },
      sha256: digest(content),
      size: Buffer.byteLength(content),
      truncated: false,
    });
    expect(fullStreams).toBe(1);
  } finally {
    streams.mockRestore();
  }
});

for (const suffix of ["", "tail"])
  test(`text range ending at a stream boundary reports remaining bytes with suffix ${JSON.stringify(suffix)}`, async () => {
    const selected = "a".repeat(FILE_HASH_CHUNK_BYTES - 1) + "\n";
    const content = selected + suffix;
    const filePath = await fixture(content);
    const result = await readFileSafely({
      filePath,
      mode: "text",
      lines: [0, 1],
      maxBytes: FILE_HASH_CHUNK_BYTES,
    });
    expect(result.content).toBe(selected);
    expect(result.hasMore).toBe(suffix.length > 0);
    expect(result.truncated).toBe(false);
    expect(result.lines.returned).toEqual([0, 1]);
    expect(result.sha256).toBe(digest(content));
  });

test("selected Unicode remains intact across hashing chunks", async () => {
  const content = "a".repeat(FILE_HASH_CHUNK_BYTES - 5) + "\r\n🙂\r\n尾";
  const filePath = await fixture(content);
  const result = await readFileSafely({
    filePath,
    mode: "text",
    lines: [1, 2],
  });
  expect(result).toMatchObject({
    content: "🙂\r\n",
    hasMore: true,
    lines: { requested: [1, 2], returned: [1, 2] },
    sha256: digest(content),
    truncated: false,
  });
});

test("empty text retains an empty range and whole-file digest", async () => {
  const filePath = await fixture("");
  const result = await readFileSafely({ filePath, mode: "text" });
  expect(result).toMatchObject({
    content: "",
    hasMore: false,
    lines: { returned: [0, 0] },
    sha256: digest(""),
    size: 0,
    truncated: false,
  });
});

test("descriptor hashing observes its deadline and retains descriptor ownership", async () => {
  const filePath = await fixture("deadline");
  const handle = await open(filePath, "r");
  const deadline = AbortSignal.timeout(1);
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline);
  const original = handle.read.bind(handle);
  const read = spyOn(handle, "read").mockImplementation((async (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    const result = await original(buffer, offset, length, position);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return result;
  }) as typeof handle.read);
  try {
    await expect(sha256Handle(handle)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect((await handle.stat()).isFile()).toBe(true);
  } finally {
    timeout.mockRestore();
    read.mockRestore();
    await handle.close();
  }
});

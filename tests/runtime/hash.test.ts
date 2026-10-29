import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256Handle } from "../../src/runtime/hash";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function fixture() {
  const folder = await mkdtemp(
    path.join(path.resolve(import.meta.dir, "../.."), ".tmp-hash-handle-"),
  );
  folders.push(folder);
  const filePath = path.join(folder, "binary.bin");
  const bytes = Buffer.alloc(257 * 1024 + 17);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = (index * 131 + 17) & 255;
  await writeFile(filePath, bytes);
  return { bytes, filePath };
}

test("descriptor hashing preserves position and leaves the handle open", async () => {
  const { bytes, filePath } = await fixture();
  const handle = await open(filePath, "r");
  try {
    await handle.read(Buffer.alloc(7), 0, 7, null);
    expect(await sha256Handle(handle)).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    const next = Buffer.alloc(11);
    await handle.read(next, 0, next.length, null);
    expect(next).toEqual(bytes.subarray(7, 18));
    expect((await handle.stat()).size).toBe(bytes.length);
  } finally {
    await handle.close();
  }
});

test("descriptor hashing reads the opened inode after path replacement", async () => {
  const { bytes, filePath } = await fixture();
  const handle = await open(filePath, "r");
  try {
    await rename(filePath, filePath + ".old");
    await writeFile(filePath, "replacement");
    expect(await sha256Handle(handle)).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  } finally {
    await handle.close();
  }
});

test("descriptor hashing rejects nonregular metadata before reads and retains ownership", async () => {
  const { filePath } = await fixture();
  const directoryMetadata = await stat(path.dirname(filePath));
  const handle = await open(filePath, "r");
  const metadata = spyOn(handle, "stat").mockImplementation(
    (async () => directoryMetadata) as typeof handle.stat,
  );
  const read = spyOn(handle, "read");
  try {
    await expect(sha256Handle(handle)).rejects.toMatchObject({
      code: "file_not_regular",
      retryable: false,
    });
    expect(read).not.toHaveBeenCalled();
    metadata.mockRestore();
    expect((await handle.stat()).isFile()).toBe(true);
  } finally {
    metadata.mockRestore();
    read.mockRestore();
    await handle.close();
  }
});

test("descriptor hashing rejects cancellation before I/O", async () => {
  const { filePath } = await fixture();
  const handle = await open(filePath, "r");
  const read = spyOn(handle, "read");
  const reason = new Error("cancelled descriptor hash");
  const controller = new AbortController();
  controller.abort(reason);
  try {
    await expect(sha256Handle(handle, controller.signal)).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
    expect((await handle.stat()).isFile()).toBe(true);
  } finally {
    read.mockRestore();
    await handle.close();
  }
});

test("descriptor hashing checks cancellation between bounded reads", async () => {
  const { filePath } = await fixture();
  const handle = await open(filePath, "r");
  const originalRead = handle.read.bind(handle);
  const controller = new AbortController();
  const reason = new Error("cancelled during descriptor hash");
  const read = spyOn(handle, "read").mockImplementation((async (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    const result = await originalRead(buffer, offset, length, position);
    controller.abort(reason);
    return result;
  }) as typeof handle.read);
  try {
    await expect(sha256Handle(handle, controller.signal)).rejects.toBe(reason);
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    read.mockRestore();
    await handle.close();
  }
});

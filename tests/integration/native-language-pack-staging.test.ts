import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  stagePackWithBun,
  verifiedPackArchive,
} from "../../src/language-packs/archive.ts";
import {
  nativePackDescriptor,
  setupPackage,
} from "../../src/language-packs/catalog.ts";

const integrity = (bytes: Uint8Array) =>
  createHash("sha512").update(bytes).digest("base64");

const mockFetch = (respond: (url: string) => Response) =>
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => respond(String(input)),
      {
        preconnect: fetch.preconnect,
      },
    ),
  );

test("rejects archive HTTP failures and cancels a stream over its byte budget", async () => {
  let cancelled = false;
  const network = mockFetch((url) => {
    if (url.endsWith("/missing")) return new Response(null, { status: 404 });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  try {
    const { signal } = new AbortController();
    await expect(
      verifiedPackArchive("https://fixture.invalid/missing", "", signal),
    ).rejects.toThrow("HTTP 404");
    await expect(
      verifiedPackArchive("https://fixture.invalid/oversized", "", signal),
    ).rejects.toThrow("exceeds its size budget");
    expect(cancelled).toBe(true);
    expect(network).toHaveBeenCalledWith("https://fixture.invalid/oversized", {
      redirect: "error",
      signal,
    });
  } finally {
    network.mockRestore();
  }
});

test("stages only verified local tarballs with lifecycle scripts disabled", async () => {
  const pack = nativePackDescriptor("go", "linux", "x64")!;
  const asset = "test-only grammar bytes";
  const script = "echo ran > script-ran";
  const grammarBytes = await new Bun.Archive(
    {
      "package/package.json": JSON.stringify({
        name: pack.packageName,
        version: pack.version,
        dependencies: { [setupPackage.packageName]: "0.0.6" },
        scripts: { postinstall: script },
      }),
      ["package/" + pack.packagePath]: asset,
    },
    { compress: "gzip" },
  ).bytes();
  const setupBytes = await new Bun.Archive(
    {
      "package/package.json": JSON.stringify({
        name: setupPackage.packageName,
        version: "0.0.6",
        scripts: { postinstall: script },
      }),
    },
    { compress: "gzip" },
  ).bytes();
  const invalidBytes = Buffer.from("not a package archive");
  const grammar = { ...pack, integrity: integrity(grammarBytes) };
  const setup = { ...setupPackage, integrity: integrity(setupBytes) };
  const good = await realpath(
    await mkdtemp(path.join(tmpdir(), "ast-mcp-stage-")),
  );
  const bad = await realpath(
    await mkdtemp(path.join(tmpdir(), "ast-mcp-stage-")),
  );
  const invalidUrl = "https://fixture.invalid/invalid";
  const network = mockFetch((url) => {
    if (url === grammar.url) return new Response(grammarBytes);
    if (url === setup.url) return new Response(setupBytes);
    if (url === invalidUrl) return new Response(invalidBytes);
    throw new Error("Unexpected archive request: " + url);
  });
  try {
    const { signal } = new AbortController();
    const installed = await stagePackWithBun(good, grammar, signal, setup);
    expect(await readFile(installed, "utf8")).toBe(asset);
    for (const packageName of [pack.packageName, setupPackage.packageName]) {
      await expect(
        stat(path.join(good, "node_modules", packageName, "script-ran")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(
      stagePackWithBun(
        bad,
        { ...pack, url: invalidUrl, integrity: integrity(invalidBytes) },
        signal,
        setup,
      ),
    ).rejects.toThrow("scripts-disabled Bun language pack install exited");
    expect(network).toHaveBeenCalledTimes(4);
  } finally {
    network.mockRestore();
    await Promise.all(
      [good, bad].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  }
});

import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveConfig } from "../../src/config";
import { verifiedPackArchive } from "../../src/language-packs/archive.ts";
import { nativePackDescriptor } from "../../src/language-packs/catalog.ts";
import {
  activeNativePack,
  installNativeLanguagePack,
  languagePackStore,
  listNativeLanguagePacks,
  resolveNativeLanguagePack,
  verifyNativePackAsset,
} from "../../src/language-packs/index.ts";

async function withPackFixture<T>(
  use: (fixture: {
    root: string;
    checkout: string;
    config: string;
    options: { cwd: string; env: NodeJS.ProcessEnv; home: string };
  }) => Promise<T>,
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-pm-test-")),
  );
  const checkout = path.join(root, "checkout");
  const home = path.join(root, "config");
  const options = {
    cwd: checkout,
    env: { APPDATA: home, XDG_CONFIG_HOME: home },
    home,
  };
  try {
    await mkdir(checkout);
    return await use({
      root,
      checkout,
      config: path.join(checkout, "ast-mcp.toml"),
      options,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("language pack store and first-use download require the host's grants", async () => {
  await withPackFixture(async (fixture) => {
    const { config, checkout, options, root } = fixture;
    await writeFile(
      config,
      'version = 2\n[language_packs]\nscope = "project"\n[language_packs.versions]\ngo = "0.0.6"\n',
    );
    const denied = await resolveConfig(options);
    expect(denied.languagePacks).toMatchObject({
      allowFirstUse: false,
      projectStorageDenied: true,
    });
    expect(languagePackStore(denied)).toBeUndefined();
    const allowed = await resolveConfig({
      ...options,
      languagePackHost: { allowProject: true, allowDownload: true },
    });
    expect(allowed.languagePacks).toMatchObject({
      scope: "project",
      allowFirstUse: true,
      versions: { go: "0.0.6" },
    });
    expect(languagePackStore(allowed)).toBe(
      path.join(checkout, ".ast-mcp", "language-packs"),
    );
    expect(() => languagePackStore(allowed, path.join(root, "other"))).toThrow(
      "outside the authorized checkout",
    );
    const network = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("No network in test"),
    );
    try {
      expect(
        await resolveNativeLanguagePack(denied, "go", { allowDownload: true }),
      ).toBeNull();
      expect(await resolveNativeLanguagePack(allowed, "go")).toBeNull();
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
    for (const key of [
      "allow_first_use = true",
      'registry = "https://example.com"',
      'directory = "/external"',
    ]) {
      await writeFile(config, "version = 2\n[language_packs]\n" + key + "\n");
      await expect(resolveConfig(options)).rejects.toThrow("language_packs");
    }
    await writeFile(
      config,
      'version = 2\n[language_packs.versions]\ngo = "latest"\n',
    );
    await expect(resolveConfig(options)).rejects.toThrow("language_packs");
  });
});

test("offline lookup and doctor reject corrupt packs without loading or fetching", async () => {
  await withPackFixture(async ({ options }) => {
    const config = await resolveConfig(options);
    const directory = languagePackStore(config)!;
    const descriptor = nativePackDescriptor("python");
    if (!descriptor) {
      expect(
        listNativeLanguagePacks(config).every(
          (pack) => pack.status === "unsupported",
        ),
      ).toBe(true);
      return;
    }
    expect(nativePackDescriptor("python", "freebsd", "arm64")).toBeNull();
    const network = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("No network in test"),
    );
    try {
      expect(activeNativePack("python", config)).toBeUndefined();
      await expect(
        installNativeLanguagePack(config, "python", { offline: true }),
      ).rejects.toThrow("available offline");
      await mkdir(directory, { mode: 0o700, recursive: true });
      const libraryPath = path.join(directory, descriptor.filename);
      await writeFile(libraryPath, "invalid native bytes", { mode: 0o400 });
      const asset = { ...descriptor, libraryPath };
      expect(
        verifyNativePackAsset("python", { ...asset, abi: descriptor.abi + 1 }),
      ).toBe(false);
      expect(verifyNativePackAsset("python", asset)).toBe(false);
      expect(() => activeNativePack("python", config)).toThrow(
        "digest mismatch",
      );
      await expect(
        resolveNativeLanguagePack(config, "python", { allowDownload: true }),
      ).rejects.toThrow("digest mismatch");
      expect(
        listNativeLanguagePacks(config).find(
          (pack) => pack.language === "python",
        ),
      ).toMatchObject({
        status: "corrupt",
        reason: "Language pack asset digest mismatch",
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
});

test("concurrent installs share archive requests and clean up interrupted staging", async () => {
  const descriptor = nativePackDescriptor("sql");
  if (!descriptor) return;
  await withPackFixture(async ({ options }) => {
    const config = await resolveConfig(options);
    const directory = languagePackStore(config)!;
    await mkdir(directory, { mode: 0o700, recursive: true });
    const destination = path.join(directory, descriptor.filename);
    const pending = path.join(
      directory,
      "." + descriptor.filename + ".pending",
    );
    const key = createHash("sha256").update(destination).digest("hex");
    const stage = path.join(await realpath(os.tmpdir()), "ast-mcp-pack-" + key);
    await mkdir(stage, { mode: 0o700 });
    await writeFile(pending, "partial native bytes", { mode: 0o400 });
    const network = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => new Response("invalid archive"), {
        preconnect: fetch.preconnect,
      }),
    );
    try {
      const first = installNativeLanguagePack(config, "sql");
      const second = installNativeLanguagePack(config, "sql");
      const outcomes = await Promise.allSettled([first, second]);
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: { message: "Language pack archive integrity mismatch" },
        });
      }
      expect(network).toHaveBeenCalledTimes(2);
      for (const entry of [stage, pending, destination]) {
        await expect(stat(entry)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const signal = new AbortController().signal;
      await expect(
        verifiedPackArchive(descriptor.url, descriptor.integrity, signal),
      ).rejects.toThrow("archive integrity mismatch");
    } finally {
      network.mockRestore();
      await rm(stage, { force: true, recursive: true });
    }
  });
});

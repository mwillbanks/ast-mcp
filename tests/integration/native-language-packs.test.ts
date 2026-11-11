import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
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
import {
  configureLanguagePackHost,
  languagePackHostPolicy,
} from "../../src/config/language-packs.ts";
import { pinnedGrammarRegistration } from "../../src/intelligence/parser/index.ts";
import * as packArchive from "../../src/language-packs/archive.ts";
import { nativePackDescriptor } from "../../src/language-packs/catalog.ts";
import {
  activeNativePack,
  installNativeLanguagePack,
  languagePackStore,
  listNativeLanguagePacks,
  resolveNativeLanguagePack,
  verifyNativePackAsset,
} from "../../src/language-packs/index.ts";

async function makeFixturePackRemovable(file: string): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    await chmod(file, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeFixturePack(file: string): Promise<void> {
  await makeFixturePackRemovable(file);
  await rm(file);
}

async function withPackFixture<T>(
  use: (fixture: {
    root: string;
    checkout: string;
    config: string;
    trackPack: (file: string) => string;
    options: { cwd: string; env: NodeJS.ProcessEnv; home: string };
  }) => Promise<T>,
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-pm-test-")),
  );
  const checkout = path.join(root, "checkout");
  const home = path.join(root, "config");
  const packs = new Set<string>();
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
      trackPack(file) {
        packs.add(file);
        return file;
      },
      options,
    });
  } finally {
    // Windows recursive removal can reject read-only files in the fixture.
    await Promise.all([...packs].map(makeFixturePackRemovable));
    await rm(root, { recursive: true, force: true });
  }
}

test("host startup consumes only the exact language pack grants", () => {
  const previous = languagePackHostPolicy();
  try {
    expect(
      configureLanguagePackHost([
        "serve",
        "--allow-language-pack-downloads",
        "--allow-project-language-packs=false",
      ]),
    ).toEqual(["serve", "--allow-project-language-packs=false"]);
    expect(languagePackHostPolicy()).toEqual({
      allowDownload: true,
      allowProject: false,
    });
    expect(Object.isFrozen(languagePackHostPolicy())).toBe(true);
    expect(
      configureLanguagePackHost(["serve", "--allow-project-language-packs"]),
    ).toEqual(["serve"]);
    expect(languagePackHostPolicy()).toEqual({
      allowDownload: false,
      allowProject: true,
    });
  } finally {
    configureLanguagePackHost([
      ...(previous.allowDownload ? ["--allow-language-pack-downloads"] : []),
      ...(previous.allowProject ? ["--allow-project-language-packs"] : []),
    ]);
  }
});

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
    if (nativePackDescriptor("go")) {
      await expect(installNativeLanguagePack(denied, "go")).rejects.toThrow(
        "Project language pack storage requires",
      );
    }
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
  await withPackFixture(async ({ options, trackPack }) => {
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
      const libraryPath = trackPack(path.join(directory, descriptor.filename));
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

test("concurrent installs coalesce and clean only their own stages on failure", async () => {
  const descriptor = nativePackDescriptor("sql");
  if (!descriptor) return;
  await withPackFixture(async ({ options, trackPack }) => {
    const config = await resolveConfig(options);
    const directory = languagePackStore(config)!;
    await mkdir(directory, { mode: 0o700, recursive: true });
    const destination = path.join(directory, descriptor.filename);
    const pending = trackPack(
      path.join(directory, "." + descriptor.filename + ".pending"),
    );
    const key = createHash("sha256").update(destination).digest("hex");
    const foreignStage = path.join(
      await realpath(os.tmpdir()),
      "ast-mcp-pack-" + key,
    );
    await mkdir(foreignStage, { mode: 0o700 });
    const sentinel = path.join(foreignStage, "keep");
    await writeFile(sentinel, "outside the current install");
    await writeFile(pending, "partial native bytes", { mode: 0o400 });
    const staging = spyOn(packArchive, "stagePackWithBun");
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
      expect(staging).toHaveBeenCalledTimes(1);
      await expect(installNativeLanguagePack(config, "sql")).rejects.toThrow(
        "archive integrity mismatch",
      );
      expect(staging).toHaveBeenCalledTimes(2);
      expect(staging.mock.calls[0]?.[0]).not.toBe(staging.mock.calls[1]?.[0]);
      for (const [stage] of staging.mock.calls) {
        await expect(stat(stage)).rejects.toMatchObject({ code: "ENOENT" });
      }
      for (const entry of [pending, destination]) {
        await expect(stat(entry)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await Bun.file(sentinel).text()).toBe(
        "outside the current install",
      );
      const signal = new AbortController().signal;
      await expect(
        packArchive.verifiedPackArchive(
          descriptor.url,
          descriptor.integrity,
          signal,
        ),
      ).rejects.toThrow("archive integrity mismatch");
    } finally {
      network.mockRestore();
      staging.mockRestore();
      await rm(foreignStage, { force: true, recursive: true });
    }
  });
});

test.skipIf(!nativePackDescriptor("go"))(
  "publishes a verified native pack while a coalesced waiter can cancel independently",
  async () => {
    await withPackFixture(async ({ options, trackPack }) => {
      const config = await resolveConfig({
        ...options,
        languagePackHost: { allowDownload: true },
      });
      const descriptor = nativePackDescriptor("go")!;
      trackPack(path.join(languagePackStore(config)!, descriptor.filename));
      const ready = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const staging = spyOn(packArchive, "stagePackWithBun").mockImplementation(
        async (stage, selected) => {
          expect(selected).toEqual(descriptor);
          ready.resolve();
          await resume.promise;
          const source = path.join(stage, "grammar.so");
          await copyFile(pinnedGrammarRegistration("go").libraryPath, source);
          await chmod(source, 0o600);
          return source;
        },
      );
      const controller = new AbortController();
      const first = resolveNativeLanguagePack(config, "go", {
        allowDownload: true,
      });
      try {
        await Promise.race([
          ready.promise,
          first.then(() => {
            throw new Error("Native staging completed without the fixture");
          }),
        ]);
        const other = installNativeLanguagePack(config, "go", {
          signal: controller.signal,
        });
        controller.abort(new Error("This waiter cancelled"));
        await expect(other).rejects.toThrow("This waiter cancelled");
        expect(activeNativePack("go", config)).toBeUndefined();
        resume.resolve();
        const installed = await first;
        if (!installed) throw new Error("Verified pack was not installed");
        expect(installed.sha256).toBe(descriptor.sha256);
        expect(activeNativePack("go", config)).toEqual(installed);
        expect(verifyNativePackAsset("go", installed)).toBe(true);
        expect(
          await installNativeLanguagePack(config, "go", { offline: true }),
        ).toEqual(installed);
        expect(await installNativeLanguagePack(config, "go")).toEqual(
          installed,
        );
        expect(await resolveNativeLanguagePack(config, "go")).toEqual(
          installed,
        );
        expect(listNativeLanguagePacks(config)).toContainEqual({
          language: "go",
          ...installed,
          status: "installed",
        });
        expect(staging).toHaveBeenCalledTimes(1);
      } finally {
        resume.resolve();
        await Promise.allSettled([first]);
        staging.mockRestore();
      }
    });
  },
);

test.skipIf(!nativePackDescriptor("python"))(
  "activates a verified project pack through a private copy outside the checkout",
  async () => {
    await withPackFixture(
      async ({ checkout, config: configPath, options, trackPack }) => {
        await writeFile(
          configPath,
          'version = 2\n[language_packs]\nscope = "project"\n',
        );
        const config = await resolveConfig({
          ...options,
          languagePackHost: { allowProject: true },
        });
        const descriptor = nativePackDescriptor("python")!;
        const store = languagePackStore(config)!;
        const projectLibrary = trackPack(path.join(store, descriptor.filename));
        const activated = trackPack(
          path.join(
            config.languagePacks!.userDirectory,
            ".activated",
            descriptor.filename,
          ),
        );
        await mkdir(store, { recursive: true, mode: 0o700 });
        await copyFile(
          pinnedGrammarRegistration("python").libraryPath,
          projectLibrary,
        );
        await chmod(projectLibrary, 0o400);
        expect(listNativeLanguagePacks(config)).toContainEqual(
          expect.objectContaining({
            language: "python",
            libraryPath: projectLibrary,
            status: "installed",
          }),
        );
        await expect(stat(activated)).rejects.toMatchObject({ code: "ENOENT" });
        const asset = activeNativePack("python", config, checkout)!;
        expect(asset.libraryPath).toBe(activated);
        expect(verifyNativePackAsset("python", asset)).toBe(true);
        expect(activeNativePack("python", config, checkout)).toEqual(asset);

        await removeFixturePack(activated);
        expect(activeNativePack("python", config, checkout)).toEqual(asset);
        await chmod(activated, 0o600);
        await writeFile(activated, "damaged activated copy");
        await chmod(activated, 0o400);
        expect(() => activeNativePack("python", config, checkout)).toThrow(
          "digest mismatch",
        );
        await removeFixturePack(activated);
        expect(activeNativePack("python", config, checkout)).toEqual(asset);
        await removeFixturePack(projectLibrary);
        expect(activeNativePack("python", config, checkout)).toBeUndefined();
        expect(verifyNativePackAsset("python", asset)).toBe(true);
      },
    );
  },
);

test.skipIf(!nativePackDescriptor("sql"))(
  "rejects a staged native asset with an incorrect digest and preserves offline state",
  async () => {
    await withPackFixture(async ({ options }) => {
      const config = await resolveConfig({
        ...options,
        languagePackHost: { allowDownload: true },
      });
      const staging = spyOn(packArchive, "stagePackWithBun").mockImplementation(
        async (stage) => {
          const file = path.join(stage, "wrong.so");
          await writeFile(file, "staged bytes of the wrong grammar", {
            mode: 0o600,
          });
          return file;
        },
      );
      try {
        await expect(installNativeLanguagePack(config, "sql")).rejects.toThrow(
          "unexpected digest",
        );
        expect(
          await resolveNativeLanguagePack(config, "sql", {
            allowDownload: true,
          }),
        ).toBeNull();
        expect(activeNativePack("sql", config)).toBeUndefined();
        staging.mockImplementation(async (stage) => {
          const file = path.join(stage, "empty.so");
          await writeFile(file, "", { mode: 0o600 });
          return file;
        });
        await expect(installNativeLanguagePack(config, "sql")).rejects.toThrow(
          "Bun installed an invalid language pack asset",
        );
      } finally {
        staging.mockRestore();
      }
    });
  },
);

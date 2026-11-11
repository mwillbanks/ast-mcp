import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withConfig } from "../../src/config";
import {
  commandForPlatform,
  npmNativeBinaries,
} from "../../src/runtime/binary-resolution";
import {
  configuredDprintBinary,
  resolveDependencyBinary,
  resolveGlobalBinaryAlias,
} from "../../src/runtime/dependencies";
import {
  commandForPlatform as skillCommandForPlatform,
  npmNativeBinaries as skillNativeBinaries,
} from "../../templates/skills/ast-mcp/scripts/binary-resolution";
import { hermeticConfig } from "../support/hermetic-config";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

async function executable(file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
  return file;
}

async function npmManifest(
  modules: string,
  name: string,
  version: string,
  optionalDependencies?: Record<string, string>,
) {
  const directory = path.join(modules, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name, version, optionalDependencies }),
  );
  return directory;
}

function expectNativeBinaries(
  alias: string,
  platform: NodeJS.Platform,
  arch: string,
  expected: string[],
) {
  expect(npmNativeBinaries(alias, platform, arch)).toEqual(expected);
  expect(skillNativeBinaries(alias, platform, arch)).toEqual(expected);
}

test("recognizes matching npm native commands and ignores stale or unavailable optional packages", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-native-bin-")),
  );
  created.push(root);
  const modules = path.join(root, "node_modules");
  const musl = "@mwillbanks/ast-mcp-linux-arm64-musl";
  const gnu = "@mwillbanks/ast-mcp-linux-arm64";
  const windows = "@mwillbanks/ast-mcp-windows-x64";
  const missing = "@mwillbanks/ast-mcp-linux-x64";
  const unpinned = "@mwillbanks/ast-mcp-windows-arm64";
  const main = await npmManifest(modules, "@mwillbanks/ast-mcp", "1.2.3", {
    [musl]: "1.2.3",
    [gnu]: "1.2.3",
    [windows]: "1.2.3",
    [missing]: "1.2.3",
    [unpinned]: "1.2.2",
  });
  const native = await executable(
    path.join(await npmManifest(modules, musl, "1.2.3"), "ast-mcp-bytecode"),
  );
  await executable(
    path.join(await npmManifest(modules, gnu, "1.2.2"), "ast-mcp-bytecode"),
  );
  const windowsNative = await executable(
    path.join(
      await npmManifest(modules, windows, "1.2.3"),
      "ast-mcp-bytecode.exe",
    ),
  );
  await executable(
    path.join(
      await npmManifest(modules, unpinned, "1.2.3"),
      "ast-mcp-bytecode.exe",
    ),
  );
  const localShim = await executable(path.join(modules, ".bin", "ast-mcp"));
  const launcher = await executable(
    path.join(main, "dist", "ast-mcp-launch.cjs"),
  );
  if (process.platform !== "win32") {
    expectNativeBinaries(localShim, "linux", "arm64", [native]);
    expectNativeBinaries(launcher, "linux", "arm64", [native]);
  }
  expectNativeBinaries(path.join(root, "ast-mcp.cmd"), "win32", "x64", [
    windowsNative,
  ]);
  expectNativeBinaries(localShim, "linux", "x64", []);
  expectNativeBinaries(localShim, "win32", "arm64", []);
  await rm(windowsNative);
  expectNativeBinaries(localShim, "win32", "x64", []);
});

test("does not persist an executable from a versioned manager store", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-versioned-bin-")),
  );
  created.push(root);
  const name = "@mwillbanks/ast-mcp-darwin-arm64";
  for (const manager of [".pnpm", ".yarn"]) {
    const modules = path.join(root, manager, "node_modules");
    const main = await npmManifest(modules, "@mwillbanks/ast-mcp", "1.2.3", {
      [name]: "1.2.3",
    });
    const launcher = await executable(
      path.join(main, "dist", "ast-mcp-launch.cjs"),
    );
    await executable(
      path.join(await npmManifest(modules, name, "1.2.3"), "ast-mcp-bytecode"),
    );
    expectNativeBinaries(launcher, "darwin", "arm64", []);
  }
});

test("rejects shell expansion and control characters in Windows npm shims", () => {
  for (const resolve of [commandForPlatform, skillCommandForPlatform]) {
    for (const argument of ["%PATH%", "!PATH!", "one\nnext", 'one"next']) {
      expect(() => resolve("ast-mcp.cmd", ["mcp", argument], "win32")).toThrow(
        "Windows batch command arguments cannot contain",
      );
      expect(resolve("ast-mcp.exe", ["mcp", argument], "win32")).toEqual({
        args: ["mcp", argument],
        command: "ast-mcp.exe",
      });
    }
  }
});

test("resolves a dependency from an ancestor node_modules bin first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-binary-"));
  created.push(root);
  const nested = path.join(root, "node_modules/@scope/package");
  const parentBinary = await executable(
    path.join(root, "node_modules/.bin/tool"),
  );
  const globalBinary = await executable(path.join(root, "global/tool"));

  expect(
    resolveDependencyBinary("tool", "missing-package", {
      globalBinDirectories: [path.dirname(globalBinary)],
      packageRoot: nested,
      pathValue: "",
    }),
  ).toBe(parentBinary);
});

test("resolves package-manager global bins before PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-global-bin-"));
  created.push(root);
  const globalBinary = await executable(path.join(root, "global/tool"));
  await executable(path.join(root, "path/tool"));

  expect(
    resolveDependencyBinary("tool", "missing-package", {
      globalBinDirectories: [path.dirname(globalBinary)],
      packageRoot: path.join(root, "package"),
      pathValue: path.join(root, "path"),
    }),
  ).toBe(globalBinary);
});

test("resolves Bun, npm, pnpm, and Yarn global aliases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-manager-bins-"));
  created.push(root);
  for (const manager of ["bun", "npm", "pnpm", "yarn"]) {
    const directory = path.join(root, manager, "bin");
    const alias = await executable(path.join(directory, "ast-mcp"));
    expect(
      resolveGlobalBinaryAlias("ast-mcp", {
        globalBinDirectories: [directory],
      }),
    ).toBe(alias);
  }
});

test("falls back to PATH and returns undefined when no binary exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-path-bin-"));
  created.push(root);
  const pathBinary = await executable(path.join(root, "path/tool"));
  const options = {
    globalBinDirectories: [],
    packageRoot: path.join(root, "package"),
    pathValue: path.join(root, "path"),
  };

  expect(resolveDependencyBinary("tool", "missing-package", options)).toBe(
    pathBinary,
  );
  expect(
    resolveDependencyBinary("missing", "missing-package", options),
  ).toBeUndefined();
});

test("supports Windows executable extensions in global package-manager bins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-windows-bin-"));
  created.push(root);
  const bunInstall = path.join(root, "bun-home");
  const windowsBinary = path.join(bunInstall, "bin/tool.CMD");
  await mkdir(path.dirname(windowsBinary), { recursive: true });
  await writeFile(windowsBinary, "@exit /b 0\r\n");
  const previous = {
    BUN_INSTALL: process.env.BUN_INSTALL,
    npm_config_prefix: process.env.npm_config_prefix,
    PATHEXT: process.env.PATHEXT,
    PNPM_HOME: process.env.PNPM_HOME,
  };
  process.env.BUN_INSTALL = bunInstall;
  process.env.PATHEXT = ".EXE;.CMD";
  process.env.PNPM_HOME = path.join(root, "pnpm");
  process.env.npm_config_prefix = path.join(root, "npm");

  try {
    expect(
      resolveDependencyBinary("tool", "missing-package", {
        packageBinary: path.join(root, "missing-package-binary"),
        packageRoot: path.join(root, "package"),
        pathValue: "",
        platform: "win32",
      }),
    ).toBe(windowsBinary);
  } finally {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

test.skipIf(process.platform === "win32")(
  "requires POSIX execute permission for extensionless global aliases",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-posix-bin-"));
    created.push(root);
    const alias = await executable(path.join(root, "tool"));
    const options = {
      globalBinDirectories: [root],
      platform: "linux" as const,
    };
    expect(resolveGlobalBinaryAlias("tool", options)).toBe(alias);
    await chmod(alias, 0o644);
    expect(resolveGlobalBinaryAlias("tool", options)).toBeUndefined();
  },
);

test("resolves executable paths declared by package metadata", () => {
  expect(
    resolveDependencyBinary("tsc", "typescript", {
      globalBinDirectories: [],
      packageRoot: path.join(os.tmpdir(), "missing-package-root"),
      pathValue: "",
    }),
  ).toContain(path.join("typescript", "bin", "tsc"));
});

test("reads string bin declarations and ignores packages without executable metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-package-bin-"));
  created.push(root);
  const binary = await executable(path.join(root, "cli"));
  const manifest = path.join(root, "package.json");
  const options = {
    packageRoot: path.join(root, "missing"),
    pathValue: "",
    globalBinDirectories: [],
  };
  await writeFile(manifest, JSON.stringify({ bin: "cli" }));
  const resolved = resolveDependencyBinary("fixture", root, options);
  expect(resolved).toBeDefined();
  expect(await realpath(resolved!)).toBe(await realpath(binary));
  await writeFile(manifest, JSON.stringify({ name: "fixture" }));
  expect(resolveDependencyBinary("fixture", root, options)).toBeUndefined();
});

test("dprint resolution prefers explicit configuration, then environment, then its fallback", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-dprint-resolution-"),
  );
  created.push(root);
  const previous = process.env.DPRINT_BINARY;
  try {
    process.env.DPRINT_BINARY = path.join(root, "environment-dprint");
    await writeFile(
      path.join(root, "ast-mcp.toml"),
      'version = 2\n[dependencies]\ndprint_binary = "./configured-dprint"\n',
    );
    await withConfig(hermeticConfig(root), async () => {
      expect(await configuredDprintBinary()).toBe(
        path.join(root, "configured-dprint"),
      );
    });
    await rm(path.join(root, "ast-mcp.toml"));
    await withConfig(hermeticConfig(root), async () => {
      expect(await configuredDprintBinary()).toBe(process.env.DPRINT_BINARY!);
      delete process.env.DPRINT_BINARY;
      expect(await configuredDprintBinary()).toBe(
        resolveDependencyBinary("dprint", "dprint") ?? "dprint",
      );
    });
  } finally {
    if (previous === undefined) delete process.env.DPRINT_BINARY;
    else process.env.DPRINT_BINARY = previous;
  }
});

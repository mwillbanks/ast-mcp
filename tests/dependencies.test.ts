import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AST_BRO_BINARY,
  assertAstBroAvailable,
  resolveDependencyBinary,
} from "../src/runtime/dependencies";

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
  const posixBinary = path.join(bunInstall, "bin/tool");
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
    await executable(posixBinary);
    expect(
      resolveDependencyBinary("tool", "missing-package", {
        packageBinary: path.join(root, "missing-package-binary"),
        packageRoot: path.join(root, "package"),
        pathValue: "",
        platform: "linux",
      }),
    ).toBe(posixBinary);
  } finally {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

test("resolves executable paths declared by package metadata", () => {
  expect(
    resolveDependencyBinary("ast-bro", "@ast-bro/cli", {
      globalBinDirectories: [],
      packageRoot: path.join(os.tmpdir(), "missing-package-root"),
      pathValue: "",
    }),
  ).toContain(path.join("@ast-bro", "cli", "bin", "ast-bro.js"));
  expect(
    resolveDependencyBinary("dprint", "dprint", {
      globalBinDirectories: [],
      packageRoot: path.join(os.tmpdir(), "missing-package-root"),
      pathValue: "",
    }),
  ).toContain(path.join("dprint", "bin.cjs"));
});

test("validates ast-bro versions and reports platform recovery", () => {
  expect(() => assertAstBroAvailable(AST_BRO_BINARY)).not.toThrow();
  expect(() =>
    assertAstBroAvailable(process.execPath, "darwin", "arm64"),
  ).toThrow("bun pm trust @ast-bro/cli");
  expect(() =>
    assertAstBroAvailable("/missing/ast-bro.exe", "win32", "x64"),
  ).toThrow("$HOME\\.cargo\\bin\\ast-bro.exe");
  expect(() =>
    assertAstBroAvailable("/missing/ast-bro", "linux", "x64"),
  ).toThrow("No precompiled ast-bro 3.0.0 binary");
});

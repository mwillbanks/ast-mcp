import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { BunPlugin } from "bun";

const requirePackage = createRequire(import.meta.url);

const targets = {
  "bun-darwin-arm64": ["darwin-arm64", "macOS-ARM64"],
  "bun-linux-x64": ["linux-x64-gnu", "Linux-X64"],
  "bun-linux-arm64": ["linux-arm64-gnu", "Linux-ARM64"],
  "bun-linux-x64-musl": ["linux-x64-musl", "Linux-X64"],
  "bun-linux-arm64-musl": ["linux-arm64-musl", "Linux-ARM64"],
  "bun-windows-x64": ["win32-x64-msvc", "Windows-X64"],
  "bun-windows-arm64": ["win32-arm64-msvc", "Windows-ARM64"],
} as const satisfies Partial<
  Record<Bun.Build.CompileTarget, readonly [string, string]>
>;

type StandaloneTarget = keyof typeof targets;

export function standaloneTarget(value: string): StandaloneTarget {
  if (!Object.hasOwn(targets, value))
    throw new Error("No pinned AST-MCP native asset set for " + value);
  return value as StandaloneTarget;
}

export function standaloneNativeAssets(
  root: string,
  target?: StandaloneTarget,
  nativeRoot = root,
) {
  const requireNative = createRequire(path.join(nativeRoot, "package.json"));
  const manifest = requirePackage(path.join(root, "package.json")) as {
    dependencies: Record<string, string>;
    optionalDependencies: Record<string, string>;
  };
  const napi = requirePackage("@ast-grep/napi/package.json") as {
    optionalDependencies: Record<string, string>;
  };
  const candidates = {
    ...napi.optionalDependencies,
    ...manifest.optionalDependencies,
  };
  const suffix = target && targets[target][0];
  const native = ["@ast-grep/napi-", "@lancedb/lancedb-"].map((family) => {
    const name = suffix
      ? family + suffix
      : Object.keys(candidates).find((entry) => {
          if (!entry.startsWith(family + process.platform + "-" + process.arch))
            return false;
          try {
            requireNative.resolve(entry + "/package.json");
            return true;
          } catch {
            return false;
          }
        });
    if (!name || !candidates[name])
      throw new Error("Missing pinned native addon for " + family);
    const resolved = requireNative.resolve(name + "/package.json");
    const addon = requireNative(resolved) as {
      name: string;
      main: string;
      version: string;
    };
    if (addon.name !== name || addon.version !== candidates[name])
      throw new Error(
        "Native addon does not match the locked version: " + name,
      );
    return { name, source: path.dirname(resolved), main: addon.main };
  });
  const packages = [
    ...Object.keys(manifest.dependencies).filter((name) =>
      name.startsWith("@ast-grep/lang-"),
    ),
    "@ast-grep/napi",
    "@ast-grep/setup-lang",
    "@pgsql/types",
    "libpg-query",
  ].map((name) => ({
    name,
    source: path.dirname(requirePackage.resolve(name + "/package.json")),
  }));
  return { native, packages, target };
}

type NativeAssets = ReturnType<typeof standaloneNativeAssets>;

function nativeBridge(name: string, assets: NativeAssets): string {
  const addon =
    name === "@ast-grep/napi"
      ? assets.native[0]
      : assets.native.find((entry) => entry.name === name);
  if (addon) {
    return [
      'import { dirname, join } from "node:path";',
      "const binding = { exports: {} };",
      `process.dlopen(binding, join(dirname(process.execPath), "runtime", "node_modules", ${JSON.stringify(addon.name)}, ${JSON.stringify(addon.main)}));`,
      "module.exports = binding.exports;",
    ].join("\n");
  }
  return [
    'import { createRequire } from "node:module";',
    'import { dirname, join } from "node:path";',
    'const runtime = join(dirname(process.execPath), "runtime");',
    'const requireNative = createRequire(join(runtime, "package.json"));',
    `module.exports = requireNative(join(runtime, "node_modules", ${JSON.stringify(name)}));`,
  ].join("\n");
}

export function standaloneAssetsPlugin(assets: NativeAssets): BunPlugin {
  return {
    name: "standalone-assets",
    setup(build) {
      build.onResolve(
        {
          filter:
            /^(?:libpg-query|@ast-grep\/napi(?:\/package\.json)?|@lancedb\/lancedb-[^/]+(?:\/package\.json)?)$/,
        },
        ({ path: name }) => ({ path: name, namespace: "native-sidecar" }),
      );
      build.onLoad(
        { filter: /.*/, namespace: "native-sidecar" },
        ({ path: name }) => ({
          contents: nativeBridge(name, assets),
          loader: "js",
        }),
      );
      build.onLoad(
        { filter: /(?:language-catalog|wasm-assets|skills[\\/]index)\.ts$/ },
        async ({ path: filePath }) => {
          const source = await Bun.file(filePath).text();
          const resolved = source
            .replace(
              "const requireGrammar = createRequire(import.meta.url);",
              'const requireGrammar = createRequire(standaloneJoin(standaloneDirname(process.execPath), "runtime", "package.json"));',
            )
            .replace(
              "const moduleDirectory = dirname(fileURLToPath(import.meta.url));",
              'const moduleDirectory = join(dirname(process.execPath), "runtime");',
            )
            .replace(
              /export const bundledSkillRoot = path\.resolve\([\s\S]*?\n\);/,
              'export const bundledSkillRoot = path.join(path.dirname(process.execPath), "runtime", "templates", "skills", "ast-mcp");',
            );
          if (resolved === source)
            throw new Error(
              `Standalone asset anchor is missing from ${filePath}`,
            );
          return {
            contents: filePath.endsWith("language-catalog.ts")
              ? `import { dirname as standaloneDirname, join as standaloneJoin } from "node:path";\n${resolved}`
              : resolved,
            loader: "ts",
          };
        },
      );
    },
  };
}

export async function buildStandalones(
  root: string,
  output: string,
  workers: readonly string[],
  build: (outdir: string) => Promise<void>,
  assets: NativeAssets,
): Promise<void> {
  const runtime = path.join(output, "runtime");
  await mkdir(output);
  try {
    const stage = await mkdtemp(path.join(output, ".build-"));
    await build(stage);
    await cp(
      path.join(root, "dist", "workers"),
      path.join(runtime, "workers"),
      {
        recursive: true,
      },
    );
    await cp(path.join(root, "templates"), path.join(runtime, "templates"), {
      recursive: true,
    });
    await Bun.write(
      path.join(runtime, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    for (const { name, source } of [...assets.native, ...assets.packages]) {
      const destination = path.join(runtime, "node_modules", name);
      await mkdir(path.dirname(destination), { recursive: true });
      const grammar = name.startsWith("@ast-grep/lang-")
        ? assets.target
          ? path.join(
              source,
              "prebuilds",
              "prebuild-" + targets[assets.target][1],
              "parser.so",
            )
          : (requirePackage(name) as { libraryPath: string }).libraryPath
        : undefined;
      if (grammar) await access(grammar);
      await cp(source, destination, {
        dereference: true,
        filter(file) {
          if (!grammar) return true;
          const relative = path.relative(source, file);
          const topLevel = relative.split(path.sep)[0];
          if (topLevel === "prebuilds")
            return grammar === file || grammar.startsWith(file + path.sep);
          if (topLevel === "parser.so") return grammar === file;
          return topLevel !== "src";
        },
        recursive: true,
      });
    }

    for (const bytecode of [false, true]) {
      const name = bytecode ? "ast-mcp-bytecode" : "ast-mcp-plain";
      const outfile = path.join(
        output,
        (
          assets.target
            ? assets.target.startsWith("bun-windows-")
            : process.platform === "win32"
        )
          ? `${name}.exe`
          : name,
      );
      const result = await Bun.build({
        bytecode,
        compile: {
          autoloadBunfig: false,
          autoloadDotenv: false,
          outfile,
          target: assets.target,
        },
        entrypoints: [
          path.join(stage, "ast-mcp.js"),
          ...workers.map((worker) => path.join(stage, "workers", worker)),
        ],
        format: "esm",
        target: "bun",
      });
      if (!result.success)
        throw new AggregateError(result.logs, `${name} build failed`);
    }
    await rm(stage, { force: true, recursive: true });
  } catch (error) {
    await rm(output, { force: true, recursive: true });
    throw error;
  }
}

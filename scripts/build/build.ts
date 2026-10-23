import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { BunPlugin } from "bun";

import {
  resolveWasmGrammarAsset,
  wasmGrammarAssets as grammarAssets,
  wasmProviderVersions,
} from "../../src/intelligence/languages/shared/wasm-assets.ts";

const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
  cwd: path.resolve(import.meta.dir, "../.."),
  stderr: "pipe",
});
const buildId =
  revision.exitCode === 0 ? revision.stdout.toString().trim() : "source";
const providerMetadata = {
  AST_MCP_SOURCE_FILES: JSON.stringify(
    (
      await Array.fromAsync(
        new Bun.Glob("src/**/*.ts").scan({
          cwd: path.resolve(import.meta.dir, "../.."),
        }),
      )
    )
      .concat([
        "dist/ast-mcp.js",
        "dist/workers/code-intelligence-worker.js",
        "dist/workers/parser-worker.js",
        "dist/workers/embedding-model-worker.js",
        "dist/workers/patch-strategy-worker.js",
        "dist/workers/dynamic-wasm-worker.js",
        "dist/workers/infra-wasm-worker.js",
        "dist/workers/jvm-wasm-worker.js",
        "dist/workers/legacy-wasm-worker.js",
        "dist/workers/systems-wasm-worker.js",
      ])
      .sort(),
  ),
  AST_MCP_BUILD_ID: JSON.stringify(
    /^[a-f0-9]{40}$/.test(buildId) ? buildId : "source",
  ),
  AST_MCP_WASM_PROVIDER_VERSIONS: JSON.stringify(wasmProviderVersions()),
};
const root = path.resolve(import.meta.dir, "../..");
const outdir = path.join(root, "dist");
const workerOutdir = path.join(outdir, "workers");
// Preserve package-relative native binaries and grammar assets at runtime.
// Bundle the LanceDB facade to exclude its obsolete optional embedding providers.
const nativeExternals = [
  "@ast-grep/napi",
  "@ast-grep/napi-*",
  "@ast-grep/lang-*",
  "@lancedb/lancedb-*",
];
const workers = [
  {
    client: "src/patch/strategy/worker-client.ts",
    entrypoint: "src/patch/strategy/worker.ts",
    output: "patch-strategy-worker.js",
  },
  {
    client: "src/intelligence/retrieval/worker-session.ts",
    entrypoint: "src/intelligence/retrieval/model-worker.ts",
    output: "embedding-model-worker.js",
  },
  {
    client: "src/intelligence/parser/pool.ts",
    entrypoint: "src/intelligence/parser/worker.ts",
    output: "parser-worker.js",
  },
  {
    client: "src/tools/code-intelligence.ts",
    entrypoint: "src/tools/code-intelligence-worker.ts",
    output: "code-intelligence-worker.js",
  },
  {
    client: "src/intelligence/languages/dynamic/analyzer.ts",
    entrypoint: "src/intelligence/languages/shared/wasm-dynamic-worker.ts",
    output: "dynamic-wasm-worker.js",
  },
  {
    client: "src/intelligence/languages/infra/worker-client.ts",
    entrypoint: "src/intelligence/languages/shared/wasm-infra-worker.ts",
    output: "infra-wasm-worker.js",
  },
  {
    client: "src/intelligence/languages/jvm/worker-client.ts",
    entrypoint: "src/intelligence/languages/shared/wasm-jvm-worker.ts",
    output: "jvm-wasm-worker.js",
  },
  {
    client: "src/intelligence/languages/legacy/analyzer.ts",
    entrypoint: "src/intelligence/languages/shared/wasm-legacy-worker.ts",
    output: "legacy-wasm-worker.js",
  },
  {
    client: "src/intelligence/languages/systems/worker-client.ts",
    entrypoint: "src/intelligence/languages/shared/wasm-systems-worker.ts",
    output: "systems-wasm-worker.js",
  },
] as const;

function assertBuild(
  label: string,
  result: Awaited<ReturnType<typeof Bun.build>>,
): void {
  if (result.success) return;
  for (const log of result.logs) console.error(log);
  throw new Error(`${label} build failed`);
}

await rm(outdir, { force: true, recursive: true });

const packagedWorkerPlugin: BunPlugin = {
  name: "packaged-worker-urls",
  setup(build) {
    build.onLoad(
      {
        filter:
          /src[\\/]+(?:intelligence[\\/]+parser[\\/]+pool|intelligence[\\/]+retrieval[\\/]+worker-session|patch[\\/]+strategy[\\/]+worker-client|tools[\\/]+code-intelligence|intelligence[\\/]+languages[\\/]+(?:dynamic[\\/]+analyzer|legacy[\\/]+analyzer|(?:infra|jvm|systems)[\\/]+worker-client))\.ts$/,
      },
      async ({ path: filePath }: { path: string }) => {
        const relative = path
          .relative(root, filePath)
          .split(path.sep)
          .join("/");
        const worker = workers.find((item) => item.client === relative);
        if (!worker) return;
        const source = await Bun.file(filePath).text();
        const marker =
          relative === "src/tools/code-intelligence.ts"
            ? 'new URL("./code-intelligence-worker.ts", import.meta.url)'
            : relative === "src/intelligence/parser/pool.ts"
              ? 'new URL("./worker.ts", import.meta.url)'
              : relative === "src/intelligence/retrieval/worker-session.ts"
                ? 'new URL("./model-worker.ts", import.meta.url)'
                : relative === "src/patch/strategy/worker-client.ts"
                  ? 'new URL("./worker.ts", import.meta.url)'
                  : 'new URL("./wasm-worker.ts", import.meta.url)';
        if (!source.includes(marker))
          throw new Error(`Worker URL marker is missing from ${relative}`);
        return {
          contents: source.replace(
            marker,
            `new URL("./workers/${worker.output}", import.meta.url)`,
          ),
          loader: "ts" as const,
        };
      },
    );
  },
};

assertBuild(
  "CLI",
  await Bun.build({
    entrypoints: [path.join(root, "bin/ast-mcp.ts")],
    external: nativeExternals,
    define: providerMetadata,
    format: "esm",
    minify: true,
    outdir,
    plugins: [packagedWorkerPlugin],
    sourcemap: "external",
    target: "bun",
  }),
);

for (const worker of workers) {
  assertBuild(
    worker.output,
    await Bun.build({
      entrypoints: [path.join(root, worker.entrypoint)],
      external: nativeExternals,
      define: providerMetadata,
      format: "esm",
      minify: true,
      naming: worker.output,
      outdir: workerOutdir,
      sourcemap: "external",
      target: "bun",
    }),
  );
}

// Inspect executable JavaScript only; source maps retain original source paths.
for (const artifact of [
  "ast-mcp.js",
  ...workers.map((worker) => `workers/${worker.output}`),
]) {
  const source = await Bun.file(path.join(outdir, artifact)).text();
  if (/Cannot require module[\s"' +]*@(?:ast-grep|lancedb)\//u.test(source))
    throw new Error(`Native throwing stub in ${artifact}`);
  if (
    /(?:[A-Za-z]:[\\/]|\/)[^"'\r\n]*node_modules[\\/]@ast-grep[\\/]lang-/u.test(
      source,
    )
  )
    throw new Error(`Build-machine grammar path in ${artifact}`);
}

const treeSitterAssets = path.join(root, "node_modules", "tree-sitter-wasm");
await Promise.all([
  copyFile(
    path.join(treeSitterAssets, "manifest.json"),
    path.join(workerOutdir, "manifest.json"),
  ),
  copyFile(
    path.join(root, "node_modules", "web-tree-sitter", "web-tree-sitter.wasm"),
    path.join(workerOutdir, "web-tree-sitter.wasm"),
  ),
]);
for (const grammar of grammarAssets) {
  const grammarDirectory = path.join(workerOutdir, "out", grammar);
  await mkdir(grammarDirectory, { recursive: true });
  await copyFile(
    resolveWasmGrammarAsset(grammar),
    path.join(grammarDirectory, `tree-sitter-${grammar}.wasm`),
  );
}

import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { BunPlugin } from "bun";

const root = path.resolve(import.meta.dir, "..");
const outdir = path.join(root, "dist");
const workerOutdir = path.join(outdir, "workers");
const grammarAssets = [
  "bash",
  "c",
  "c_sharp",
  "commonlisp",
  "cpp",
  "dart",
  "elixir",
  "go",
  "groovy",
  "java",
  "julia",
  "kotlin",
  "lua",
  "objc",
  "ocaml",
  "php",
  "powershell",
  "python",
  "r",
  "ruby",
  "rust",
  "scala",
  "swift",
  "systemverilog",
  "zig",
] as const;
const workers = [
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
          /src[\\/]+intelligence[\\/]+languages[\\/]+(?:dynamic[\\/]+analyzer|legacy[\\/]+analyzer|(?:infra|jvm|systems)[\\/]+worker-client)\.ts$/,
      },
      async ({ path: filePath }: { path: string }) => {
        const relative = path
          .relative(root, filePath)
          .split(path.sep)
          .join("/");
        const worker = workers.find((item) => item.client === relative);
        if (!worker) return;
        const source = await Bun.file(filePath).text();
        const marker = 'new URL("./wasm-worker.ts", import.meta.url)';
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
      format: "esm",
      minify: true,
      naming: worker.output,
      outdir: workerOutdir,
      sourcemap: "external",
      target: "bun",
    }),
  );
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
    path.join(treeSitterAssets, "out", grammar, `tree-sitter-${grammar}.wasm`),
    path.join(grammarDirectory, `tree-sitter-${grammar}.wasm`),
  );
}

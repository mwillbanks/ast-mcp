import { resolve } from "node:path";

export function discoverTestFiles(root = process.cwd()): string[] {
  const files = ["tests", "templates"]
    .flatMap((directory) =>
      [
        ...new Bun.Glob("**/*.test.ts").scanSync({
          cwd: resolve(root, directory),
          onlyFiles: true,
        }),
      ].map((file) => `${directory}/${file.replaceAll("\\", "/")}`),
    )
    .sort();
  if (files.length === 0)
    throw new Error("No package test files were discovered");
  return files;
}

export function selectTestShard(
  files: readonly string[],
  shard: number,
  shards: number,
): string[] {
  if (
    !Number.isInteger(shards) ||
    shards < 1 ||
    !Number.isInteger(shard) ||
    shard < 0 ||
    shard >= shards
  ) {
    throw new Error(
      "Shard must be a zero-based integer smaller than the positive shard count",
    );
  }
  return files.filter((_, index) => index % shards === shard);
}

export function runTestShard(
  args = process.argv.slice(2),
  root = process.cwd(),
  output: "inherit" | "ignore" = "inherit",
): number {
  if (args.length !== 4 || args[0] !== "--shard" || args[2] !== "--shards") {
    throw new Error(
      "Usage: bun scripts/testing/test-shard.ts --shard <zero-based index> --shards <count>",
    );
  }
  const shard = Number(args[1]);
  const shards = Number(args[3]);
  const files = selectTestShard(discoverTestFiles(root), shard, shards);
  if (files.length === 0) throw new Error(`Test shard ${shard} is empty`);
  if (output === "inherit")
    console.log(
      `Running test shard index ${shard} of ${shards}: ${files.length} files`,
    );
  const result = Bun.spawnSync({
    cwd: root,
    cmd: [
      process.execPath,
      "test",
      "--dots",
      "--max-concurrency=1",
      "--timeout=30000",
      ...files,
    ],
    stderr: output,
    stdin: "inherit",
    stdout: output,
  });
  return result.exitCode ?? 1;
}

if (import.meta.main) process.exit(runTestShard());

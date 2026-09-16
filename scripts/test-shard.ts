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

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--shard" || args[2] !== "--shards") {
    throw new Error(
      "Usage: bun scripts/test-shard.ts --shard <zero-based index> --shards <count>",
    );
  }
  const shard = Number(args[1]);
  const shards = Number(args[3]);
  const files = selectTestShard(discoverTestFiles(), shard, shards);
  if (files.length === 0) throw new Error(`Test shard ${shard} is empty`);
  console.log(
    `Running test shard ${shard + 1}/${shards}: ${files.length} files`,
  );
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "test",
      "--max-concurrency=1",
      "--timeout=30000",
      ...files,
    ],
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  process.exit(result.exitCode ?? 1);
}

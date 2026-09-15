import { describe, expect, test } from "bun:test";
import { discoverTestFiles, selectTestShard } from "../scripts/test-shard";

describe("package test shards", () => {
  test("cover every package and template test exactly once", () => {
    const files = discoverTestFiles();
    const shards = [0, 1, 2].map((shard) => selectTestShard(files, shard, 3));
    const combined = shards.flat();
    expect(combined.length).toBe(files.length);
    expect(new Set(combined).size).toBe(files.length);
    expect(combined.sort()).toEqual(files);
    expect(files).toContain("tests/test-shard.test.ts");
    expect(files).toContain("tests/package-smoke.test.ts");
    expect(
      shards.filter((shard) => shard.includes("tests/package-smoke.test.ts")),
    ).toHaveLength(1);
    expect(files).toContain("templates/skills/ast-mcp/evals/source.test.ts");
  });

  test("reject invalid shard coordinates", () => {
    expect(() => selectTestShard(["one"], -1, 3)).toThrow();
    expect(() => selectTestShard(["one"], 3, 3)).toThrow();
    expect(() => selectTestShard(["one"], 0, 0)).toThrow();
  });
});

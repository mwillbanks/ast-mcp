import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverTestFiles,
  runTestShard,
  selectTestShard,
} from "../scripts/test-shard";

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

  test("runs selected fixture tests and propagates runner failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "ast-mcp-shard-runner-"));
    try {
      await Promise.all([
        mkdir(join(root, "tests")),
        mkdir(join(root, "templates")),
      ]);
      const fixture = join(root, "tests", "fixture.test.ts");
      await writeFile(
        fixture,
        'import { expect, test } from "bun:test"; test("fixture", () => expect(1).toBe(1));',
      );
      expect(runTestShard(["--shard", "0", "--shards", "1"], root)).toBe(0);
      await writeFile(
        fixture,
        'import { test } from "bun:test"; test("fixture", () => { throw new Error("intentional shard failure"); });',
      );
      expect(runTestShard(["--shard", "0", "--shards", "1"], root)).not.toBe(0);
      expect(() =>
        runTestShard(["--shard", "1", "--shards", "2"], root),
      ).toThrow("Test shard 1 is empty");
      expect(() => runTestShard([], root)).toThrow("Usage:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reject invalid shard coordinates", () => {
    expect(() => selectTestShard(["one"], -1, 3)).toThrow();
    expect(() => selectTestShard(["one"], 3, 3)).toThrow();
    expect(() => selectTestShard(["one"], 0, 0)).toThrow();
  });
});

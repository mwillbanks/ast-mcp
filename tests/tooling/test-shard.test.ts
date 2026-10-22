import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverTestFiles,
  runTestShard,
  selectTestShard,
} from "../../scripts/testing/test-shard";

describe("package test shards", () => {
  test("cover every package and template test exactly once", () => {
    const files = discoverTestFiles();
    const shards = [0, 1, 2].map((shard) => selectTestShard(files, shard, 3));
    const combined = shards.flat();
    expect(combined.length).toBe(files.length);
    expect(new Set(combined).size).toBe(files.length);
    expect(combined.sort()).toEqual(files);
    expect(files).toContain("tests/tooling/test-shard.test.ts");
    expect(files).toContain("tests/tooling/package-smoke.test.ts");
    expect(
      shards.filter((shard) =>
        shard.includes("tests/tooling/package-smoke.test.ts"),
      ),
    ).toHaveLength(1);
    expect(files).toContain("templates/skills/ast-mcp/evals/source.test.ts");
  });

  test("discovers nested domains and allocates each file exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "ast-mcp-nested-shards-"));
    const expected = [
      "tests/config/index.test.ts",
      "tests/intelligence/languages/web/index.test.ts",
      "tests/integration/mcp.test.ts",
      "tests/tooling/test-shard.test.ts",
      "templates/skills/ast-mcp/evals/source.test.ts",
    ].sort();
    try {
      for (const relative of [...expected, "tests/fixtures/not-a-test.ts"]) {
        const parts = relative.split("/");
        await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
        await writeFile(join(root, relative), "");
      }
      const discovered = discoverTestFiles(root);
      expect(discovered).toEqual(expected);
      for (const count of [2, 3, 5]) {
        const shards = Array.from({ length: count }, (_, shard) =>
          selectTestShard(discovered, shard, count),
        );
        expect(shards.flat().sort()).toEqual(expected);
        expect(new Set(shards.flat()).size).toBe(expected.length);
        const lengths = shards.map((shard) => shard.length);
        expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(
          1,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      expect(
        runTestShard(["--shard", "0", "--shards", "1"], root, "ignore"),
      ).toBe(0);
      await writeFile(
        fixture,
        'import { test } from "bun:test"; test("fixture", () => { throw new Error("intentional shard failure"); });',
      );
      expect(
        runTestShard(["--shard", "0", "--shards", "1"], root, "ignore"),
      ).not.toBe(0);
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

test("reports an empty inventory and announces inherited-output execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "ast-mcp-empty-shard-"));
  try {
    await mkdir(join(root, "tests"));
    await mkdir(join(root, "templates"));
    expect(() => discoverTestFiles(root)).toThrow("No package test files");
    await writeFile(
      join(root, "tests/fixture.test.ts"),
      'import {test} from "bun:test"; test("fixture", () => {});',
    );
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(runTestShard(["--shard", "0", "--shards", "1"], root)).toBe(0);
      expect(log).toHaveBeenCalledWith(
        "Running test shard index 0 of 1: 1 files",
      );
    } finally {
      log.mockRestore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

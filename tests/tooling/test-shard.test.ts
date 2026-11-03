import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverTestFiles,
  runTestShard,
  selectTestShard,
} from "../../scripts/testing/test-shard";

async function testProject(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { scripts: { test: string; "test:coverage": string } };
  await Promise.all([
    mkdir(join(root, "tests")),
    mkdir(join(root, "templates")),
    writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          test: manifest.scripts.test,
          "test:coverage": manifest.scripts["test:coverage"],
        },
      }),
    ),
  ]);
  return root;
}

describe("package test shards", () => {
  test("cover every package and template test exactly once", () => {
    const files = discoverTestFiles();
    const shards = [0, 1, 2].map((shard) => selectTestShard(files, shard, 3));
    const combined = shards.flat();
    expect(combined.length).toBe(files.length);
    expect(new Set(combined).size).toBe(files.length);
    expect(combined.sort()).toEqual(files);
    expect(files).toContain("tests/tooling/test-shard.test.ts");
    expect(files).toContain("tests/integration/package-consumers.test.ts");
    expect(
      shards.filter((shard) =>
        shard.includes("tests/integration/package-consumers.test.ts"),
      ),
    ).toHaveLength(1);
    expect(files).toContain("templates/skills/ast-mcp/evals/source.test.ts");
  });

  test("discovers nested domains and allocates each file exactly once", async () => {
    const root = await testProject("ast-mcp-nested-shards-");
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
          selectTestShard(discovered, shard, count, {}),
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
    const root = await testProject("ast-mcp-shard-runner-");
    const previous = process.env.AST_MCP_SELECTED_TESTS;
    try {
      const fixture = join(root, "tests", "fixture.test.ts");
      await writeFile(
        fixture,
        'import { expect, test } from "bun:test"; test("fixture", () => expect(1).toBe(1));',
      );
      expect(
        runTestShard(["--shard", "0", "--shards", "1"], root, "ignore"),
      ).toBe(0);
      await writeFile(
        join(root, "tests", "unselected.test.ts"),
        'import { test } from "bun:test"; test("unselected", () => { throw new Error("must remain unselected"); });',
      );
      process.env.AST_MCP_SELECTED_TESTS = JSON.stringify([
        "tests/fixture.test.ts",
      ]);
      expect(runTestShard(["--selected"], root, "ignore")).toBe(0);
      await writeFile(
        fixture,
        'import { test } from "bun:test"; test("fixture", () => { throw new Error("intentional shard failure"); });',
      );
      expect(
        runTestShard(["--shard", "0", "--shards", "1"], root, "ignore"),
      ).not.toBe(0);
      expect(runTestShard(["--selected"], root, "ignore")).not.toBe(0);
      expect(() =>
        runTestShard(["--shard", "2", "--shards", "3"], root),
      ).toThrow("Test shard 2 is empty");
      expect(() => runTestShard([], root)).toThrow("Usage:");
    } finally {
      if (previous === undefined) delete process.env.AST_MCP_SELECTED_TESTS;
      else process.env.AST_MCP_SELECTED_TESTS = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("coverage entrypoint enforces coverage while ordinary tests remain independent", async () => {
    const root = await testProject("ast-mcp-coverage-entrypoint-");
    try {
      const config = Bun.TOML.parse(
        await readFile(new URL("../../bunfig.toml", import.meta.url), "utf8"),
      ) as { test: { coverageThreshold: number } };
      await mkdir(join(root, "src"));
      await Promise.all([
        writeFile(
          join(root, "bunfig.toml"),
          `[test]\ncoverageThreshold = ${config.test.coverageThreshold}\ncoverageSkipTestFiles = true\n`,
        ),
        writeFile(
          join(root, "src/application.ts"),
          "export function first() {\n  return 1;\n}\nexport function second() {\n  return 2;\n}\n",
        ),
        writeFile(
          join(root, "tests/application.test.ts"),
          'import { expect, test } from "bun:test"; import { first, second } from "../src/application"; test("application", () => { expect(first()).toBe(1); expect(second()).toBe(2); });',
        ),
      ]);
      expect(
        Bun.spawnSync({
          cmd: [process.execPath, "run", "test:coverage"],
          cwd: root,
          stdout: "ignore",
          stderr: "ignore",
        }).exitCode,
      ).toBe(0);
      await writeFile(
        join(root, "tests/application.test.ts"),
        'import { expect, test } from "bun:test"; import { first } from "../src/application"; test("application", () => expect(first()).toBe(1));',
      );
      expect(
        Bun.spawnSync({
          cmd: [process.execPath, "run", "test:coverage"],
          cwd: root,
          stdout: "ignore",
          stderr: "ignore",
        }).exitCode,
      ).not.toBe(0);
      expect(
        Bun.spawnSync({
          cmd: [process.execPath, "run", "test"],
          cwd: root,
          stdout: "ignore",
          stderr: "ignore",
        }).exitCode,
      ).toBe(0);
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

  test("balances measured durations independently of inventory order", () => {
    const files = ["a", "b", "c", "d", "e"];
    const weights = { a: 10, b: 9, c: 2, d: 2, e: 1 };
    const shards = [0, 1].map((index) =>
      selectTestShard(files, index, 2, weights),
    );
    expect(shards.flat().sort()).toEqual(files);
    expect(
      shards.map((group) =>
        group.reduce(
          (sum, file) => sum + weights[file as keyof typeof weights],
          0,
        ),
      ),
    ).toEqual([12, 12]);
    expect(selectTestShard([...files].reverse(), 0, 2, weights)).toEqual(
      shards[0],
    );
    expect(() => selectTestShard(["a", "a"], 0, 2)).toThrow("unique");
    expect(() => selectTestShard(["a"], 0, 1, { a: 0 })).toThrow("positive");
  });

  test("reject invalid shard coordinates", () => {
    expect(() => selectTestShard(["one"], -1, 3)).toThrow();
    expect(() => selectTestShard(["one"], 3, 3)).toThrow();
    expect(() => selectTestShard(["one"], 0, 0)).toThrow();
  });
});

test("reports an empty inventory and announces inherited-output execution", async () => {
  const root = await testProject("ast-mcp-empty-shard-");
  try {
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

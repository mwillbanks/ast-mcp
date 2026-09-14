import { expect, test } from "bun:test";
import path from "node:path";

test("qualifies native intelligence dependencies without downloading a model", async () => {
  const script = path.join(
    process.cwd(),
    "scripts",
    "qualify-intelligence-deps.ts",
  );
  const child = Bun.spawn([process.execPath, "run", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AST_MCP_QUALIFY_EMBEDDINGS: "0",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  const result = JSON.parse(stdout);

  expect(result.ast.language).toBe("TypeScript");
  expect(result.ast.matches).toBe(1);
  expect(result.ast.rootKind).toBe("program");
  expect(result.ast.grammarCount).toBe(26);
  expect(result.ast.grammars).toHaveLength(26);
  expect(
    result.ast.grammars.some(
      (grammar: { language: string }) =>
        grammar.language === "json" || grammar.language === "jsonc",
    ),
  ).toBe(false);
  for (const grammar of result.ast.grammars) {
    expect(grammar.grammarVersion).toBeString();
    expect(grammar.language).toBeString();
    expect(grammar.rootKind).toBeString();
  }
  expect(result.embedding.status).toBe("skipped");
  expect(result.embedding.reason).toMatch(/never download models/);
  expect(result.storage.baselineCount).toBe(1);
  expect(result.storage.currentCount).toBe(2);
  expect(result.storage.deletedRemaining).toBe(0);
  expect(result.storage.ftsMatches).toBeGreaterThanOrEqual(1);
  expect(result.storage.historicalCount).toBe(1);
  expect(result.storage.latestVersion).toBeGreaterThan(3);
  expect(result.storage.updatedText).toBe("search updated revision");
  expect(result.storage.vectorNearestId).toBe("baseline");
}, 120_000);

test("fails closed when required comparators are unavailable", async () => {
  const child = Bun.spawn(
    [process.execPath, "run", "scripts/benchmark-intelligence-baseline.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AST_MCP_DISABLE_COMPARATORS: "1",
        AST_MCP_REQUIRE_COMPARATORS: "1",
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("Required comparator evidence is unavailable");
}, 120_000);

test("benchmarks live tools, storage, cache reuse, and isolation", async () => {
  const child = Bun.spawn(
    [process.execPath, "run", "scripts/benchmark-intelligence-baseline.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AST_MCP_DISABLE_COMPARATORS: "1",
        AST_MCP_REQUIRE_COMPARATORS: "0",
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.schema).toBe("ast-mcp.intelligence-benchmark.v4");
  expect(result.agentEfficiency.executedTasks).toBe(3);
  expect(result.agentEfficiency.measuredOutputCapBytes).toBe(2_000);
  expect(result.agentEfficiency.resultLimit).toBe(10);
  expect(result.agentEfficiency.tasks).toHaveLength(3);
  expect(
    result.agentEfficiency.tasks.map((task: { id: string }) => task.id),
  ).toEqual(["symbols", "main-callees", "wrapper-callees"]);
  for (const task of result.agentEfficiency.tasks) {
    expect(task.measuredOutputCapBytes).toBe(
      result.agentEfficiency.measuredOutputCapBytes,
    );
    expect(task.resultLimit).toBe(result.agentEfficiency.resultLimit);
    expect(task.native.id).toBe(task.id);
    expect(task.native.operations).toHaveLength(1);
    expect(task.native.answer).toEqual(task.expected);
    expect(task.native.success).toBe(true);
    expect(task.native.operations[0].appliedResultLimit).toBe(task.resultLimit);
    expect(task.native.operations[0].returnedBytes).toBeLessThanOrEqual(
      task.measuredOutputCapBytes,
    );
    if (task.baseline) {
      expect(task.baseline.id).toBe(task.id);
      expect(task.baseline.operations).toHaveLength(1);
      expect(task.baseline.answer).toEqual(task.expected);
      expect(task.baseline.success).toBe(true);
      expect(task.baseline.operations[0].appliedResultLimit).toBe(
        task.resultLimit,
      );
      expect(task.baseline.operations[0].returnedBytes).toBeLessThanOrEqual(
        task.measuredOutputCapBytes,
      );
    } else {
      expect(result.agentEfficiency.gateAvailable).toBe(false);
    }
  }
  if (result.agentEfficiency.gateAvailable) {
    expect(result.agentEfficiency.gatePassed).toBe(true);
    expect(result.agentEfficiency.successRateBaseline).toBe(1);
    expect(result.agentEfficiency.successRateReplacement).toBe(1);
    expect(result.agentEfficiency.replacementMedianCalls).toBe(
      result.agentEfficiency.baselineMedianCalls,
    );
    expect(result.agentEfficiency.replacementMedianReturnedBytes).toBeLessThan(
      result.agentEfficiency.baselineMedianReturnedBytes,
    );
    expect(result.agentEfficiency.reductionPercent).toBe(0);
    expect(result.agentEfficiency.byteReductionPercent).toBeGreaterThanOrEqual(
      20,
    );
  } else {
    expect(result.agentEfficiency.gatePassed).toBe(false);
    expect(result.agentEfficiency.baseline.status).toBe("unavailable");
  }
  if (result.comparators.graphify.status === "unavailable") {
    expect(result.comparators.graphify.reason).toBeString();
  } else {
    expect(result.comparators.graphify.version).toContain("0.9.53");
    expect(result.comparators.graphify.success).toBe(true);
    expect(result.comparators.graphify.setupOperations).toHaveLength(1);
    expect(result.comparators.graphify.setupOperations[0].command).toBe(
      "graphify index",
    );
    expect(result.comparators.graphify.tasks).toHaveLength(3);
    for (const [index, task] of result.comparators.graphify.tasks.entries()) {
      expect(task.id).toBe(result.agentEfficiency.tasks[index].id);
      expect(task.answer).toEqual(result.agentEfficiency.tasks[index].expected);
      expect(task.success).toBe(true);
      expect(task.operations).toHaveLength(1);
      expect(task.operations[0].command).toBe("graphify query");
      expect(task.operations[0].appliedTokenBudget).toBe(2_000);
    }
  }
  expect(result.comparators.required).toBe(false);
  expect(result.indexing.cold.embeddingCache.misses).toBe(2);
  expect(result.indexing.cold.embeddingCache.hits).toBe(0);
  expect(result.indexing.warm.embeddingCache.hits).toBe(2);
  expect(result.indexing.warm.embeddingCache.misses).toBe(0);
  expect(result.indexing.cold.latencyMs).toBeGreaterThan(0);
  expect(result.indexing.warm.latencyMs).toBeGreaterThan(0);
  expect(result.indexing.native.coldLatencyMs).toBeGreaterThan(0);
  expect(result.indexing.native.warmLatencyMs).toBeGreaterThan(0);
  expect(result.indexing.native.resultsReused).toBe(true);
  expect(result.indexing.parser.cold.latencyMs).toBeGreaterThan(0);
  expect(result.indexing.parser.cold.cache.bytes).toBeGreaterThan(0);
  expect(result.indexing.parser.cold.cache.entries).toBe(2);
  expect(result.indexing.parser.cold.cache.evictions).toBe(0);
  expect(result.indexing.parser.cold.cache.hits).toBe(0);
  expect(result.indexing.parser.cold.cache.misses).toBe(2);
  expect(result.indexing.parser.warm.latencyMs).toBeGreaterThan(0);
  expect(result.indexing.parser.warm.cache.bytes).toBe(
    result.indexing.parser.cold.cache.bytes,
  );
  expect(result.indexing.parser.warm.cache.entries).toBe(2);
  expect(result.indexing.parser.warm.cache.evictions).toBe(0);
  expect(result.indexing.parser.warm.cache.hits).toBe(2);
  expect(result.indexing.parser.warm.cache.misses).toBe(0);
  expect(result.indexing.parser.resultsReused).toBe(true);
  expect(result.indexing.parser.reusePercent).toBe(100);
  expect(result.indexing.embeddingInputReuse).toBe(true);
  expect(result.indexing.embeddingPublicationsDistinct).toBe(true);
  expect(result.indexing.indexGrowthBytes).toBeGreaterThan(0);
  expect(result.indexing.publicationCount).toBe(2);
  expect(result.indexing.publishedRows).toBe(4);
  expect(result.indexing.queryExecuted).toBe(true);
  expect(result.indexing.vectorNearestArtifactId).toStartWith(
    "embedding-model-space:v1:",
  );
  expect(result.lifecycle.buildGeneration).toMatch(
    /^generation:v1:[a-f0-9]{64}$/,
  );
  expect(result.lifecycle.generation).toBe(result.lifecycle.buildGeneration);
  expect(result.lifecycle.counts.artifacts).toBeGreaterThan(0);
  expect(result.lifecycle.counts.chunks).toBeGreaterThan(0);
  expect(result.lifecycle.counts.publications).toBeGreaterThan(0);
  expect(result.lifecycle.retrievedItems).toBeGreaterThan(0);
  expect(result.lifecycle.statusCoverage).toEqual(
    expect.objectContaining({ exhaustive: true, truncated: false }),
  );
  expect(result.memory.peakRssBytes).toBeGreaterThan(0);
  expect(result.isolation.assertionsExecuted).toBe(10);
  expect(result.isolation.firstMapSuccess).toBe(true);
  expect(result.isolation.secondMapSuccess).toBe(true);
  expect(result.isolation.gatePassed).toBe(true);
  expect(result.isolation.guardedWriteError).toBeNull();
  expect(result.isolation.guardedWriteSuccess).toBe(true);
  expect(result.isolation.siblingDenied).toBe(true);
  expect(result.isolation.selectedRootsDistinct).toBe(true);
  expect(result.isolation.wrongWorktreeWrites).toBe(0);
  expect(result.isolation.crossScopeViolations).toBe(0);
}, 120_000);

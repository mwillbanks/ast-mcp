import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const benchmarkPath = new URL(
  "../../scripts/benchmark/benchmark-file-operations.ts",
  import.meta.url,
).pathname;
const { parseOptions, summarize } = await import(benchmarkPath);

test("benchmark workers validate every bounded operation in process and restore environment", async () => {
  const { worker, OPERATIONS } = await import(benchmarkPath);
  const before = Object.fromEntries(
    ["AST_MCP_ROOTS", "AST_MCP_ALLOW_EXTERNAL_ROOTS", "AST_MCP_TELEMETRY"].map(
      (name) => [name, process.env[name]],
    ),
  );
  for (const operation of OPERATIONS) {
    const sample = await worker(
      operation,
      4096,
      "dense",
      "blob",
      3,
      operation === "soak" ? 1 : 0,
    );
    expect(sample.success, JSON.stringify(sample)).toBe(true);
    expect(sample.operation).toBe(operation);
    expect(sample.durationMs).toBeGreaterThan(0);
    if (operation.startsWith("durable-") || operation === "recovery") {
      expect(sample.durableValidation.snapshotDirectories).toBe(0);
      expect(sample.durableValidation.journalStates.length).toBeGreaterThan(0);
    }
    if (operation === "soak") {
      expect(sample.retention).toHaveLength(3);
      expect(sample.settledRetention.requestedIdleMs).toBe(1);
    }
  }
  for (const operation of ["snapshot", "journal", "recovery"]) {
    const sample = await worker(operation, 4096, "dense", "legacy", 3, 0);
    expect(sample.success, JSON.stringify(sample)).toBe(true);
  }
  expect((await worker("hash", 4096, "sparse", "blob", 3, 0)).success).toBe(
    true,
  );
  const failedRead = await worker("read", 4096, "sparse", "blob", 3, 0);
  expect(failedRead.success).toBe(false);
  expect(failedRead.phase).toBe("operation");
  const failedSetup = await worker("invalid", 4096, "dense", "blob", 3, 0);
  expect(failedSetup.success).toBe(false);
  expect(failedSetup.phase).toBe("setup");
  expect(failedSetup.durationMs).toBe(0);
  for (const [name, value] of Object.entries(before))
    expect(process.env[name]).toBe(value);
}, 60000);

test("configuration write failure removes temporary data and restores defined and absent environment values", async () => {
  const { worker } = await import(benchmarkPath);
  const names = [
    "AST_MCP_ROOTS",
    "AST_MCP_ALLOW_EXTERNAL_ROOTS",
    "AST_MCP_TELEMETRY",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const originalRoot = await mkdtemp(
    path.join(os.tmpdir(), "ast-benchmark-original-"),
  );
  const originalPath = path.join(originalRoot, "original.bin");
  await writeFile(originalPath, "original data");
  try {
    for (const initial of [undefined, "existing value"]) {
      for (const name of names) {
        if (initial === undefined) delete process.env[name];
        else process.env[name] = initial;
      }
      let temporaryRoot = "";
      const sample = await worker("delete", 4096, "dense", "blob", 3, 0, {
        writeConfiguration: async (filePath: string, content: string) => {
          temporaryRoot = path.dirname(filePath);
          expect(
            await stat(path.join(temporaryRoot, "fixture.bin")).catch(
              (error: NodeJS.ErrnoException) => error.code,
            ),
          ).toBe("ENOENT");
          await mkdir(filePath);
          // Exercise a real configuration write error, before source generation.
          return writeFile(filePath, content);
        },
      });
      expect(sample.success).toBe(false);
      expect(sample.phase).toBe("setup");
      expect(sample.durationMs).toBe(0);
      expect(sample.error).toContain("EISDIR");
      expect(temporaryRoot).not.toBe("");
      expect(
        await stat(temporaryRoot).catch(
          (error: NodeJS.ErrnoException) => error.code,
        ),
      ).toBe("ENOENT");
      expect(await readFile(originalPath, "utf8")).toBe("original data");
      for (const name of names) expect(process.env[name]).toBe(initial);
    }
  } finally {
    await rm(originalRoot, { recursive: true, force: true });
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}, 30000);

test("benchmark main emits worker and orchestrated reports and failure exit status", async () => {
  const { main } = await import(benchmarkPath);
  const captured: string[] = [];
  const previousLog = console.log;
  const previousExit = process.exitCode;
  console.log = (value: string) => {
    captured.push(value);
  };
  try {
    await expect(
      main(["--bytes=4096", "--iterations=1", "--operations=hash"], {
        workerTimeoutMs: 1,
      }),
    ).rejects.toThrow("Worker hash exited");
    await expect(main(["--worker=invalid"])).rejects.toThrow(
      "Unknown worker operation",
    );
    await main(["--worker=hash", "--bytes=4096"]);
    expect(JSON.parse(captured.pop()!).success).toBe(true);
    await main(["--bytes=4096", "--iterations=1", "--operations=hash"]);
    expect(JSON.parse(captured.pop()!).summaries[0].successes).toBe(1);
    await main([
      "--bytes=4096",
      "--iterations=1",
      "--operations=read",
      "--dataset=sparse",
    ]);
    const failure = JSON.parse(captured.pop()!);
    expect(failure.samples[0].success).toBe(false);
    expect(failure.summaries[0].mibPerSecond).toBeNull();
    expect(process.exitCode).toBe(1);
  } finally {
    console.log = previousLog;
    process.exitCode = previousExit ?? 0;
    expect(process.exitCode).toBe(previousExit ?? 0);
  }
}, 30000);

test("benchmark options and empty summaries remain bounded", () => {
  for (const args of [
    ["bad"],
    ["--=bad"],
    ["--unknown=1"],
    ["--bytes=0"],
    ["--bytes=NaN"],
    ["--iterations=51"],
    ["--soak-requests=2"],
  ])
    expect(() => parseOptions(args)).toThrow();
  expect(summarize([])).toMatchObject({
    bytes: 0,
    samples: 0,
    successes: 0,
    medianMs: 0,
    p95Ms: 0,
    mibPerSecond: null,
    peakRssBytes: 0,
    errors: [],
  });
});

test("benchmark rejects unbounded and invalid workloads before generating files", () => {
  expect(() => parseOptions(["--bytes=2321660787"])).toThrow("allow-large");
  expect(() => parseOptions(["--iterations=0"])).toThrow("iterations");
  expect(() => parseOptions(["--soak-requests=1000"])).toThrow("soak-requests");
  for (const value of ["-1", "60001", "1.5", "NaN"])
    expect(() => parseOptions([`--settle-ms=${value}`])).toThrow("settle-ms");
  expect(parseOptions([]).settleMs).toBe(0);
  expect(parseOptions(["--settle-ms=60000"]).settleMs).toBe(60000);
  expect(() => parseOptions(["--operations=unknown"])).toThrow(
    "Unknown operation",
  );
  expect(() => parseOptions(["--dataset=unknown"])).toThrow("dataset");
  expect(() => parseOptions(["--representation=unknown"])).toThrow(
    "representation",
  );
  expect(parseOptions(["--bytes=2321660787", "--allow-large=true"]).bytes).toBe(
    2321660787,
  );
});

test("benchmark reports failed samples without claiming successful throughput", () => {
  const result = summarize([
    {
      bytes: 1048576,
      dataset: "dense",
      durationMs: 10,
      operation: "hash",
      peakRssBytes: 1024,
      rssBeforeBytes: 512,
      success: true,
    },
    {
      bytes: 1048576,
      dataset: "dense",
      durationMs: 20,
      operation: "hash",
      peakRssBytes: 2048,
      rssBeforeBytes: 512,
      success: false,
      error: "failure",
    },
  ]);
  expect(result.samples).toBe(2);
  expect(result.successes).toBe(1);
  expect(result.mibPerSecond).toBeNull();
  expect(result.errors).toEqual(["failure"]);
  expect(result.peakRssBytes).toBe(2048);
});

test("benchmark exercises the registered hash tool and guarded mutation paths", async () => {
  const process = Bun.spawn(
    [
      Bun.argv[0]!,
      new URL(
        "../../scripts/benchmark/benchmark-file-operations.ts",
        import.meta.url,
      ).pathname,
      "--bytes=65536",
      "--iterations=1",
      "--operations=hash-tool,hash-configured,delete,rename",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const report = JSON.parse(stdout);
  expect(report.schemaVersion).toBe("ast-mcp.file-benchmark.v1");
  expect(report.samples).toHaveLength(4);
  expect(
    report.samples.every((sample: { success: boolean }) => sample.success),
  ).toBe(true);
  expect(report.environment.bun).toBe(Bun.version);
}, 30000);

test("benchmark observes same-process retention and runtime snapshot cleanup", async () => {
  const child = Bun.spawn(
    [
      Bun.argv[0]!,
      benchmarkPath,
      "--bytes=4096",
      "--iterations=1",
      "--operations=soak",
      "--soak-requests=3",
      "--settle-ms=1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const report = JSON.parse(stdout);
  expect(report.samples[0].success).toBe(true);
  expect(report.samples[0].requestCount).toBe(3);
  expect(report.samples[0].retention).toHaveLength(3);
  expect(report.samples[0].settledRetention.requestedIdleMs).toBe(1);
  expect(
    report.samples[0].settledRetention.elapsedIdleMs,
  ).toBeGreaterThanOrEqual(0);
  expect(report.samples[0].settledRetention.heapUsedBytes).toBeGreaterThan(0);
  expect(
    report.samples[0].retention.every(
      (point: { snapshotDirectories: number }) =>
        point.snapshotDirectories === 0,
    ),
  ).toBe(true);
}, 30000);

test("benchmark verifies three-file durable deletion and terminal cleanup", async () => {
  const child = Bun.spawn(
    [
      Bun.argv[0]!,
      benchmarkPath,
      "--bytes=4096",
      "--iterations=1",
      "--operations=durable-batch-delete,durable-rename,recovery",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const report = JSON.parse(stdout);
  expect(report.samples).toHaveLength(3);
  expect(report.samples[0].fileCount).toBe(3);
  expect(report.samples[0].processedBytes).toBe(12288);
  for (const sample of report.samples) {
    expect(sample.success).toBe(true);
    expect(sample.durableValidation.snapshotDirectories).toBe(0);
    expect(sample.durableValidation.journalStates).toHaveLength(1);
    expect(["succeeded", "rolled-back", "recovered"]).toContain(
      sample.durableValidation.journalStates[0],
    );
  }
}, 30000);

test("benchmark exits unsuccessfully when an operation fails", async () => {
  const child = Bun.spawn(
    [
      Bun.argv[0]!,
      benchmarkPath,
      "--bytes=4096",
      "--iterations=1",
      "--operations=read",
      "--dataset=sparse",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(1);
  const report = JSON.parse(stdout);
  expect(report.samples[0].success).toBe(false);
  expect(report.samples[0].phase).toBe("operation");
  expect(report.summaries[0].mibPerSecond).toBeNull();
}, 30000);

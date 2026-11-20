import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  benchmarkCommandIo,
  collectReleaseBenchmarks,
  compareMetric,
  runReleaseBenchmarks,
  releaseBenchmarksCommand,
  renderVerifiedBenchmarkReport,
  verifyReleaseBenchmarks,
  type ReleaseIdentity,
  type Runner,
} from "../../scripts/release/release-benchmarks.ts";

const release: ReleaseIdentity = { tag: "ast-mcp-v0.9.2", sha: "a".repeat(40) };
const previous: ReleaseIdentity = {
  tag: "ast-mcp-v0.9.1",
  sha: "b".repeat(40),
};
const provenance: Runner = {
  os: "linux",
  arch: "x64",
  image: "ubuntu24",
  imageVersion: "20261120.1",
  bun: "1.4.4",
  cpus: 4,
  memoryBytes: 16 * 1024 ** 3,
  runId: "123",
  runAttempt: "1",
};

function phase(attempts: number, p95Ms: number) {
  return {
    attempts,
    correct: attempts,
    p50Ms: p95Ms,
    p95Ms,
    p99Ms: p95Ms,
    failures: [],
    failureCodes: {},
    slowestFailureMs: null,
  };
}

function raw(paired = true) {
  const results = [];
  for (let round = 1; round <= 5; round++)
    for (const count of [1, 4, 16])
      for (const layout of ["same", "mixed"])
        for (const workload of ["read", "write", "indexed"])
          for (const variant of paired
            ? ["baseline", "candidate"]
            : ["baseline"])
            results.push({
              round,
              clients: count,
              layout,
              workload,
              variant,
              valid: true,
              observational: false,
              elapsedMs: count * 200,
              verifiedElapsedMs: count * 220,
              disconnectMs: 10,
              correctWorkflowsPerSecond: 10,
              latency: {
                connect: phase(count, 100),
                workflow: phase(count * 2, 100),
                disconnect: phase(count, 10),
                ...(workload === "read"
                  ? { map: phase(count * 2, 50) }
                  : { file_patch: phase(count * 2, 50) }),
                ...(workload === "indexed"
                  ? {
                      committedRetrieval: phase(count * 2, 20),
                      strictWorkingRetrieval: phase(count, 20),
                    }
                  : {}),
              },
              processMetrics: {
                peakRssKiB: 1024 * 100,
                peakProcesses: count + 1,
                brokerProcessIds: [123],
                sampledCpuSecondsLowerBound: 1,
                cleanupMs: 5,
                postDisconnectProcesses: [],
                postDisconnectRssKiB: 0,
                retainedRssKiB: 0,
                remainingProcessIds: [],
              },
            });
  return {
    base: release.sha,
    bun: provenance.bun,
    platform: "linux",
    arch: "x64",
    host: { cpus: provenance.cpus, memoryBytes: provenance.memoryBytes },
    config: {
      rounds: 5,
      samples: 2,
      clients: [1, 4, 16],
      layout: ["same", "mixed"],
      workload: ["read", "write", "indexed"],
      fixturePolicy: {},
      command: ["/private/previous/ast-mcp", "mcp", "--shared-stdio"],
      ...(paired
        ? {
            compareCommand: [
              "/private/candidate/ast-mcp",
              "mcp",
              "--shared-stdio",
            ],
          }
        : {}),
    },
    results,
  };
}

function report(paired = true) {
  return collectReleaseBenchmarks(
    raw(paired),
    release,
    paired ? previous : null,
    provenance,
  );
}

describe("release benchmark thresholds", () => {
  test("requires both strict boundaries for latency and memory", () => {
    expect(compareMetric("workflowP95Ms", 100, 125).regression).toBe(false);
    expect(compareMetric("workflowP95Ms", 100, 125.01).regression).toBe(true);
    expect(compareMetric("connectP95Ms", 200, 230).regression).toBe(false);
    expect(compareMetric("connectP95Ms", 200, 230.01).regression).toBe(true);
    expect(compareMetric("peakRssMiB", 100, 116).regression).toBe(false);
    expect(compareMetric("peakRssMiB", 100, 116.01).regression).toBe(true);
    expect(compareMetric("peakRssMiB", 200, 230).regression).toBe(false);
    expect(compareMetric("peakRssMiB", 200, 230.01).regression).toBe(true);
  });

  test("treats lower throughput as regression and supports a zero baseline", () => {
    expect(compareMetric("workflowsPerSecond", 10, 8.5).regression).toBe(false);
    expect(compareMetric("workflowsPerSecond", 10, 8.49).regression).toBe(true);
    expect(compareMetric("workflowsPerSecond", 2, 1).regression).toBe(false);
    expect(compareMetric("workflowsPerSecond", 2, 0.99).regression).toBe(true);
    expect(compareMetric("workflowsPerSecond", 10, 20).regression).toBe(false);
    expect(compareMetric("connectP95Ms", 0, 26)).toEqual({
      change: 26,
      changePercent: null,
      regression: true,
    });
    expect(compareMetric("cpuSeconds", 1, 1000).regression).toBe(false);
    expect(compareMetric("disconnectP95Ms", 1, 1000).regression).toBe(false);
  });
});

describe("release benchmark evidence", () => {
  test("establishes a baseline and strips command paths and process identities", () => {
    const result = report(false);
    expect(result.observations).toHaveLength(90);
    expect(result.previousRelease).toBeNull();
    expect(result.comparisons).toHaveLength(108);
    expect(result.comparisons.every((entry) => entry.previous === null)).toBe(
      true,
    );
    expect(verifyReleaseBenchmarks(result, release)).toEqual(result);
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("/private");
    expect(encoded).not.toContain("ProcessIds");
    const markdown = renderVerifiedBenchmarkReport(
      result,
      release.tag,
      release.sha,
    );
    expect(markdown).toContain("## Benchmark comparison");
    expect(markdown).toContain("establishes the hosted benchmark baseline");
    expect(markdown.match(/xychart-beta/g)).toHaveLength(4);
    expect(markdown).toContain("| 16 | mixed | indexed |");
  });

  test("uses median rounds and regenerates comparisons during recovery", () => {
    const input = raw();
    const changed = input.results.find((cell) => cell.variant === "candidate")!;
    changed.latency.workflow = phase(2, 10000);
    const result = collectReleaseBenchmarks(
      input,
      release,
      previous,
      provenance,
    );
    expect(result.observations).toHaveLength(180);
    expect(result.passed).toBe(true);
    expect(
      result.comparisons.find((entry) => entry.metric === "workflowP95Ms")
        ?.current,
    ).toBe(100);
    expect(
      verifyReleaseBenchmarks(JSON.parse(JSON.stringify(result)), release),
    ).toEqual(result);
    expect(
      renderVerifiedBenchmarkReport(result, release.tag, release.sha),
    ).toContain("100.00 → 100.00 (+0.00%)");
  });

  test("rejects provenance, configuration, missing and duplicate cells", () => {
    const wrongHost = raw();
    wrongHost.platform = "darwin";
    expect(() =>
      collectReleaseBenchmarks(wrongHost, release, previous, provenance),
    ).toThrow("provenance");
    expect(() =>
      collectReleaseBenchmarks(raw(), release, previous, {
        ...provenance,
        image: "ubuntu22",
      }),
    ).toThrow("ubuntu-24.04");
    const wrongPolicy = raw();
    Object.assign(wrongPolicy.config.fixturePolicy, { requireHash: false });
    expect(() =>
      collectReleaseBenchmarks(wrongPolicy, release, previous, provenance),
    ).toThrow("configuration");
    const missing = raw();
    missing.results.pop();
    expect(() =>
      collectReleaseBenchmarks(missing, release, previous, provenance),
    ).toThrow("Missing benchmark cells");
    const duplicate = raw();
    duplicate.results[1] = structuredClone(duplicate.results[0]!);
    expect(() =>
      collectReleaseBenchmarks(duplicate, release, previous, provenance),
    ).toThrow("Duplicate");
  });

  test("rejects missing metrics, unsuccessful phases, invalid throughput and retained processes", () => {
    const missing = raw();
    Object.assign(missing.results[0]!.latency.workflow, { p95Ms: undefined });
    expect(() =>
      collectReleaseBenchmarks(missing, release, previous, provenance),
    ).toThrow("p95");
    const invalid = raw();
    invalid.results[0]!.valid = false;
    expect(() =>
      collectReleaseBenchmarks(invalid, release, previous, provenance),
    ).toThrow("Invalid benchmark");
    const phaseFailure = raw();
    phaseFailure.results[0]!.latency.connect.correct = 0;
    expect(() =>
      collectReleaseBenchmarks(phaseFailure, release, previous, provenance),
    ).toThrow("failed connect");
    const throughput = raw();
    throughput.results[0]!.correctWorkflowsPerSecond = 50;
    expect(() =>
      collectReleaseBenchmarks(throughput, release, previous, provenance),
    ).toThrow("Throughput");
    const retained = raw();
    retained.results[0]!.processMetrics.retainedRssKiB = 1;
    expect(() =>
      collectReleaseBenchmarks(retained, release, previous, provenance),
    ).toThrow("retained");
    const sampling = raw();
    sampling.results[0]!.processMetrics.brokerProcessIds = [];
    expect(() =>
      collectReleaseBenchmarks(sampling, release, previous, provenance),
    ).toThrow("Invalid benchmark");
  });

  test("fails closed on altered, mismatched and failed recovery reports", () => {
    const result = report();
    expect(() =>
      verifyReleaseBenchmarks(result, { ...release, sha: previous.sha }),
    ).toThrow("match");
    const altered = structuredClone(result);
    altered.comparisons[0]!.current = 1;
    expect(() => verifyReleaseBenchmarks(altered, release)).toThrow(
      "comparisons",
    );
    const unsafe = structuredClone(result);
    unsafe.observations[0]!.workflowP95Ms = Number.NaN;
    expect(() => verifyReleaseBenchmarks(unsafe, release)).toThrow(
      "workflow p95",
    );
    const failed = raw();
    for (const cell of failed.results)
      if (cell.variant === "candidate")
        cell.latency.workflow = phase(cell.clients * 2, 200);
    const failedReport = collectReleaseBenchmarks(
      failed,
      release,
      previous,
      provenance,
    );
    expect(failedReport.passed).toBe(false);
    expect(() => verifyReleaseBenchmarks(failedReport, release)).toThrow(
      "regression",
    );
    expect(() =>
      renderVerifiedBenchmarkReport(failedReport, release.tag, release.sha),
    ).toThrow("regression");
  });
});

test("collect writes regression evidence before failing and verify/render use the same report", async () => {
  const input = raw();
  for (const cell of input.results)
    if (cell.variant === "candidate")
      cell.latency.workflow = phase(cell.clients * 2, 200);
  const stored = new Map<string, unknown>([["raw.json", input]]);
  const output: string[] = [];
  const io = {
    read: async (path: string) => {
      if (!stored.has(path)) throw new Error("Missing " + path);
      return stored.get(path);
    },
    write: async (path: string, content: string) =>
      stored.set(path, JSON.parse(content)),
    output: (value: string) => {
      output.push(value);
    },
    environment: { ImageOS: "ubuntu24", ImageVersion: "20261120.1" },
  };
  expect(
    await releaseBenchmarksCommand(
      [
        "collect",
        "raw.json",
        "report.json",
        release.tag,
        release.sha,
        previous.tag,
        previous.sha,
      ],
      io,
    ),
  ).toBe(1);
  expect(stored.has("report.json")).toBe(true);
  expect(output.join("")).toContain("Release benchmark gate failed");
  await expect(
    releaseBenchmarksCommand(
      ["verify", "report.json", release.tag, release.sha],
      io,
    ),
  ).rejects.toThrow("regression");
  await expect(
    releaseBenchmarksCommand(
      ["verify", "missing.json", release.tag, release.sha],
      io,
    ),
  ).rejects.toThrow("Missing");
  stored.set("report.json", report(false));
  expect(
    await releaseBenchmarksCommand(
      ["verify", "report.json", release.tag, release.sha],
      io,
    ),
  ).toBe(0);
  expect(
    await releaseBenchmarksCommand(
      ["render", "report.json", release.tag, release.sha],
      io,
    ),
  ).toBe(0);
  expect(output.join("")).toContain("~~~mermaid");
  await expect(
    releaseBenchmarksCommand(
      [
        "collect",
        "raw.json",
        "report.json",
        release.tag,
        release.sha,
        previous.tag,
      ],
      io,
    ),
  ).rejects.toThrow("Usage");
  await expect(
    releaseBenchmarksCommand(
      ["verify", "report.json", release.tag, release.sha, "extra"],
      io,
    ),
  ).rejects.toThrow("Usage");
});

test("rejects malformed evidence boundaries before report publication", () => {
  expect(() =>
    collectReleaseBenchmarks(null, release, previous, provenance),
  ).toThrow("Invalid benchmark output");
  expect(() =>
    collectReleaseBenchmarks(
      raw(),
      { ...release, tag: "v0.9.2" },
      previous,
      provenance,
    ),
  ).toThrow("Invalid release tag");
  expect(() =>
    collectReleaseBenchmarks(raw(), release, previous, {
      ...provenance,
      runId: "invalid\nidentifier",
    }),
  ).toThrow("Invalid run ID");
  expect(() =>
    collectReleaseBenchmarks(raw(), release, release, provenance),
  ).toThrow("Previous release must differ");
  const cases: Array<[string, (input: ReturnType<typeof raw>) => void]> = [
    [
      "Missing benchmark results",
      (input) => {
        Object.assign(input, { results: null });
      },
    ],
    [
      "Unordered workflow",
      (input) => {
        input.results[0]!.latency.workflow.p50Ms = 101;
      },
    ],
    [
      "Invalid observation cell",
      (input) => {
        input.results[0]!.round = 6;
      },
    ],
    [
      "Invalid phase attempt count",
      (input) => {
        Object.assign(input.results[0]!.latency, {
          customPhase: phase(1.5, 10),
        });
      },
    ],
  ];
  for (const [message, mutate] of cases) {
    const input = raw();
    mutate(input);
    expect(() =>
      collectReleaseBenchmarks(input, release, previous, provenance),
    ).toThrow(message);
  }
  const initial = raw(false);
  initial.results[0]!.variant = "candidate";
  expect(() =>
    collectReleaseBenchmarks(initial, release, null, provenance),
  ).toThrow("Unexpected initial benchmark variant");
});

test("rejects malformed persisted reports and renders improvements and zero values", () => {
  const sameRelease = report();
  sameRelease.previousRelease = release;
  expect(() => verifyReleaseBenchmarks(sameRelease, release)).toThrow(
    "Invalid previous release",
  );
  const wrongSettings = report();
  wrongSettings.settings = { ...wrongSettings.settings, rounds: 4 };
  expect(() => verifyReleaseBenchmarks(wrongSettings, release)).toThrow(
    "Unexpected benchmark report settings",
  );
  const missingObservations = report();
  Object.assign(missingObservations, { observations: null });
  expect(() => verifyReleaseBenchmarks(missingObservations, release)).toThrow(
    "Missing report observations",
  );
  const wrongVariant = report(false);
  wrongVariant.observations[0]!.variant = "baseline";
  expect(() => verifyReleaseBenchmarks(wrongVariant, release)).toThrow(
    "Unexpected benchmark variant",
  );
  const input = raw();
  for (const cell of input.results) {
    cell.latency.connect = phase(cell.clients, 0);
    if (cell.variant === "candidate")
      cell.latency.workflow = phase(cell.clients * 2, 90);
  }
  const improved = collectReleaseBenchmarks(
    input,
    release,
    previous,
    provenance,
  );
  const markdown = renderVerifiedBenchmarkReport(
    improved,
    release.tag,
    release.sha,
  );
  expect(markdown).toContain("0.00 → 0.00 (n/a)");
  expect(markdown).toContain("100.00 → 90.00 (-10.00%)");
});

test("collect establishes the initial baseline with complete hosted provenance", async () => {
  const input = raw(false);
  let saved: unknown;
  let output = "";
  const io = {
    read: async () => input,
    write: async (_path: string, content: string) => {
      saved = JSON.parse(content);
    },
    output: (content: string) => {
      output += content;
    },
    environment: {
      ImageOS: "ubuntu24",
      ImageVersion: "20261120.1",
      GITHUB_RUN_ID: "987",
      GITHUB_RUN_ATTEMPT: "2",
    },
  };
  expect(
    await releaseBenchmarksCommand(
      ["collect", "raw.json", "report.json", release.tag, release.sha],
      io,
    ),
  ).toBe(0);
  expect(output).toContain("Release benchmark gate passed");
  expect(verifyReleaseBenchmarks(saved, release).runner).toMatchObject({
    runId: "987",
    runAttempt: "2",
  });
  await expect(releaseBenchmarksCommand([], io)).rejects.toThrow(
    "Invalid benchmark command arguments",
  );
  await expect(
    releaseBenchmarksCommand(
      ["verify", "report.json", release.tag, release.sha, "1", "2", "3", "4"],
      io,
    ),
  ).rejects.toThrow("Invalid benchmark command arguments");
  await expect(
    releaseBenchmarksCommand(
      ["collect", "raw.json", "report.json", release.tag, release.sha],
      { ...io, environment: {} },
    ),
  ).rejects.toThrow("ubuntu-24.04");
});

test("CLI adapters bound JSON input, persist evidence and report command failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ast-release-benchmark-cli-"));
  const file = join(directory, "report.json");
  const oversized = join(directory, "oversized.json");
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await benchmarkCommandIo.write(file, JSON.stringify(report(false)));
    expect(await benchmarkCommandIo.read(file)).toEqual(report(false));
    benchmarkCommandIo.output("adapter output\n");
    expect(stdout).toHaveBeenCalledWith("adapter output\n");
    await benchmarkCommandIo.write(oversized, " ".repeat(8 * 1024 * 1024 + 1));
    await expect(benchmarkCommandIo.read(oversized)).rejects.toThrow(
      "exceeds 8 MiB",
    );
    const errors: string[] = [];
    expect(
      await runReleaseBenchmarks(
        ["verify", file, release.tag, release.sha],
        benchmarkCommandIo,
        (message) => {
          errors.push(message);
        },
      ),
    ).toBe(0);
    expect(errors).toEqual([]);
    expect(
      await runReleaseBenchmarks([], benchmarkCommandIo, (message) => {
        errors.push(message);
      }),
    ).toBe(1);
    expect(errors).toContain("Invalid benchmark command arguments");
    const rejectedRead = {
      ...benchmarkCommandIo,
      read: () => Promise.reject("read refused"),
    };
    expect(
      await runReleaseBenchmarks(
        ["verify", file, release.tag, release.sha],
        rejectedRead,
        (message) => {
          errors.push(message);
        },
      ),
    ).toBe(1);
    expect(errors).toContain("read refused");
  } finally {
    stdout.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

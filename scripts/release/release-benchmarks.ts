const releaseTag = /^ast-mcp-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const commitSha = /^[a-f0-9]{40}$/;
const clients = [1, 4, 16] as const;
const layouts = ["same", "mixed"] as const;
const workloads = ["read", "write", "indexed"] as const;
const schema = "ast-mcp.release-benchmarks.v1";
const settings = { rounds: 5, samples: 2, clients, layouts, workloads };

const metricDefinitions = {
  connectP95Ms: { label: "Connect p95 ms", floor: 25, lower: true },
  workflowP95Ms: { label: "Workflow p95 ms", floor: 25, lower: true },
  peakRssMiB: { label: "Peak RSS MiB", floor: 16, lower: true },
  workflowsPerSecond: { label: "Workflows per second", floor: 1, lower: false },
  cpuSeconds: { label: "CPU seconds lower bound", floor: null, lower: true },
  disconnectP95Ms: { label: "Disconnect p95 ms", floor: null, lower: true },
} as const;

type Metric = keyof typeof metricDefinitions;
type Metrics = Record<Metric, number>;
export type ReleaseIdentity = { tag: string; sha: string };
export type Runner = {
  os: string;
  arch: string;
  image: string;
  imageVersion: string;
  bun: string;
  cpus: number;
  memoryBytes: number;
  runId: string;
  runAttempt: string;
};
export type Observation = Metrics & {
  round: number;
  variant: "baseline" | "candidate";
  clients: number;
  layout: string;
  workload: string;
};
type Comparison = {
  clients: number;
  layout: string;
  workload: string;
  metric: Metric;
  current: number;
  previous: number | null;
  change: number | null;
  changePercent: number | null;
  regression: boolean;
};
export type ReleaseBenchmarkReport = {
  schema: typeof schema;
  release: ReleaseIdentity;
  previousRelease: ReleaseIdentity | null;
  runner: Runner;
  settings: typeof settings;
  observations: Observation[];
  comparisons: Comparison[];
  passed: boolean;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid " + label);
  return value as Record<string, unknown>;
}

function number(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum)
    throw new Error("Invalid " + label);
  return value;
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 200 ||
    /[\r\n|<>]/.test(value)
  )
    throw new Error("Invalid " + label);
  return value;
}

function identity(value: unknown): ReleaseIdentity {
  const input = object(value, "release identity");
  if (
    typeof input.tag !== "string" ||
    !releaseTag.test(input.tag) ||
    typeof input.sha !== "string" ||
    !commitSha.test(input.sha)
  )
    throw new Error("Invalid release tag or commit");
  return { tag: input.tag, sha: input.sha };
}

function runner(value: unknown): Runner {
  const input = object(value, "runner");
  const result: Runner = {
    os: text(input.os, "runner OS"),
    arch: text(input.arch, "runner architecture"),
    image: text(input.image, "runner image"),
    imageVersion: text(input.imageVersion, "runner image version"),
    bun: text(input.bun, "Bun version"),
    cpus: number(input.cpus, "runner CPU count", 1),
    memoryBytes: number(input.memoryBytes, "runner memory", 1),
    runId: text(input.runId, "run ID"),
    runAttempt: text(input.runAttempt, "run attempt"),
  };
  if (
    result.os !== "linux" ||
    result.arch !== "x64" ||
    result.image !== "ubuntu24" ||
    !Number.isInteger(result.cpus)
  )
    throw new Error("Release benchmarks require the ubuntu-24.04 x64 runner");
  return result;
}

function sameSelection(value: unknown, expected: readonly unknown[]) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    new Set(value).size === expected.length &&
    expected.every((item) => value.includes(item))
  );
}

function summary(value: unknown, expected: number, label: string): number {
  const input = object(value, label);
  if (
    input.attempts !== expected ||
    input.correct !== expected ||
    !Array.isArray(input.failures) ||
    input.failures.length ||
    Object.keys(object(input.failureCodes, "failure codes")).length
  )
    throw new Error("Incomplete or failed " + label);
  const p50 = number(input.p50Ms, label + " p50");
  const p95 = number(input.p95Ms, label + " p95");
  const p99 = number(input.p99Ms, label + " p99");
  if (p50 > p95 || p95 > p99) throw new Error("Unordered " + label);
  return p95;
}

function observation(value: unknown): Observation {
  const input = object(value, "observation");
  if (
    !Number.isInteger(input.round) ||
    ![1, 2, 3, 4, 5].includes(input.round as number) ||
    !clients.includes(input.clients as (typeof clients)[number]) ||
    !layouts.includes(input.layout as (typeof layouts)[number]) ||
    !workloads.includes(input.workload as (typeof workloads)[number]) ||
    !["baseline", "candidate"].includes(String(input.variant))
  )
    throw new Error("Invalid observation cell");
  return {
    round: input.round as number,
    variant: input.variant as Observation["variant"],
    clients: input.clients as number,
    layout: input.layout as string,
    workload: input.workload as string,
    connectP95Ms: number(input.connectP95Ms, "connect p95"),
    workflowP95Ms: number(input.workflowP95Ms, "workflow p95"),
    peakRssMiB: number(input.peakRssMiB, "peak RSS", Number.MIN_VALUE),
    workflowsPerSecond: number(
      input.workflowsPerSecond,
      "throughput",
      Number.MIN_VALUE,
    ),
    cpuSeconds: number(input.cpuSeconds, "CPU seconds"),
    disconnectP95Ms: number(input.disconnectP95Ms, "disconnect p95"),
  };
}

function validateCells(observations: Observation[], paired: boolean) {
  const variants = paired ? ["baseline", "candidate"] : ["candidate"];
  const seen = new Set<string>();
  for (const cell of observations) {
    if (!variants.includes(cell.variant))
      throw new Error("Unexpected benchmark variant");
    const key = [
      cell.round,
      cell.variant,
      cell.clients,
      cell.layout,
      cell.workload,
    ].join("/");
    if (seen.has(key)) throw new Error("Duplicate benchmark cell " + key);
    seen.add(key);
  }
  if (
    seen.size !==
    5 * variants.length * clients.length * layouts.length * workloads.length
  )
    throw new Error("Missing benchmark cells");
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export function compareMetric(
  metric: Metric,
  previous: number,
  current: number,
) {
  number(previous, "previous value");
  number(current, "current value");
  const definition = metricDefinitions[metric];
  const change = current - previous;
  const worsening = definition.lower ? change : -change;
  const changePercent = previous === 0 ? null : (change / previous) * 100;
  return {
    change,
    changePercent,
    regression:
      definition.floor !== null &&
      worsening > definition.floor &&
      (previous === 0 || worsening > previous * 0.15),
  };
}

function comparisons(
  observations: Observation[],
  paired: boolean,
): Comparison[] {
  const result: Comparison[] = [];
  for (const count of clients)
    for (const layout of layouts)
      for (const workload of workloads) {
        const cells = observations.filter(
          (cell) =>
            cell.clients === count &&
            cell.layout === layout &&
            cell.workload === workload,
        );
        for (const metric of Object.keys(metricDefinitions) as Metric[]) {
          const current = median(
            cells
              .filter((cell) => cell.variant === "candidate")
              .map((cell) => cell[metric]),
          );
          const previous = paired
            ? median(
                cells
                  .filter((cell) => cell.variant === "baseline")
                  .map((cell) => cell[metric]),
              )
            : null;
          result.push({
            clients: count,
            layout,
            workload,
            metric,
            current,
            previous,
            ...(previous === null
              ? { change: null, changePercent: null, regression: false }
              : compareMetric(metric, previous, current)),
          });
        }
      }
  return result;
}

export function collectReleaseBenchmarks(
  value: unknown,
  release: ReleaseIdentity,
  previousRelease: ReleaseIdentity | null,
  provenance: Runner,
): ReleaseBenchmarkReport {
  const raw = object(value, "benchmark output");
  const current = identity(release);
  const previous = previousRelease === null ? null : identity(previousRelease);
  const host = object(raw.host, "benchmark host");
  const config = object(raw.config, "benchmark configuration");
  const environment = runner(provenance);
  if (
    raw.base !== current.sha ||
    raw.platform !== "linux" ||
    raw.arch !== "x64" ||
    raw.bun !== environment.bun ||
    host.cpus !== environment.cpus ||
    host.memoryBytes !== environment.memoryBytes
  )
    throw new Error(
      "Benchmark provenance does not match the candidate and runner",
    );
  if (
    config.rounds !== 5 ||
    config.samples !== 2 ||
    !sameSelection(config.clients, clients) ||
    !sameSelection(config.layout, layouts) ||
    !sameSelection(config.workload, workloads) ||
    Object.keys(object(config.fixturePolicy, "fixture policy")).length ||
    (previous === null
      ? config.compareCommand !== undefined
      : !Array.isArray(config.compareCommand))
  )
    throw new Error("Unexpected release benchmark configuration");
  if (previous && previous.tag === current.tag)
    throw new Error("Previous release must differ from the candidate");
  if (!Array.isArray(raw.results)) throw new Error("Missing benchmark results");
  const observations = raw.results.map((value) => {
    const cell = object(value, "benchmark cell");
    const latency = object(cell.latency, "latency");
    const process = object(cell.processMetrics, "process metrics");
    if (
      cell.valid !== true ||
      cell.observational !== false ||
      cell.error !== undefined ||
      cell.errorCode !== undefined ||
      !Array.isArray(process.remainingProcessIds) ||
      process.remainingProcessIds.length ||
      !Array.isArray(process.postDisconnectProcesses) ||
      process.postDisconnectProcesses.length ||
      process.retainedRssKiB !== 0 ||
      process.postDisconnectRssKiB !== 0 ||
      !Array.isArray(process.brokerProcessIds) ||
      process.brokerProcessIds.length !== 1
    )
      throw new Error("Invalid benchmark cell or retained processes");
    const count = number(cell.clients, "client count", 1);
    const expected = count * 2;
    if (previous === null && cell.variant !== "baseline")
      throw new Error("Unexpected initial benchmark variant");
    if (cell.workload === "read") summary(latency.map, expected, "map");
    else summary(latency.file_patch, expected, "file_patch");
    if (cell.workload === "indexed") {
      summary(latency.committedRetrieval, expected, "committed retrieval");
      summary(
        latency.strictWorkingRetrieval,
        count,
        "strict working retrieval",
      );
    }
    const throughput = number(
      cell.correctWorkflowsPerSecond,
      "throughput",
      Number.MIN_VALUE,
    );
    const elapsed = number(cell.elapsedMs, "elapsed time", Number.MIN_VALUE);
    number(cell.verifiedElapsedMs, "verified elapsed time", elapsed);
    number(cell.disconnectMs, "disconnect elapsed");
    number(process.cleanupMs, "cleanup elapsed");
    number(process.peakProcesses, "peak process count", 1);
    if (Math.abs(throughput - (expected * 1000) / elapsed) > throughput * 1e-9)
      throw new Error("Throughput does not match completed workflows");
    // Every measured phase must report success, including correctness fences.
    for (const [label, entry] of Object.entries(latency)) {
      const phase = object(entry, label);
      const attempts = number(phase.attempts, "phase attempts", 1);
      if (!Number.isInteger(attempts))
        throw new Error("Invalid phase attempt count");
      summary(phase, attempts, label);
    }
    return observation({
      round: cell.round,
      variant:
        previous === null && cell.variant === "baseline"
          ? "candidate"
          : cell.variant,
      clients: cell.clients,
      layout: cell.layout,
      workload: cell.workload,
      connectP95Ms: summary(latency.connect, count, "connect"),
      workflowP95Ms: summary(latency.workflow, expected, "workflow"),
      disconnectP95Ms: summary(latency.disconnect, count, "disconnect"),
      peakRssMiB:
        number(process.peakRssKiB, "peak RSS", Number.MIN_VALUE) / 1024,
      cpuSeconds: number(process.sampledCpuSecondsLowerBound, "sampled CPU"),
      workflowsPerSecond: throughput,
    });
  });
  validateCells(observations, previous !== null);
  const values = comparisons(observations, previous !== null);
  return {
    schema,
    release: current,
    previousRelease: previous,
    runner: environment,
    settings,
    observations,
    comparisons: values,
    passed: !values.some((entry) => entry.regression),
  };
}

export function verifyReleaseBenchmarks(
  value: unknown,
  expected: ReleaseIdentity,
): ReleaseBenchmarkReport {
  const input = object(value, "benchmark report");
  const release = identity(input.release);
  const target = identity(expected);
  if (
    input.schema !== schema ||
    release.tag !== target.tag ||
    release.sha !== target.sha
  )
    throw new Error("Benchmark report does not match the release");
  const previous =
    input.previousRelease === null ? null : identity(input.previousRelease);
  if (previous?.tag === release.tag)
    throw new Error("Invalid previous release");
  const configuration = object(input.settings, "benchmark settings");
  if (
    configuration.rounds !== 5 ||
    configuration.samples !== 2 ||
    !sameSelection(configuration.clients, clients) ||
    !sameSelection(configuration.layouts, layouts) ||
    !sameSelection(configuration.workloads, workloads)
  )
    throw new Error("Unexpected benchmark report settings");
  if (!Array.isArray(input.observations))
    throw new Error("Missing report observations");
  const observations = input.observations.map(observation);
  validateCells(observations, previous !== null);
  const values = comparisons(observations, previous !== null);
  if (JSON.stringify(input.comparisons) !== JSON.stringify(values))
    throw new Error("Benchmark comparisons do not match observations");
  if (input.passed !== true || values.some((entry) => entry.regression))
    throw new Error("Release benchmark regression");
  return {
    schema,
    release,
    previousRelease: previous,
    runner: runner(input.runner),
    settings,
    observations,
    comparisons: values,
    passed: true,
  };
}

function formatted(value: number) {
  return value.toFixed(2);
}

function display(entry: Comparison) {
  if (entry.previous === null) return formatted(entry.current);
  const percent =
    entry.changePercent === null
      ? "n/a"
      : (entry.changePercent >= 0 ? "+" : "") +
        formatted(entry.changePercent) +
        "%";
  return (
    formatted(entry.previous) +
    " → " +
    formatted(entry.current) +
    " (" +
    percent +
    ")"
  );
}

export function renderVerifiedBenchmarkReport(
  input: unknown,
  tag: string,
  sha: string,
): string {
  return renderBenchmarkSection(verifyReleaseBenchmarks(input, { tag, sha }));
}

export function renderBenchmarkSection(report: ReleaseBenchmarkReport): string {
  const input = verifyReleaseBenchmarks(report, report.release);
  const title = input.previousRelease
    ? input.previousRelease.tag + " → " + input.release.tag
    : input.release.tag + " establishes the hosted benchmark baseline.";
  const lines = [
    "## Benchmark comparison",
    "",
    title,
    "",
    "Measured on Ubuntu 24.04 x64 with Bun " +
      input.runner.bun +
      ". Each result is the median of five rounds with two workflows per client.",
    "Read, guarded-write, and indexed workloads use fresh fixtures at 1, 4, and 16 concurrent clients across one checkout and mixed checkouts.",
    "Peak RSS sums sampled process-tree memory. CPU reports a sampled lower bound.",
    "",
    "| Clients | Checkouts | Workload | Connect p95 ms | Workflow p95 ms | Peak RSS MiB | Workflows/s | CPU seconds | Disconnect p95 ms |",
    "| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const count of clients)
    for (const layout of layouts)
      for (const workload of workloads) {
        const entries = input.comparisons.filter(
          (entry) =>
            entry.clients === count &&
            entry.layout === layout &&
            entry.workload === workload,
        );
        lines.push(
          "| " +
            [count, layout, workload, ...entries.map(display)].join(" | ") +
            " |",
        );
      }
  lines.push(
    "",
    "Charts show the mixed-checkout indexed workload at 1, 4, and 16 clients. The table includes every workload.",
    "",
  );
  for (const metric of [
    "connectP95Ms",
    "workflowP95Ms",
    "peakRssMiB",
    "workflowsPerSecond",
  ] as const) {
    const entries = input.comparisons.filter(
      (entry) =>
        entry.layout === "mixed" &&
        entry.workload === "indexed" &&
        entry.metric === metric,
    );
    lines.push(
      "### " + metricDefinitions[metric].label,
      "",
      "Series order follows the previous release, then the current release.",
      "",
      "~~~mermaid",
      "xychart-beta",
      '    x-axis "Concurrent clients" [1, 4, 16]',
      '    y-axis "' + metricDefinitions[metric].label + '"',
    );
    if (input.previousRelease)
      lines.push(
        "    line [" +
          entries.map((entry) => formatted(entry.previous!)).join(", ") +
          "]",
      );
    lines.push(
      "    line [" +
        entries.map((entry) => formatted(entry.current)).join(", ") +
        "]",
      "~~~",
      "",
    );
  }
  lines.push(
    "The release gate rejects regressions above 15% and the absolute floor. Floors are 25 ms for connection and workflow p95, 16 MiB for RSS, and 1 workflow/s for throughput.",
    "",
    "Candidate commit " +
      input.release.sha +
      ". Runner image " +
      input.runner.image +
      " " +
      input.runner.imageVersion +
      ".",
    "The attached release-benchmarks.json contains the observations and comparison results.",
  );
  return lines.join("\n") + "\n";
}

type CommandIo = {
  read(path: string): Promise<unknown>;
  write(path: string, content: string): Promise<unknown>;
  output(content: string): void;
  environment: Record<string, string | undefined>;
};

export async function releaseBenchmarksCommand(
  args: readonly string[],
  io: CommandIo,
): Promise<number> {
  const [command, source, third, fourth, fifth, sixth, seventh, ...extra] =
    args;
  if (extra.length || !source)
    throw new Error("Invalid benchmark command arguments");
  if (command === "collect") {
    if (!third || !fourth || !fifth || !!sixth !== !!seventh)
      throw new Error(
        "Usage: collect RAW REPORT TAG SHA [PREVIOUS_TAG PREVIOUS_SHA]",
      );
    const raw = object(await io.read(source), "benchmark output");
    const host = object(raw.host, "benchmark host");
    const env = io.environment;
    const report = collectReleaseBenchmarks(
      raw,
      { tag: fourth, sha: fifth },
      sixth && seventh ? { tag: sixth, sha: seventh } : null,
      {
        os: String(raw.platform),
        arch: String(raw.arch),
        bun: String(raw.bun),
        cpus: number(host.cpus, "CPU count", 1),
        memoryBytes: number(host.memoryBytes, "memory", 1),
        image: env.ImageOS ?? "unknown",
        imageVersion: env.ImageVersion ?? "unknown",
        runId: env.GITHUB_RUN_ID ?? "local",
        runAttempt: env.GITHUB_RUN_ATTEMPT ?? "local",
      },
    );
    await io.write(third, JSON.stringify(report, null, 2) + "\n");
    const failures = report.comparisons.filter((entry) => entry.regression);
    io.output(
      report.passed
        ? "Release benchmark gate passed.\n"
        : "Release benchmark gate failed.\n" +
            failures
              .map(
                (entry) =>
                  "- " +
                  [
                    entry.clients,
                    entry.layout,
                    entry.workload,
                    metricDefinitions[entry.metric].label,
                  ].join(" ") +
                  " " +
                  display(entry),
              )
              .join("\n") +
            "\n",
    );
    return report.passed ? 0 : 1;
  }
  if (
    (command !== "verify" && command !== "render") ||
    !third ||
    !fourth ||
    fifth ||
    sixth ||
    seventh
  )
    throw new Error("Usage: verify|render REPORT TAG SHA");
  const report = verifyReleaseBenchmarks(await io.read(source), {
    tag: third,
    sha: fourth,
  });
  io.output(
    command === "render"
      ? renderBenchmarkSection(report)
      : "Release benchmark report verified.\n",
  );
  return 0;
}

export const benchmarkCommandIo: CommandIo = {
  read: async (path) => {
    const file = Bun.file(path);
    if (file.size > 8 * 1024 * 1024)
      throw new Error("Benchmark report exceeds 8 MiB");
    return await file.json();
  },
  write: (path, content) => Bun.write(path, content),
  output: (content) => {
    process.stdout.write(content);
  },
  environment: process.env,
};

export async function runReleaseBenchmarks(
  args: readonly string[],
  io: CommandIo,
  reportError: (message: string) => void,
): Promise<number> {
  try {
    return await releaseBenchmarksCommand(args, io);
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main)
  process.exitCode = await runReleaseBenchmarks(
    Bun.argv.slice(2),
    benchmarkCommandIo,
    console.error,
  );

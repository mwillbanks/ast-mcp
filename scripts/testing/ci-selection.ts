import { appendFileSync } from "node:fs";

import { discoverTestFiles } from "./test-shard.ts";

export const platforms = ["macos-latest", "windows-latest"] as const;
export const nativePlatforms = ["ubuntu-latest", ...platforms] as const;
export const consumerPlatforms = [
  { os: "macos-15", platform: "darwin", arch: "arm64", bun: "1.4.4" },
  { os: "ubuntu-24.04-arm", platform: "linux", arch: "arm64", bun: "1.4.4" },
  { os: "ubuntu-24.04", platform: "linux", arch: "x64", bun: "1.4.4" },
  { os: "windows-2025", platform: "win32", arch: "x64", bun: "1.4.4" },
  { os: "macos-15", platform: "darwin", arch: "arm64", bun: "1.4.3" },
  { os: "ubuntu-24.04-arm", platform: "linux", arch: "arm64", bun: "1.4.3" },
] as const;
export const consumers = consumerPlatforms.flatMap((platform) =>
  ["bun", "npm"].map((installer) => ({ platform, installer })),
);
export interface HistoricalJob {
  name: string;
  conclusion: string | null;
}
export interface HistoricalRun {
  id: number;
  head: string;
  base: string;
  repository: string;
  pr: number;
  conclusion: string | null;
  jobs: HistoricalJob[];
}
export interface SelectionInput {
  repository: string;
  pr: number;
  head: string;
  base: string;
  files: readonly string[];
  history: readonly HistoricalRun[];
  ancestor: (older: string, newer: string) => boolean;
  diff: (older: string, newer: string) => readonly string[];
  sameConfiguration?: (head: string) => boolean;
  historyComplete?: boolean;
}
export interface Selection {
  package: boolean;
  full: boolean;
  reason: string;
  tests: string[];
  coverage: boolean;
  website: boolean;
  platforms: Array<{
    os: string;
    shard: number;
    shards: number;
    selected: boolean;
  }>;
  consumers: typeof consumers;
  native: Array<{ os: string }>;
  acceptancePending: boolean;
}
const coverageName = "Package tests and 95% coverage (Linux)";
const platformName = (os: string, shard: number) =>
  `Package tests (${os}, shard ${shard})`;
const consumerName = (value: (typeof consumers)[number]) =>
  `Consumer (${value.platform.os}, ${value.installer}, Bun ${value.platform.bun})`;
const nativeName = (os: string) => `Native package qualification (${os})`;
export function fullSelection(reason: string, website = false): Selection {
  return {
    package: true,
    full: true,
    reason,
    tests: [],
    coverage: true,
    website,
    platforms: platforms.flatMap((os) =>
      [0, 1, 2].map((shard) => ({ os, shard, shards: 3, selected: false })),
    ),
    consumers: [...consumers],
    native: nativePlatforms.map((os) => ({ os })),
    acceptancePending: false,
  };
}
function documentationOnly(paths: readonly string[]): boolean {
  return (
    paths.length > 0 &&
    paths.every(
      (path) =>
        /^(?:docs|website)\//.test(path) ||
        ["CHANGELOG.md", ".github/workflows/docs.yml"].includes(path),
    )
  );
}
function nonPackageSelection(reason: string): Selection {
  return {
    package: false,
    full: false,
    reason,
    tests: [],
    coverage: false,
    website: false,
    platforms: [],
    consumers: [],
    native: [],
    acceptancePending: false,
  };
}
function acceptanceProvenance(
  name: string,
): { mode: string; pr: number; base: string; website: boolean } | null {
  const match =
    /^(Full|Selected|No package) CI acceptance \[PR ([1-9][0-9]*); base ([a-f0-9]{40}); website (true|false)\]$/.exec(
      name,
    );
  return match
    ? {
        mode: match[1]!,
        pr: Number(match[2]),
        base: match[3]!,
        website: match[4] === "true",
      }
    : null;
}
function normalizedName(name: string): string {
  const proof = acceptanceProvenance(name);
  return proof ? `${proof.mode} CI acceptance` : name;
}
function hasSuccessfulJob(run: HistoricalRun, name: string): boolean {
  // Reusable workflows prefix their child job names.
  const matches = run.jobs.filter(
    (job) =>
      normalizedName(job.name) === name || job.name.endsWith(" / " + name),
  );
  return matches.length === 1 && matches[0]!.conclusion === "success";
}
function qualificationNames(): string[] {
  return [
    coverageName,
    ...platforms.flatMap((os) =>
      [0, 1, 2].map((shard) => platformName(os, shard)),
    ),
    ...consumers.map(consumerName),
    ...nativePlatforms.map(nativeName),
  ];
}
function fullAttempt(run: HistoricalRun, sameConfiguration: boolean): boolean {
  if (run.conclusion === null) return false;
  const matching = (name: string) =>
    run.jobs.filter(
      (job) =>
        normalizedName(job.name) === name || job.name.endsWith(" / " + name),
    ).length;
  // Modern full-mode summary identifies even required jobs that never started.
  // Older workflows need their complete, unambiguous full-job inventory.
  return (
    (sameConfiguration &&
      matching("Full CI acceptance") === 1 &&
      run.jobs.some(
        (job) =>
          normalizedName(job.name) === "Full CI acceptance" &&
          ["success", "failure", "cancelled", "timed_out"].includes(
            job.conclusion ?? "",
          ),
      )) ||
    qualificationNames().every((name) => matching(name) === 1)
  );
}
function scope(
  files: readonly string[],
  available: readonly string[],
): { tests: string[]; allTests: boolean } | null {
  if (!available.length) return null;
  const selected = new Set<string>();
  let allTests = false;
  for (const file of files) {
    if (
      [
        "tests/tooling/package-smoke.test.ts",
        "tests/tooling/ci-selection.test.ts",
        "tests/tooling/test-shard.test.ts",
        "tests/tooling/release-workflows.test.ts",
      ].includes(file)
    )
      return null;
    if (/^(tests|templates)\/.*\.test\.ts$/.test(file)) {
      // Deleted/renamed tests require a full run to validate their consumers.
      if (!available.includes(file)) return null;
      selected.add(file);
      continue;
    }
    // Ordinary source edits exercise all regression tests. Compatibility fanout
    // remains mandatory for package/native entry points and runtime configuration.
    if (
      /^src\/.*\.ts$/.test(file) &&
      !/^src\/(?:config|cli|installer|intelligence\/(?:storage|embeddings|parser|dependencies))\//.test(
        file,
      ) &&
      ![
        "src/index.ts",
        "src/http/entry.ts",
        "src/runtime/subprocess.ts",
      ].includes(file)
    ) {
      allTests = true;
      continue;
    }
    return null;
  }
  return allTests || selected.size
    ? { tests: [...selected].sort(), allTests }
    : null;
}
export function selectCi(input: SelectionInput): Selection {
  const full = (reason: string, website = false) =>
    fullSelection(reason, website);
  if (
    !/^[a-f0-9]{40}$/.test(input.head) ||
    !/^[a-f0-9]{40}$/.test(input.base) ||
    !/^[\w.-]+\/[\w.-]+$/.test(input.repository) ||
    !Number.isSafeInteger(input.pr) ||
    input.pr < 1
  )
    return full("Invalid event provenance");
  const history = [...input.history].sort((a, b) => b.id - a.id);
  if (new Set(history.map((run) => run.id)).size !== history.length)
    return full("Duplicate history");
  for (const run of history) {
    if (
      run.repository !== input.repository ||
      run.pr !== input.pr ||
      run.base !== input.base ||
      !/^[a-f0-9]{40}$/.test(run.head) ||
      !input.ancestor(run.head, input.head) ||
      !run.jobs.length
    )
      return full("History provenance changed or is incomplete");
  }
  // A complete docs-only history cannot conceal reverted package work or failed attempts.
  if (
    input.historyComplete &&
    documentationOnly(input.diff(input.base, input.head)) &&
    history.every(
      (run) =>
        documentationOnly(input.diff(input.base, run.head)) &&
        run.conclusion === "success" &&
        run.jobs.every((job) =>
          ["success", "skipped"].includes(job.conclusion ?? ""),
        ),
    )
  )
    return nonPackageSelection(
      "Only documentation/website paths changed; complete history contains no unresolved package attempts",
    );
  // A failed full attempt still proves its passed areas; every missing outcome stays unresolved.
  const baseline = history.find((run) =>
    fullAttempt(run, input.sameConfiguration?.(run.head) === true),
  );
  if (!baseline)
    return full(
      "No proven full qualification attempt on this PR and base",
      !(input.historyComplete === true && history.length === 0),
    );
  let checkpoint = baseline.head;
  const pendingTests = new Set<string>();
  const known = new Set([...qualificationNames(), "Website validation"]);
  const pending = new Set(
    qualificationNames().filter((name) => !hasSuccessfulJob(baseline, name)),
  );
  const websiteRequested = baseline.jobs.some(
    (job) => acceptanceProvenance(job.name)?.website === true,
  );
  if (
    (websiteRequested ||
      baseline.jobs.some(
        (job) =>
          job.name === "Website validation" && job.conclusion !== "skipped",
      )) &&
    !hasSuccessfulJob(baseline, "Website validation")
  )
    pending.add("Website validation");
  if (
    baseline.jobs.some(
      (job) =>
        !["success", "skipped"].includes(job.conclusion ?? "") &&
        ![...known].some(
          (name) => job.name === name || job.name.endsWith(" / " + name),
        ) &&
        ![
          "Detect changes",
          "Package static checks and distribution",
          "Full CI acceptance",
        ].includes(normalizedName(job.name)),
    )
  )
    return full("Unknown failed area in full qualification attempt", true);
  for (const run of history.filter((item) => item.id > baseline.id).reverse()) {
    if (!input.ancestor(checkpoint, run.head)) return full("Rebased history");
    const delta = scope(input.diff(checkpoint, run.head), input.files);
    const required = [
      "Detect changes",
      "Package static checks and distribution",
      "Selected CI acceptance",
      delta?.allTests || pending.has(coverageName)
        ? coverageName
        : "Affected package tests (Linux)",
      ...platforms.flatMap((os) =>
        delta?.allTests ||
        [0, 1, 2].some((shard) => pending.has(platformName(os, shard)))
          ? [0, 1, 2].map((shard) => platformName(os, shard))
          : [`Affected package tests (${os})`],
      ),
      ...consumers
        .filter((value) => pending.has(consumerName(value)))
        .map(consumerName),
      ...nativePlatforms
        .filter((os) => pending.has(nativeName(os)))
        .map(nativeName),
      ...(pending.has("Website validation") ? ["Website validation"] : []),
    ];
    const matchingConfiguration = input.sameConfiguration?.(run.head) === true;
    const checkpointCovered =
      delta !== null &&
      run.conclusion === "success" &&
      matchingConfiguration &&
      required.every((name) => hasSuccessfulJob(run, name));
    // Required scopes can be absent or skipped after cancellation. Preserve
    // their reconstructed work even if a later commit reverts its changed paths.
    for (const name of required.filter(
      (name) => !hasSuccessfulJob(run, name),
    )) {
      if (known.has(name)) pending.add(name);
      else if (name.startsWith("Affected package tests (")) {
        if (!delta)
          return full("Incomplete selected scope cannot be reconstructed");
        for (const file of delta.tests) pendingTests.add(file);
      }
    }
    for (const job of run.jobs) {
      const jobName = normalizedName(job.name);
      const name = [...known].find(
        (candidate) =>
          jobName === candidate || jobName.endsWith(" / " + candidate),
      );
      if (job.conclusion === "success") {
        // Keep successful areas tied to an accepted source checkpoint. A partial
        // success can contain a fix that a later update reverts.
        if (name && checkpointCovered) pending.delete(name);
      } else if (job.conclusion !== "skipped") {
        if (name) pending.add(name);
        else if (
          [
            "Affected package tests (Linux)",
            ...platforms.map((os) => `Affected package tests (${os})`),
          ].includes(jobName)
        ) {
          if (!delta)
            return full("Failed selected scope cannot be reconstructed");
          for (const file of delta.tests) pendingTests.add(file);
        } else if (
          ![
            "Detect changes",
            "Package static checks and distribution",
            "Selected CI acceptance",
            "Full CI acceptance",
          ].includes(jobName)
        )
          return full("Unknown failed, cancelled or unfinished job", true);
      }
    }
    if (checkpointCovered) {
      checkpoint = run.head;
      pendingTests.clear();
    }
  }
  const selected = scope(input.diff(checkpoint, input.head), input.files);
  if (!selected)
    return full(
      "Shared, unknown, renamed or deleted paths require full qualification",
      pending.has("Website validation"),
    );
  const tests = [...new Set([...selected.tests, ...pendingTests])].sort();
  const coverage = selected.allTests || pending.has(coverageName);
  return {
    package: true,
    full: false,
    reason: `Affected tests since checkpoint ${checkpoint}; full anchor ${baseline.id}; ${pending.size} unresolved qualification areas`,
    tests,
    coverage,
    website: pending.has("Website validation"),
    platforms: platforms.flatMap<Selection["platforms"][number]>((os) =>
      selected.allTests ||
      [0, 1, 2].some((shard) => pending.has(platformName(os, shard)))
        ? [0, 1, 2].map((shard) => ({ os, shard, shards: 3, selected: false }))
        : [{ os, shard: 0, shards: 1, selected: true }],
    ),
    consumers: consumers.filter((value) => pending.has(consumerName(value))),
    native: nativePlatforms
      .filter((os) => pending.has(nativeName(os)))
      .map((os) => ({ os })),
    acceptancePending: true,
  };
}

interface Event {
  number?: number;
  before?: string;
  repository?: { full_name?: string };
  pull_request?: {
    head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
    base?: { sha?: string; repo?: { full_name?: string } };
  };
}
interface ApiRun {
  id: number;
  head_sha: string;
  conclusion: string | null;
  event: string;
  path: string;
  run_attempt: number;
  repository: { full_name: string };
  head_repository?: { full_name: string };
  head_branch?: string;
  pull_requests: Array<{ number: number; base: { sha: string } }>;
}
function git(args: string[], trim = true): string {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode) throw new Error("Git history is unavailable");
  const output = result.stdout.toString();
  return trim ? output.trim() : output;
}
function ancestor(older: string, newer: string): boolean {
  return (
    Bun.spawnSync(["git", "merge-base", "--is-ancestor", older, newer], {
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0
  );
}
export function changedPaths(older: string, newer: string): string[] {
  // --name-only includes both sides of renames when rename detection is disabled.
  return git(["diff", "--no-renames", "--name-only", "-z", older, newer], false)
    .split("\0")
    .filter(Boolean);
}
function configurationMatches(candidate: string, head: string): boolean {
  try {
    return [
      ".github/workflows/ci.yml",
      ".github/workflows/package-consumers.yml",
      "scripts/testing/ci-selection.ts",
      "scripts/testing/test-shard.ts",
    ].every(
      (file) =>
        git(["rev-parse", `${candidate}:${file}`]) ===
        git(["rev-parse", `${head}:${file}`]),
    );
  } catch {
    // Older full workflows can anchor cumulative diffs, but cannot advance checkpoints.
    return false;
  }
}
export async function githubSelection(
  event: Event,
  repository: string,
  currentRun: number,
  request: (path: string) => Promise<unknown>,
): Promise<Selection> {
  try {
    const pr = event.number;
    const head = event.pull_request?.head?.sha;
    const base = event.pull_request?.base?.sha;
    const headRepository = event.pull_request?.head?.repo?.full_name;
    const headBranch = event.pull_request?.head?.ref;
    if (
      !head ||
      !base ||
      !pr ||
      !headRepository ||
      !headBranch ||
      event.repository?.full_name !== repository ||
      event.pull_request?.base?.repo?.full_name !== repository
    )
      return fullSelection("Missing pull request provenance");
    if (
      !/^[a-f0-9]{40}$/.test(head) ||
      !/^[a-f0-9]{40}$/.test(base) ||
      git(["rev-parse", "HEAD"]) !== head
    )
      return fullSelection("Checkout is not the exact pull request head");
    const response = (await request(
      `/repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&per_page=30&branch=${encodeURIComponent(headBranch)}`,
    )) as { workflow_runs?: ApiRun[]; total_count?: number };
    if (
      !Array.isArray(response.workflow_runs) ||
      response.workflow_runs.length > 30
    )
      throw new Error("Missing or unbounded run history");
    const candidates = response.workflow_runs
      .filter(
        (run) =>
          run.id !== currentRun &&
          (run.pull_requests.some((item) => item.number === pr) ||
            (run.head_repository?.full_name === headRepository &&
              run.head_branch === headBranch)),
      )
      .sort((a, b) => b.id - a.id);
    const history: HistoricalRun[] = [];
    for (const run of candidates.slice(0, 10)) {
      if (
        !Number.isSafeInteger(run.id) ||
        run.id < 1 ||
        run.id >= currentRun ||
        run.run_attempt !== 1 ||
        run.conclusion === null ||
        !/^[a-f0-9]{40}$/.test(run.head_sha) ||
        run.event !== "pull_request" ||
        run.path !== ".github/workflows/ci.yml" ||
        run.repository.full_name !== repository ||
        run.head_repository?.full_name !== headRepository ||
        run.head_branch !== headBranch ||
        run.pull_requests.length > 1
      )
        throw new Error("Unexpected workflow provenance");
      const data = (await request(
        `/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
      )) as { total_count?: number; jobs?: HistoricalJob[] };
      if (
        !Array.isArray(data.jobs) ||
        data.total_count !== data.jobs.length ||
        data.jobs.length > 100 ||
        data.jobs.some(
          (job) =>
            typeof job.name !== "string" ||
            (job.conclusion !== null && typeof job.conclusion !== "string"),
        )
      )
        throw new Error("Incomplete job history");
      const sentinels = data.jobs
        .map((job) => acceptanceProvenance(job.name))
        .filter((proof) => proof !== null);
      const association = run.pull_requests[0];
      const matchingConfiguration = configurationMatches(run.head_sha, head);
      if (
        sentinels.length > 1 ||
        (sentinels[0] &&
          (sentinels[0].pr !== pr || sentinels[0].base !== base)) ||
        (association &&
          (association.number !== pr || association.base.sha !== base)) ||
        (!association && (sentinels.length !== 1 || !matchingConfiguration))
      )
        throw new Error("Missing or ambiguous historical PR/base proof");
      const item: HistoricalRun = {
        id: run.id,
        head: run.head_sha,
        base,
        repository,
        pr,
        conclusion: run.conclusion,
        jobs: data.jobs,
      };
      history.push(item);
      // Stop only after an anchor: every newer matching attempt remains in the fold.
      if (fullAttempt(item, matchingConfiguration)) break;
    }
    return selectCi({
      repository,
      pr,
      head,
      base,
      files: discoverTestFiles(),
      history,
      ancestor,
      diff: changedPaths,
      sameConfiguration: (candidate) => configurationMatches(candidate, head),
      historyComplete:
        response.total_count === response.workflow_runs.length &&
        history.length === candidates.length,
    });
  } catch {
    return fullSelection(
      "History/API ambiguity; full qualification required",
      true,
    );
  }
}
export function selectionOutputs(selection: Selection): Record<string, string> {
  return {
    package: String(selection.package),
    full: String(selection.full),
    coverage: String(selection.coverage),
    website: String(selection.website),
    selected_tests: JSON.stringify(selection.tests),
    platforms: JSON.stringify({
      include: selection.platforms.length
        ? selection.platforms
        : [{ os: platforms[0], shard: 0, shards: 1, selected: true }],
    }),
    consumers: String(selection.consumers.length > 0),
    consumer_matrix: JSON.stringify({
      include: selection.consumers.length
        ? selection.consumers
        : [consumers[0]],
    }),
    native: String(selection.native.length > 0),
    native_matrix: JSON.stringify({
      include: selection.native.length
        ? selection.native
        : [{ os: nativePlatforms[0] }],
    }),
  };
}
export function githubRequest(
  token: string | undefined,
): (endpoint: string) => Promise<unknown> {
  return async (endpoint) => {
    const response = await fetch("https://api.github.com" + endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("GitHub history request failed");
    return response.json();
  };
}
export async function runCiSelection(
  event: Event,
  environment: Record<string, string | undefined>,
  request: (endpoint: string) => Promise<unknown>,
  append: (path: string, text: string) => void = appendFileSync,
): Promise<Selection> {
  let selection = fullSelection("Main or explicit exact-head qualification");
  if (environment.GITHUB_EVENT_NAME === "pull_request") {
    selection = await githubSelection(
      event,
      environment.GITHUB_REPOSITORY!,
      Number(environment.GITHUB_RUN_ID),
      request,
    );
  } else if (
    environment.GITHUB_EVENT_NAME === "push" &&
    event.before &&
    /^[a-f0-9]{40}$/.test(event.before) &&
    event.before !== "0".repeat(40) &&
    /^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? "")
  ) {
    try {
      if (
        git(["rev-parse", "HEAD"]) === environment.GITHUB_SHA &&
        documentationOnly(changedPaths(event.before, environment.GITHUB_SHA!))
      )
        selection = nonPackageSelection(
          "Main push changes only documentation/website paths",
        );
    } catch {
      // Missing before/head objects require full package qualification.
    }
  }
  for (const [key, value] of Object.entries(selectionOutputs(selection)))
    append(environment.GITHUB_OUTPUT!, `${key}=${value}\n`);
  const status = !selection.package
    ? "Package qualification is not required for this documentation/website-only change."
    : selection.acceptancePending
      ? "Full exact-head final acceptance remains required before merge/release."
      : "This run schedules full exact-head qualification.";
  append(
    environment.GITHUB_STEP_SUMMARY!,
    `### CI scope\n\n${selection.reason}\n\nPackage: ${selection.package}. Full: ${selection.full}. Selected test files: ${selection.tests.length}. Platform test jobs: ${selection.platforms.length}. Consumer jobs: ${selection.consumers.length}. Native jobs: ${selection.native.length}.\n\n${status}\n`,
  );
  return selection;
}
if (import.meta.main)
  await runCiSelection(
    (await Bun.file(process.env.GITHUB_EVENT_PATH!).json()) as Event,
    process.env,
    githubRequest(process.env.GITHUB_TOKEN),
  );

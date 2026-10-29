import { describe, expect, test, spyOn } from "bun:test";

import {
  selectCi,
  fullSelection,
  selectionOutputs,
  consumers,
  githubSelection,
  changedPaths,
  githubRequest,
  runCiSelection,
  type HistoricalRun,
  type HistoricalJob,
  type SelectionInput,
} from "../../scripts/testing/ci-selection.ts";
import {
  selectedTestFiles,
  runTestShard,
} from "../../scripts/testing/test-shard.ts";

const oid = (character: string) => character.repeat(40);
const a = "tests/runtime/a.test.ts",
  b = "tests/runtime/b.test.ts",
  c = "tests/runtime/c.test.ts";
const files = [
  a,
  b,
  c,
  "tests/patch/engine.test.ts",
  "tests/intelligence/mutation/service.test.ts",
  "tests/integration/recovery.test.ts",
  "tests/config/index.test.ts",
];
const repository = "owner/repo";
const coverage = "Package tests and 95% coverage (Linux)";
const windows = (shard: number) =>
  `Package tests (windows-latest, shard ${shard})`;
function fullJobs(): HistoricalJob[] {
  const selection = fullSelection("fixture");
  return [
    "Detect changes",
    "Package static checks and distribution",
    coverage,
    "Full CI acceptance",
    ...selection.platforms.map(
      ({ os, shard }) => `Package tests (${os}, shard ${shard})`,
    ),
    ...selection.consumers.map(
      ({ platform, installer }) =>
        `Packed package consumers / Consumer (${platform.os}, ${installer}, Bun ${platform.bun})`,
    ),
    ...selection.native.map(({ os }) => `Native package qualification (${os})`),
  ].map((name) => ({ name, conclusion: "success" }));
}
function run(
  id: number,
  head: string,
  jobs = fullJobs(),
  conclusion: string | null = "success",
): HistoricalRun {
  return {
    id,
    head: oid(head),
    base: oid("0"),
    repository,
    pr: 1,
    jobs,
    conclusion,
  };
}
function selectedRun(
  id: number,
  head: string,
  conclusion = "success",
): HistoricalRun {
  return run(
    id,
    head,
    [
      "Detect changes",
      "Package static checks and distribution",
      "Selected CI acceptance",
      "Affected package tests (Linux)",
      "Affected package tests (macos-latest)",
      "Affected package tests (windows-latest)",
    ].map((name) => ({ name, conclusion })),
    conclusion,
  );
}
function input(overrides: Partial<SelectionInput> = {}): SelectionInput {
  return {
    repository,
    pr: 1,
    head: oid("e"),
    base: oid("0"),
    files,
    history: [run(1, "a")],
    ancestor: () => true,
    diff: () => [a],
    sameConfiguration: () => true,
    ...overrides,
  };
}
function jobCount(selection: ReturnType<typeof selectCi>) {
  return (
    4 +
    selection.platforms.length +
    selection.consumers.length +
    selection.native.length
  );
}
describe("conservative CI scope selection", () => {
  test("test-only iterations schedule six jobs instead of twenty-five full jobs", () => {
    const selected = selectCi(input());
    expect(selected.full).toBeFalse();
    expect(selected.tests).toEqual([a]);
    expect(selected.coverage).toBeFalse();
    expect(selected.consumers).toEqual([]);
    expect(selected.native).toEqual([]);
    expect(selected.acceptancePending).toBeTrue();
    expect(jobCount(selected)).toBe(6);
    expect(jobCount(fullSelection("full"))).toBe(25);
    expect(JSON.parse(selectionOutputs(selected).selected_tests!)).toEqual([a]);
    expect(selectionOutputs(selected).package).toBe("true");
  });
  test("proven empty branch history schedules full package qualification without unrelated website work", () => {
    const selected = selectCi(input({ history: [], historyComplete: true }));
    expect(selected.package).toBeTrue();
    expect(selected.full).toBeTrue();
    expect(selected.website).toBeFalse();
    expect(selected.consumers).toHaveLength(12);
    expect(selected.native).toHaveLength(3);
    expect(
      selectCi(input({ history: [], historyComplete: false })).website,
    ).toBeTrue();
    expect(
      selectCi(input({ history: [], historyComplete: undefined })).website,
    ).toBeTrue();
    expect(
      selectCi(input({ history: [selectedRun(1, "a")], historyComplete: true }))
        .website,
    ).toBeTrue();
  });
  test("a first failed full attempt retains only failed Windows qualification plus current tests", () => {
    const jobs = fullJobs().map((job) =>
      job.name === windows(0) ? { ...job, conclusion: "failure" } : job,
    );
    const selected = selectCi(
      input({ history: [run(1, "a", jobs, "failure")] }),
    );
    expect(selected.full).toBeFalse();
    expect(
      selected.platforms.filter((item) => item.os === "windows-latest"),
    ).toHaveLength(3);
    expect(
      selected.platforms.filter((item) => item.os === "macos-latest"),
    ).toHaveLength(1);
    expect(selected.consumers).toEqual([]);
    expect(selected.native).toEqual([]);
    expect(jobCount(selected)).toBe(8);
  });
  test.each(["failure", "timed_out", "cancelled", "skipped", null])(
    "an incomplete full attempt cannot clear an unresolved Windows area: %s",
    (conclusion) => {
      const jobs = fullJobs().map((job) =>
        job.name === windows(0) ? { ...job, conclusion } : job,
      );
      const failed = run(1, "a", jobs, "failure");
      const retry = selectedRun(2, "b", "cancelled");
      const selected = selectCi(input({ history: [failed, retry] }));
      expect(
        selected.platforms
          .filter((item) => item.os === "windows-latest")
          .every((item) => !item.selected),
      ).toBeTrue();
    },
  );
  test("a modern full summary identifies missing jobs that never started", () => {
    const jobs = fullJobs().filter(
      (job) => job.name !== windows(0) && job.name !== coverage,
    );
    const selected = selectCi(
      input({ history: [run(1, "a", jobs, "failure")] }),
    );
    expect(selected.full).toBeFalse();
    expect(selected.coverage).toBeTrue();
    expect(
      selected.platforms.filter((item) => item.os === "windows-latest"),
    ).toHaveLength(3);
    expect(
      selectCi(
        input({
          sameConfiguration: () => false,
          history: [run(1, "a", jobs, "failure")],
        }),
      ).full,
    ).toBeTrue();
  });
  test("only a fully covered successful checkpoint clears a failed full area", () => {
    const failure = run(
      2,
      "b",
      [{ name: windows(0), conclusion: "failure" }],
      "failure",
    );
    const targeted = selectedRun(3, "c");
    expect(
      selectCi(
        input({ history: [run(1, "a"), failure, targeted] }),
      ).platforms.filter((item) => item.os === "windows-latest"),
    ).toHaveLength(3);
    const repaired = run(
      4,
      "d",
      [0, 1, 2].map((shard) => ({
        name: windows(shard),
        conclusion: "success",
      })),
      "failure",
    );
    expect(
      selectCi(
        input({ history: [run(1, "a"), failure, targeted, repaired] }),
      ).platforms.filter((item) => item.os === "windows-latest"),
    ).toHaveLength(3);
    const completed = {
      ...repaired,
      conclusion: "success",
      jobs: [
        ...selectedRun(4, "d").jobs.filter(
          (job) => job.name !== "Affected package tests (windows-latest)",
        ),
        ...repaired.jobs,
      ],
    };
    expect(
      selectCi(
        input({ history: [run(1, "a"), failure, targeted, completed] }),
      ).platforms.filter((item) => item.os === "windows-latest"),
    ).toHaveLength(1);
  });
  test("a reverted fix cannot reuse Windows success from a failed regression checkpoint", () => {
    const failed = run(
      1,
      "a",
      fullJobs().map((job) =>
        job.name === windows(0) ? { ...job, conclusion: "failure" } : job,
      ),
      "failure",
    );
    const repairJobs = fullJobs()
      .filter(
        (job) =>
          job.name === "Detect changes" ||
          job.name === "Package static checks and distribution" ||
          job.name === coverage ||
          job.name.startsWith("Package tests ("),
      )
      .map((job) =>
        job.name === "Package tests (macos-latest, shard 0)"
          ? { ...job, conclusion: "failure" }
          : job,
      );
    repairJobs.push({ name: "Selected CI acceptance", conclusion: "failure" });
    const partiallyRepaired = run(2, "b", repairJobs, "failure");
    const selected = selectCi(
      input({
        history: [failed, partiallyRepaired],
        // B fixes Windows using a source change, but C reverts that fix and changes only a test.
        diff: (_older, newer) =>
          newer === oid("b") ? ["src/runtime/file-delete.ts"] : [c],
      }),
    );
    expect(selected.full).toBeFalse();
    expect(selected.tests).toEqual([c]);
    expect(
      selected.platforms.filter((item) => item.os === "windows-latest"),
    ).toHaveLength(3);
    expect(
      selected.platforms
        .filter((item) => item.os === "windows-latest")
        .every((item) => !item.selected),
    ).toBeTrue();
    expect(selected.reason).toContain(`checkpoint ${oid("a")}`);
  });
  test("different workflow fingerprints cannot clear a pending full-area failure", () => {
    const failed = run(
      1,
      "a",
      fullJobs().map((job) =>
        job.name === windows(0) ? { ...job, conclusion: "failure" } : job,
      ),
      "failure",
    );
    const untrustedPass = run(
      2,
      "b",
      [0, 1, 2].map((shard) => ({
        name: windows(shard),
        conclusion: "success",
      })),
    );
    const selected = selectCi(
      input({
        history: [failed, untrustedPass],
        sameConfiguration: (head) => head !== oid("b"),
      }),
    );
    expect(selected.full).toBeFalse();
    expect(
      selected.platforms.filter((item) => item.os === "windows-latest"),
    ).toHaveLength(3);
  });
  test("a skipped full summary cannot turn a selected attempt into a full anchor", () => {
    const partial = selectedRun(1, "a");
    partial.jobs.push({ name: "Full CI acceptance", conclusion: "skipped" });
    expect(selectCi(input({ history: [partial] })).full).toBeTrue();
  });
  test("consumer failures rerun exactly their supported combination until success", () => {
    const combo = consumers.find(
      (item) => item.platform.platform === "win32" && item.installer === "npm",
    )!;
    const name = `Packed package consumers / Consumer (${combo.platform.os}, npm, Bun ${combo.platform.bun})`;
    const failed = run(2, "b", [{ name, conclusion: "timed_out" }], "failure");
    expect(
      selectCi(input({ history: [run(1, "a"), failed] })).consumers,
    ).toEqual([combo]);
    const skipped = run(3, "c", [{ name, conclusion: "skipped" }], "cancelled");
    expect(
      selectCi(input({ history: [run(1, "a"), failed, skipped] })).consumers,
    ).toEqual([combo]);
    const passed = run(4, "d", [{ name, conclusion: "success" }], "failure");
    expect(
      selectCi(input({ history: [run(1, "a"), failed, skipped, passed] }))
        .consumers,
    ).toEqual([combo]);
    const completed = {
      ...passed,
      conclusion: "success",
      jobs: [...selectedRun(4, "d").jobs, ...passed.jobs],
    };
    expect(
      selectCi(input({ history: [run(1, "a"), failed, skipped, completed] }))
        .consumers,
    ).toEqual([]);
  });
  test("website failures remain optional, survive skips, and require a matching successful pass", () => {
    const failed = run(
      2,
      "b",
      [{ name: "Website validation", conclusion: "failure" }],
      "failure",
    );
    const skipped = run(
      3,
      "c",
      [{ name: "Website validation", conclusion: "skipped" }],
      "cancelled",
    );
    const selected = selectCi(
      input({ history: [run(1, "a"), failed, skipped] }),
    );
    expect(selected.full).toBeFalse();
    expect(selected.website).toBeTrue();
    expect(selected.consumers).toEqual([]);
    expect(selected.native).toEqual([]);
    expect(selectionOutputs(selected).website).toBe("true");
    const passed = run(
      4,
      "d",
      [{ name: "Website validation", conclusion: "success" }],
      "failure",
    );
    expect(
      selectCi(input({ history: [run(1, "a"), failed, skipped, passed] }))
        .website,
    ).toBeTrue();
    const completed = {
      ...passed,
      conclusion: "success",
      jobs: [...selectedRun(4, "d").jobs, ...passed.jobs],
    };
    expect(
      selectCi(input({ history: [run(1, "a"), failed, skipped, completed] }))
        .website,
    ).toBeFalse();
    expect(
      selectCi(
        input({
          history: [run(1, "a"), failed, skipped, completed],
          sameConfiguration: (head) => head !== oid("d"),
        }),
      ).website,
    ).toBeTrue();
    expect(selectCi(input()).website).toBeFalse();
  });
  test("a missing selected website job is retained by modern full provenance", () => {
    const jobs = fullJobs().map((job) =>
      job.name === "Full CI acceptance"
        ? {
            ...job,
            name: `Full CI acceptance [PR 1; base ${oid("0")}; website true]`,
            conclusion: "failure",
          }
        : job,
    );
    expect(
      selectCi(input({ history: [run(1, "a", jobs, "failure")] })).website,
    ).toBeTrue();
  });
  test("prior coverage failure forces the complete Linux coverage suite", () => {
    const failed = run(
      2,
      "b",
      [{ name: coverage, conclusion: "failure" }],
      "failure",
    );
    const selected = selectCi(input({ history: [run(1, "a"), failed] }));
    expect(selected.coverage).toBeTrue();
    expect(selected.full).toBeFalse();
  });
  test.each(["missing", "skipped", "cancelled", null])(
    "required affected scope retains a reverted test after cancellation: %s",
    (outcome) => {
      const interrupted = selectedRun(2, "b", "cancelled");
      interrupted.jobs = interrupted.jobs.flatMap<HistoricalJob>((job) =>
        job.name === "Affected package tests (Linux)"
          ? outcome === "missing"
            ? []
            : [{ ...job, conclusion: outcome }]
          : [
              {
                ...job,
                conclusion:
                  job.name === "Selected CI acceptance"
                    ? "cancelled"
                    : "success",
              },
            ],
      );
      const selected = selectCi(
        input({
          history: [run(1, "a"), interrupted],
          diff: (_older, newer) => (newer === oid("b") ? [a] : [c]),
        }),
      );
      expect(selected.full).toBeFalse();
      expect(selected.tests).toEqual([a, c]);
      expect(selected.coverage).toBeFalse();
      expect(selected.platforms).toHaveLength(2);
      expect(selected.consumers).toEqual([]);
      expect(selected.native).toEqual([]);
      expect(jobCount(selected)).toBe(6);
    },
  );
  test("a later complete checkpoint clears reconstructed missing test work", () => {
    const interrupted = selectedRun(2, "b", "cancelled");
    interrupted.jobs = interrupted.jobs.filter(
      (job) => !job.name.startsWith("Affected package tests"),
    );
    const selected = selectCi(
      input({
        history: [run(1, "a"), interrupted, selectedRun(3, "c")],
        diff: (_older, newer) =>
          newer === oid("b") ? [a] : newer === oid("c") ? [b] : [c],
      }),
    );
    expect(selected.tests).toEqual([c]);
    expect(selected.reason).toContain(`checkpoint ${oid("c")}`);
  });
  test("missing full regression scopes remain full after a source change is reverted", () => {
    const interrupted = run(
      2,
      "b",
      [
        { name: "Detect changes", conclusion: "success" },
        { name: "Selected CI acceptance", conclusion: "cancelled" },
      ],
      "cancelled",
    );
    const selected = selectCi(
      input({
        history: [run(1, "a"), interrupted],
        diff: (_older, newer) =>
          newer === oid("b") ? ["src/runtime/file-delete.ts"] : [c],
      }),
    );
    expect(selected.full).toBeFalse();
    expect(selected.coverage).toBeTrue();
    expect(selected.platforms).toHaveLength(6);
    expect(selected.platforms.every((item) => !item.selected)).toBeTrue();
  });
  test("verified A-success then B-success selects only C changes", () => {
    const diffs: Record<string, string[]> = {
      [oid("a") + oid("b")]: [a],
      [oid("b") + oid("c")]: [b],
      [oid("c") + oid("e")]: [c],
    };
    const history = [run(1, "a"), selectedRun(2, "b"), selectedRun(3, "c")];
    const selected = selectCi(
      input({
        history,
        diff: (older, newer) => diffs[older + newer] ?? [a, b, c],
      }),
    );
    expect(selected.tests).toEqual([c]);
    const cumulative = selectCi(
      input({ history, sameConfiguration: () => false, diff: () => [a, b, c] }),
    );
    expect(cumulative.tests).toEqual([a, b, c]);
  });
  test("failed and cancelled selected areas remain even after their changes are reverted", () => {
    const history = [
      run(1, "a"),
      selectedRun(2, "b", "failure"),
      selectedRun(3, "c", "cancelled"),
    ];
    const selected = selectCi(
      input({
        history,
        diff: (_older, newer) =>
          newer === oid("b") ? [a] : newer === oid("c") ? [b] : [c],
      }),
    );
    expect(selected.tests).toEqual([a, b, c]);
  });
  test.each([
    "src/runtime/reference-target-index.ts",
    "src/runtime/hash.ts",
    "src/runtime/snapshot-blob.ts",
    "src/patch/engine.ts",
    "src/intelligence/mutation/service.ts",
    ...[
      "attributes",
      "policy",
      "path-policy",
      "paths",
      "parent-directories",
      "format",
      "file-read",
      "file-capabilities",
      "process-input",
    ].map((name) => `src/runtime/${name}.ts`),
  ])(
    "ordinary source changes cover every regression domain without unchanged compatibility fanout: %s",
    (file) => {
      const selected = selectCi(input({ diff: () => [file] }));
      expect(selected.full).toBeFalse();
      expect(selected.coverage).toBeTrue();
      expect(selected.platforms).toHaveLength(6);
      expect(selected.platforms.every((item) => !item.selected)).toBeTrue();
      expect(selected.consumers).toEqual([]);
      expect(selected.native).toEqual([]);
      expect(selected.acceptancePending).toBeTrue();
      expect(jobCount(selected)).toBe(10);
    },
  );
  test.each([
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "src/config/index.ts",
    "src/runtime/subprocess.ts",
    "src/index.ts",
    "src/intelligence/storage/lance.ts",
    "src/intelligence/embeddings/provider.ts",
    ".github/workflows/ci.yml",
    "scripts/testing/ci-selection.ts",
    "tests/support/mock.ts",
    "tests/tooling/package-smoke.test.ts",
    "unknown.ts",
    "tests/runtime/deleted.test.ts",
  ])("shared or unknown changes force full qualification: %s", (file) => {
    expect(selectCi(input({ diff: () => [file] })).full).toBeTrue();
  });
  test("renamed tests, empty changes and domains without tests fail closed", () => {
    expect(
      selectCi(input({ diff: () => ["tests/runtime/old.test.ts", a] })).full,
    ).toBeTrue();
    expect(selectCi(input({ diff: () => [] })).full).toBeTrue();
    expect(
      selectCi(input({ files: [], diff: () => ["src/patch/engine.ts"] })).full,
    ).toBeTrue();
  });
  test("missing, duplicate, foreign, stale-base and rebased history fail closed", () => {
    for (const overrides of [
      { history: [] },
      { history: [run(1, "a"), run(1, "a")] },
      { history: [{ ...run(1, "a"), repository: "other/repo" }] },
      { history: [{ ...run(1, "a"), pr: 2 }] },
      { history: [{ ...run(1, "a"), base: oid("9") }] },
      { ancestor: () => false },
      { head: "bad" },
      {
        history: [
          run(1, "a"),
          run(
            2,
            "b",
            [{ name: "unknown qualification", conclusion: "failure" }],
            "failure",
          ),
        ],
      },
    ] as Partial<SelectionInput>[])
      expect(selectCi(input(overrides)).full).toBeTrue();
  });
  test("complete documentation-only history skips package work without creating a full anchor", () => {
    const selected = selectCi(
      input({
        history: [],
        historyComplete: true,
        diff: () => ["docs/ci.md", "website/docs/page.md"],
      }),
    );
    expect(selected.package).toBeFalse();
    expect(selected.full).toBeFalse();
    expect(selected.website).toBeFalse();
    expect(selected.platforms).toEqual([]);
    expect(selectionOutputs(selected).package).toBe("false");
    expect(
      selectCi(input({ history: [], diff: () => ["docs/ci.md"] })).package,
    ).toBeTrue();
    const partial = selectedRun(1, "a");
    partial.jobs = [
      {
        name: `No package CI acceptance [PR 1; base ${oid("0")}; website false]`,
        conclusion: "success",
      },
    ];
    expect(selectCi(input({ history: [partial] })).full).toBeTrue();
  });
  test.each(["failure", "cancelled", "timed_out", null])(
    "docs-only current changes never erase an incomplete prior package attempt: %s",
    (conclusion) => {
      const prior = run(
        1,
        "a",
        fullJobs().map((job) =>
          job.name === windows(0) ? { ...job, conclusion } : job,
        ),
        conclusion,
      );
      const selected = selectCi(
        input({
          history: [prior],
          historyComplete: true,
          diff: (_older, newer) => (newer === oid("a") ? [a] : ["docs/ci.md"]),
        }),
      );
      expect(selected.package).toBeTrue();
      expect(
        selected.platforms.filter((item) => item.os === "windows-latest"),
      ).toHaveLength(3);
    },
  );
  test("unknown baseline failures, rebased checkpoints and unresolvable failed selections fail closed", () => {
    const unknown = run(
      1,
      "a",
      [...fullJobs(), { name: "Unknown new gate", conclusion: "failure" }],
      "failure",
    );
    expect(selectCi(input({ history: [unknown] })).full).toBeTrue();
    expect(
      selectCi(
        input({
          history: [run(1, "a"), selectedRun(2, "b")],
          ancestor: (older, newer) =>
            !(older === oid("a") && newer === oid("b")),
        }),
      ).full,
    ).toBeTrue();
    expect(
      selectCi(
        input({
          history: [run(1, "a"), selectedRun(2, "b", "failure")],
          diff: (_older, newer) =>
            newer === oid("b") ? ["package.json"] : [a],
        }),
      ).full,
    ).toBeTrue();
  });
  test("selected argv rejects flags, traversal, duplicates and undiscovered paths", () => {
    expect(selectedTestFiles(JSON.stringify([a]), files)).toEqual([a]);
    for (const value of [
      undefined,
      "bad",
      "null",
      "[]",
      '["--preload"]',
      '["../escape.test.ts"]',
      JSON.stringify([a, a]),
      '["tests/missing.test.ts"]',
    ])
      expect(() => selectedTestFiles(value, files)).toThrow();
    const spawn = spyOn(Bun, "spawnSync").mockReturnValue({
      exitCode: 0,
    } as ReturnType<typeof Bun.spawnSync>);
    const previous = process.env.AST_MCP_SELECTED_TESTS;
    process.env.AST_MCP_SELECTED_TESTS = JSON.stringify([
      "tests/tooling/ci-selection.test.ts",
    ]);
    try {
      expect(runTestShard(["--selected"], process.cwd(), "ignore")).toBe(0);
      expect(spawn.mock.calls[0]?.[0]).toMatchObject({
        cmd: [
          process.execPath,
          "test",
          "--dots",
          "--max-concurrency=1",
          "--timeout=30000",
          "tests/tooling/ci-selection.test.ts",
        ],
      });
    } finally {
      spawn.mockRestore();
      if (previous === undefined) delete process.env.AST_MCP_SELECTED_TESTS;
      else process.env.AST_MCP_SELECTED_TESTS = previous;
    }
  });
});
test("GitHub history requests are bounded, read-only and fail closed on API/provenance ambiguity", async () => {
  const spawn = spyOn(Bun, "spawnSync").mockImplementation(((
    args: unknown,
  ) => ({
    exitCode: 0,
    stdout: Buffer.from(
      Array.isArray(args) && args[1] === "rev-parse" ? oid("e") : "",
    ),
  })) as typeof Bun.spawnSync);
  const event = {
    number: 1,
    repository: { full_name: repository },
    pull_request: {
      head: { sha: oid("e"), ref: "topic", repo: { full_name: repository } },
      base: { sha: oid("0"), repo: { full_name: repository } },
    },
  };
  const paths: string[] = [];
  try {
    expect(
      (
        await githubSelection(event, repository, 100, async (endpoint) => {
          paths.push(endpoint);
          return {};
        })
      ).full,
    ).toBeTrue();
    expect(paths).toEqual([
      `/repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&per_page=30&branch=topic`,
    ]);
    expect(
      (
        await githubSelection(event, repository, 100, async () => {
          throw new Error("API denied");
        })
      ).full,
    ).toBeTrue();
    expect(
      (
        await githubSelection({}, repository, 100, async () => {
          throw new Error("must not request");
        })
      ).full,
    ).toBeTrue();
    expect(changedPaths(oid("a"), oid("b"))).toEqual([]);
  } finally {
    spawn.mockRestore();
  }
});

test("NUL-delimited changed paths preserve whitespace and Unicode exactly", () => {
  const paths = [
    " src/runtime/policy.ts",
    "tests/runtime/δ.test.ts",
    "trailing ",
  ];
  const spawn = spyOn(Bun, "spawnSync").mockReturnValue({
    exitCode: 0,
    stdout: Buffer.from(paths.join("\0") + "\0"),
  } as ReturnType<typeof Bun.spawnSync>);
  try {
    expect(changedPaths(oid("a"), oid("b"))).toEqual(paths);
    expect(
      selectCi(input({ diff: () => changedPaths(oid("a"), oid("b")) })).full,
    ).toBeTrue();
  } finally {
    spawn.mockRestore();
  }
});
describe("CI entrypoint output and read-only transport", () => {
  const event = {
    number: 1,
    repository: { full_name: repository },
    pull_request: {
      head: { sha: oid("e"), ref: "topic", repo: { full_name: repository } },
      base: { sha: oid("0"), repo: { full_name: repository } },
    },
  };
  const environment = (name: string) => ({
    GITHUB_EVENT_NAME: name,
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ID: "100",
    GITHUB_SHA: oid("e"),
    GITHUB_OUTPUT: "/output",
    GITHUB_STEP_SUMMARY: "/summary",
  });
  const noRequest = async () => {
    throw new Error("Unexpected API call");
  };
  test("dispatch always emits full exact-head matrices and an accurate acceptance summary", async () => {
    const output: Record<string, string> = {};
    const selected = await runCiSelection(
      {},
      environment("workflow_dispatch"),
      noRequest,
      (path, value) => {
        output[path] = (output[path] ?? "") + value;
      },
    );
    expect(selected.full).toBeTrue();
    expect(output["/output"]).toContain(
      "package=true\nfull=true\ncoverage=true\n",
    );
    expect(output["/output"]).toContain("native=true\n");
    expect(output["/summary"]).toContain(
      "This run schedules full exact-head qualification.",
    );
    const failOutput = () => {
      throw new Error("Output unavailable");
    };
    await expect(
      runCiSelection(
        {},
        environment("workflow_dispatch"),
        noRequest,
        failOutput,
      ),
    ).rejects.toThrow("Output unavailable");
  });
  test("main docs-only changes skip package work, while missing history objects fall back to full", async () => {
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(((
      args: unknown,
    ) => ({
      exitCode: 0,
      stdout: Buffer.from(
        (args as string[])[1] === "diff" ? "docs/ci.md\0" : oid("e"),
      ),
    })) as typeof Bun.spawnSync);
    const output: string[] = [];
    try {
      const selected = await runCiSelection(
        { before: oid("a") },
        environment("push"),
        noRequest,
        (_path, value) => {
          output.push(value);
        },
      );
      expect(selected.package).toBeFalse();
      expect(output.join("")).toContain("package=false\n");
      expect(output.join("")).toContain(
        "Package qualification is not required",
      );
      spawn.mockReturnValue({
        exitCode: 1,
        stdout: Buffer.from(""),
      } as ReturnType<typeof Bun.spawnSync>);
      expect(
        (
          await runCiSelection(
            { before: oid("a") },
            environment("push"),
            noRequest,
            () => {},
          )
        ).full,
      ).toBeTrue();
      expect(
        (
          await runCiSelection(
            { before: "0".repeat(40) },
            environment("push"),
            noRequest,
            () => {},
          )
        ).full,
      ).toBeTrue();
    } finally {
      spawn.mockRestore();
    }
  });
  test("PR outputs distinguish selected acceptance from complete docs-only provenance", async () => {
    const changedTest = "tests/runtime/snapshot-blob.test.ts";
    let paths = changedTest + "\0";
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(((
      args: unknown,
    ) => {
      const argv = args as string[];
      return {
        exitCode: 0,
        stdout: Buffer.from(
          argv[1] === "diff" ? paths : argv[2] === "HEAD" ? oid("e") : oid("f"),
        ),
      };
    }) as typeof Bun.spawnSync);
    try {
      const summary: string[] = [];
      const selected = await runCiSelection(
        event,
        environment("pull_request"),
        async (path) =>
          path.includes("/jobs?")
            ? { total_count: fullJobs().length, jobs: fullJobs() }
            : {
                total_count: 1,
                workflow_runs: [
                  {
                    id: 1,
                    head_sha: oid("a"),
                    conclusion: "success",
                    event: "pull_request",
                    path: ".github/workflows/ci.yml",
                    run_attempt: 1,
                    repository: { full_name: repository },
                    head_repository: { full_name: repository },
                    head_branch: "topic",
                    pull_requests: [{ number: 1, base: { sha: oid("0") } }],
                  },
                ],
              },
        (_path, value) => {
          summary.push(value);
        },
      );
      expect(selected.tests).toEqual([changedTest]);
      expect(summary.join("")).toContain(
        "Full exact-head final acceptance remains required",
      );
      paths = "website/docs/page.md\0";
      expect(
        (
          await runCiSelection(
            event,
            environment("pull_request"),
            async () => ({ total_count: 0, workflow_runs: [] }),
            () => {},
          )
        ).package,
      ).toBeFalse();
      expect(
        (
          await runCiSelection(
            event,
            environment("pull_request"),
            async () => ({ workflow_runs: [] }),
            () => {},
          )
        ).package,
      ).toBeTrue();
    } finally {
      spawn.mockRestore();
    }
  });
  test("transport uses read-only GitHub requests and rejects non-success responses", async () => {
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ workflow_runs: [] }),
    );
    try {
      const request = githubRequest("redacted-test-token");
      expect(await request("/repos/owner/repo/actions/runs")).toEqual({
        workflow_runs: [],
      });
      expect(fetcher.mock.calls[0]?.[0]).toBe(
        "https://api.github.com/repos/owner/repo/actions/runs",
      );
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
        headers: {
          Authorization: "Bearer redacted-test-token",
          Accept: "application/vnd.github+json",
        },
      });
      expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined();
      expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      fetcher.mockResolvedValue(new Response("denied", { status: 403 }));
      await expect(request("/denied")).rejects.toThrow(
        "GitHub history request failed",
      );
    } finally {
      fetcher.mockRestore();
    }
  });
});
describe("GitHub API provenance without mutable pull request associations", () => {
  const changedTest = "tests/runtime/snapshot-blob.test.ts";
  const event = {
    number: 1,
    repository: { full_name: repository },
    pull_request: {
      head: {
        sha: oid("e"),
        ref: "fix/50-publication-replacement-fixture",
        repo: { full_name: "contributor/repo" },
      },
      base: { sha: oid("0"), repo: { full_name: repository } },
    },
  };
  // Minimal redacted shape observed on run 40916922407: PR events can return
  // an empty pull_requests array. Modern immutable job provenance fills that gap.
  const historical = {
    id: 40916922407,
    head_sha: oid("a"),
    event: "pull_request",
    path: ".github/workflows/ci.yml",
    run_attempt: 1,
    conclusion: "success" as string | null,
    repository: { full_name: repository },
    head_repository: { full_name: "contributor/repo" },
    head_branch: event.pull_request.head.ref,
    pull_requests: [] as readonly { number: number; base: { sha: string } }[],
  };
  const modernJobs = () =>
    fullJobs().map((job) =>
      job.name === "Full CI acceptance"
        ? {
            ...job,
            name: `Full CI acceptance [PR 1; base ${oid("0")}; website false]`,
          }
        : job,
    );
  async function exercise(
    overrides: Partial<typeof historical> = {},
    jobs = modernJobs(),
    total = jobs.length,
    configurationAvailable = true,
  ) {
    const paths: string[] = [];
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(((
      args: unknown,
    ) => {
      const argv = args as string[];
      return {
        exitCode:
          !configurationAvailable &&
          argv[1] === "rev-parse" &&
          argv[2] !== "HEAD"
            ? 1
            : 0,
        stdout: Buffer.from(
          argv[1] === "diff"
            ? changedTest + "\0"
            : argv[1] === "rev-parse"
              ? argv[2] === "HEAD"
                ? oid("e")
                : oid("f")
              : "",
        ),
      };
    }) as typeof Bun.spawnSync);
    try {
      const selected = await githubSelection(
        event,
        repository,
        40920000000,
        async (path) => {
          paths.push(path);
          return path.includes("/jobs?")
            ? { total_count: total, jobs }
            : { workflow_runs: [{ ...historical, ...overrides }] };
        },
      );
      return { selected, paths };
    } finally {
      spawn.mockRestore();
    }
  }
  test("real empty-association API shape selects changed tests with a verified modern sentinel", async () => {
    const { selected, paths } = await exercise();
    expect(selected.full).toBeFalse();
    expect(selected.tests).toEqual([changedTest]);
    expect(jobCount(selected)).toBe(6);
    expect(paths).toEqual([
      `/repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&per_page=30&branch=fix%2F50-publication-replacement-fixture`,
      `/repos/${repository}/actions/runs/40916922407/jobs?filter=latest&per_page=100`,
    ]);
  });
  test("missing historical configuration cannot authorize empty associations", async () => {
    expect(
      (await exercise({}, modernJobs(), modernJobs().length, false)).selected
        .full,
    ).toBeTrue();
  });
  test("legacy empty associations cannot fabricate PR/base provenance", async () => {
    expect((await exercise({}, fullJobs())).selected.full).toBeTrue();
    expect(
      (
        await exercise(
          { pull_requests: [{ number: 1, base: { sha: oid("0") } }] },
          fullJobs(),
        )
      ).selected.full,
    ).toBeFalse();
  });
  test.each([
    { run_attempt: 2 },
    { conclusion: null },
    { path: ".github/workflows/other.yml" },
    { head_repository: { full_name: "wrong/repo" } },
    { head_branch: "other" },
    { repository: { full_name: "wrong/repo" } },
    { head_sha: "bad" },
    { pull_requests: [{ number: 1, base: { sha: oid("9") } }] },
  ])(
    "unproven or stale historical metadata fails closed: %j",
    async (overrides) => {
      expect((await exercise(overrides)).selected.full).toBeTrue();
    },
  );
  test("wrong sentinel base, duplicate sentinel and truncated jobs fail closed", async () => {
    const wrong = modernJobs().map((job) =>
      job.name.startsWith("Full CI acceptance")
        ? { ...job, name: job.name.replace(oid("0"), oid("9")) }
        : job,
    );
    expect((await exercise({}, wrong)).selected.full).toBeTrue();
    expect(
      (await exercise({}, [...modernJobs(), modernJobs().at(-1)!], 999))
        .selected.full,
    ).toBeTrue();
    const duplicate = [
      ...modernJobs(),
      modernJobs().find((job) => job.name.startsWith("Full CI acceptance"))!,
    ];
    expect((await exercise({}, duplicate)).selected.full).toBeTrue();
  });
});

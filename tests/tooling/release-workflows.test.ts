import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { discoverTestFiles } from "../../scripts/testing/test-shard.ts";
type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
};
type Job = {
  if?: string;
  uses?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  secrets?: Record<string, string>;
  with?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
  strategy?: {
    "fail-fast"?: boolean;
    matrix?:
      | string
      | {
          os?: string[];
          installer?: string[];
          include?: { os: string; target: string }[];
          platform?: {
            os: string;
            platform: string;
            arch: string;
            bun: string;
          }[];
        };
  };
};
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};
async function workflow(name: string): Promise<Workflow> {
  return Bun.YAML.parse(
    await Bun.file(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
    ).text(),
  ) as Workflow;
}
const ci = await workflow("ci");
const release = await workflow("release");
const consumers = await workflow("package-consumers");
const standalone = await workflow("standalone");
function job(source: Workflow, name: string): Job {
  const result = source.jobs[name];
  if (!result) throw new Error(`Missing job ${name}`);
  return result;
}
describe("standalone release contracts", () => {
  test("builds each target on one host and qualifies the exact shared archive", () => {
    const targets = [
      "darwin-arm64",
      "linux-arm64",
      "linux-arm64-musl",
      "linux-x64",
      "linux-x64-musl",
      "windows-x64",
    ];
    const build = job(standalone, "build");
    expect(build.strategy).toBeUndefined();
    const compile = build.steps?.find((step) =>
      step.name?.startsWith("Compile ESM bytecode"),
    )?.run;
    expect(
      compile
        ?.match(/for target in ([^;]+); do/)?.[1]
        ?.split(" ")
        .map((target) => target.replace(/^bun-/, ""))
        .sort(),
    ).toEqual(targets);
    expect(compile).toContain('--target "$target"');
    expect(compile).toContain("ast-mcp-bytecode");
    expect(compile).toContain("shasum -a 256");

    const qualify = job(standalone, "qualify");
    expect(qualify.needs).toBe("build");
    const matrix = qualify.strategy?.matrix;
    expect(
      typeof matrix === "object" &&
        matrix.include?.map(({ target }) => target).sort(),
    ).toEqual(targets);
    expect(
      qualify.steps
        ?.filter((step) => step.run?.includes("qualify-standalone.ts"))
        .map(({ run }) => run?.includes("--bytecode-only --with-pm")),
    ).toEqual([true, true]);

    const upload = build.steps?.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const qualified = qualify.steps?.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    const publication = job(release, "publish-standalone");
    const published = publication.steps?.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    expect([
      upload?.with?.name,
      qualified?.with?.name,
      published?.with?.name,
    ]).toEqual(Array(3).fill("standalone-release-matrix"));
  });

  test("qualifies the npm matrix before publication and verifies the registry", () => {
    const publish = job(release, "publish");
    expect(publish.needs).toEqual([
      "release",
      "validate",
      "build",
      "consumers",
      "standalone",
      "publish-standalone",
    ]);
    expect(publish.permissions?.["id-token"]).toBe("write");
    expect(publish.steps?.map((step) => step.run).join("\n")).toContain(
      "scripts/release/publish-npm.ts",
    );
    expect(job(release, "verify-registry")).toMatchObject({
      needs: ["release", "publish"],
      uses: "./.github/workflows/standalone.yml",
      with: {
        registry_version: "${{ needs.publish.outputs.registry_version }}",
      },
    });
    expect(job(release, "publish-notes").needs).toContain("verify-registry");
  });

  test("attaches only complete qualified assets to the tagged release", () => {
    expect(job(release, "standalone")).toMatchObject({
      needs: ["release", "build"],
      uses: "./.github/workflows/standalone.yml",
      with: {
        ref: "${{ needs.release.outputs.tag_name }}",
        package_artifact_name: "release-candidate",
        native_npm: "${{ needs.build.outputs.native_npm == 'true' }}",
      },
    });
    const publication = job(release, "publish-standalone");
    expect(publication.needs).toEqual(["release", "validate", "standalone"]);
    expect(publication.permissions).toEqual({ contents: "write" });
    const attach = publication.steps?.find((step) => step.run)?.run;
    expect(attach).toContain("ast-mcp-v[0-9]");
    expect(
      attach
        ?.match(/for target in ([^;]+); do/)?.[1]
        ?.split(" ")
        .sort(),
    ).toEqual([
      "darwin-arm64",
      "linux-arm64",
      "linux-arm64-musl",
      "linux-x64",
      "linux-x64-musl",
      "windows-x64",
    ]);
    expect(attach).toContain('sha256sum --check --strict "$archive.sha256"');
    expect(attach).toContain('for asset in "$archive" "$archive.sha256"');
    expect(attach).toContain('gh release upload "$RELEASE_TAG" "$asset"');
  });
});

describe("executed CI acceptance contracts", () => {
  test("declared qualifiers use package test policy and select the intended behavior", async () => {
    const root = await mkdtemp(join(tmpdir(), "ast-mcp-workflow-tests-"));
    const marker = join(root, "executed");
    const manifest = (await Bun.file(
      new URL("../../package.json", import.meta.url),
    ).json()) as { scripts: { test: string } };
    const cli = "CLI mcp subcommand remains alive for a stdio handshake";
    const native = "calls native code intelligence through the server";
    const fixture = (names: string[]) =>
      `import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
${names
  .map(
    (name) => `test(${JSON.stringify(name)}, () => {
expect(process.env.AST_MCP_FIXTURE_TEST_POLICY).toBe("active");
appendFileSync(process.env.AST_MCP_FIXTURE_TEST_MARKER!, ${JSON.stringify(name)});
});`,
  )
  .join("\n")}`;
    try {
      await Promise.all([
        mkdir(join(root, "tests/integration"), { recursive: true }),
        mkdir(join(root, "tests/tooling"), { recursive: true }),
        writeFile(
          join(root, "package.json"),
          JSON.stringify({
            scripts: {
              test: `AST_MCP_FIXTURE_TEST_POLICY=active ${manifest.scripts.test}`,
            },
          }),
        ),
      ]);
      await Promise.all([
        writeFile(
          join(root, "tests/integration/mcp.test.ts"),
          fixture([cli, native]) +
            '\ntest("unrelated behavior", () => { throw new Error("qualifier filter missing"); });',
        ),
        writeFile(
          join(root, "tests/integration/package-consumers.test.ts"),
          fixture(["packed consumer"]),
        ),
      ]);
      for (const [source, jobName, stepName, expected] of [
        [ci, "package-native", "Verify CLI MCP stdio handshake", cli],
        [ci, "package-native", "Verify native MCP stdio handshake", native],
        [release, "validate", "Mandatory CLI MCP stdio handshake", cli],
        [
          release,
          "validate",
          "Mandatory native MCP stdio initialize, tools, and workspace handshake",
          native,
        ],
        [
          consumers,
          "consumers",
          "Qualify packed production installation",
          "packed consumer",
        ],
      ] as const) {
        const step = job(source, jobName).steps?.find(
          (s) => s.name === stepName,
        );
        if (!step?.run) throw new Error(`Missing qualifier: ${stepName}`);
        await writeFile(marker, "");
        const result = await $`${{ raw: step.run }}`
          .cwd(root)
          .env({ ...process.env, AST_MCP_FIXTURE_TEST_MARKER: marker })
          .quiet()
          .nothrow();
        expect(result.exitCode).toBe(0);
        expect(await readFile(marker, "utf8")).toBe(expected);
      }
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

  function fullOutputs(): Record<string, string> {
    const inputs = (
      consumers.on.workflow_call as { inputs: { matrix: { default: string } } }
    ).inputs;
    return {
      package: "true",
      full: "true",
      coverage: "true",
      consumers: "true",
      native: "true",
      website: "false",
      platforms: JSON.stringify({
        include: ["macos-latest", "windows-latest"].flatMap((os) =>
          [0, 1, 2].map((shard) => ({ os, shard, shards: 3, selected: false })),
        ),
      }),
      consumer_matrix: inputs.matrix.default,
      native_matrix: JSON.stringify({
        include: ["ubuntu-latest", "macos-latest", "windows-latest"].map(
          (os) => ({ os }),
        ),
      }),
    };
  }
  type Results = Record<
    string,
    { result: string; outputs?: Record<string, string> }
  >;
  function results(outputs = fullOutputs()): Results {
    return {
      changes: { result: "success", outputs },
      ...Object.fromEntries(
        [
          "package-static",
          "package-coverage",
          "package-platform-tests",
          "package-consumers",
          "package-native",
        ].map((name) => [name, { result: "success" }]),
      ),
      website: { result: outputs.website === "true" ? "success" : "skipped" },
    };
  }
  async function execute(
    value: Results,
    diagnostics: {
      jobs?: unknown[];
      annotations?: unknown[];
      jobsError?: boolean;
      annotationsError?: boolean;
    } = {},
  ) {
    const script = job(ci, "ci-acceptance").steps?.[0]?.with?.script;
    if (typeof script !== "string")
      throw new Error("Missing acceptance JavaScript");
    const failures: string[] = [],
      summaries: string[] = [];
    const core = {
      setFailed: (message: string) => {
        failures.push(message);
      },
      summary: {
        addRaw: (message: string) => ({
          write: async () => {
            summaries.push(message);
          },
        }),
      },
    };
    await new Function(
      "core",
      "process",
      "github",
      "context",
      "return (async () => {\n" + script + "\n})();",
    )(
      core,
      {
        env: {
          RESULTS: JSON.stringify(value),
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_JOB_NAME: "Full CI acceptance",
        },
      },
      {
        rest: {
          actions: { listJobsForWorkflowRunAttempt: "jobs" },
          checks: { listAnnotations: "annotations" },
        },
        paginate: async (
          endpoint: string,
          parameters: Record<string, unknown>,
        ) => {
          expect(parameters).toMatchObject({
            owner: "owner",
            repo: "repo",
            per_page: 100,
          });
          if (endpoint === "jobs") {
            expect(parameters).toMatchObject({ run_id: 42, attempt_number: 2 });
            if (diagnostics.jobsError) throw new Error("jobs API unavailable");
            return diagnostics.jobs ?? [];
          }
          expect(parameters.check_run_id).toBe(123);
          if (diagnostics.annotationsError)
            throw new Error("annotations API unavailable");
          return diagnostics.annotations ?? [];
        },
      },
      { repo: { owner: "owner", repo: "repo" }, runId: 42 },
    );
    return { failures, summaries };
  }
  test.each(["abandoned", "cancelled", "failure", "skipped", "missing"])(
    "acceptance reports expected and actual native status: %s",
    async (actual) => {
      const value = results();
      if (actual === "missing") delete value["package-native"];
      else value["package-native"]!.result = actual;
      const outcome = await execute(value);
      expect(outcome.failures.join("\n")).toContain(
        "package-native: expected success; actual " + actual,
      );
    },
  );
  test("acceptance reports the originating matrix job and capacity annotation", async () => {
    const value = results();
    value["package-native"]!.result = "abandoned";
    const outcome = await execute(value, {
      jobs: [
        {
          id: 123,
          name: "Native package qualification (macos-latest)",
          status: "completed",
          conclusion: "cancelled",
          runner_name: "",
          html_url: "https://github.com/owner/repo/actions/runs/42/job/123",
          steps: [],
        },
        { name: "Full CI acceptance", conclusion: null },
        { name: "Linux", conclusion: "success" },
        { name: "Release", conclusion: "skipped" },
      ],
      annotations: [
        {
          annotation_level: "failure",
          message:
            "The job was not acquired by Runner of type hosted even after multiple attempts",
        },
        {
          annotation_level: "notice",
          message:
            "Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times.",
        },
      ],
    });
    const report = outcome.failures.join("\n");
    expect(report).toContain(
      "package-native: expected success; actual abandoned",
    );
    expect(report).toContain(
      "Native package qualification (macos-latest): status completed; conclusion cancelled; runner not assigned",
    );
    expect(report).toContain(
      "https://github.com/owner/repo/actions/runs/42/job/123",
    );
    expect(report).toContain(
      "The job was not acquired by Runner of type hosted",
    );
    expect(report).toContain("Due to capacity constraints");
    expect(report).not.toContain("Full CI acceptance:");
    expect(outcome.summaries[0]).toContain(report);
  });
  test("acceptance reports failed steps and preserves failures when metadata APIs fail", async () => {
    const value = results();
    value["package-native"]!.result = "failure";
    const failedJob = {
      id: 123,
      name: "Native Windows",
      status: "completed",
      conclusion: "failure",
      runner_name: "hosted-1",
      html_url: "job-link",
      steps: [
        { name: "Install", conclusion: "success" },
        { name: "Qualify native dependencies", conclusion: "failure" },
        { name: "Handshake", conclusion: "skipped" },
      ],
    };
    const stepFailure = await execute(value, {
      jobs: [failedJob],
      annotationsError: true,
    });
    expect(stepFailure.failures[0]).toContain(
      "Step Qualify native dependencies: failure",
    );
    expect(stepFailure.failures[0]).toContain(
      "Runner annotations unavailable: annotations API unavailable",
    );
    expect(stepFailure.failures[0]).not.toContain("Step Install");
    const unavailable = await execute(value, { jobsError: true });
    expect(unavailable.failures[0]).toContain(
      "package-native: expected success; actual failure",
    );
    expect(unavailable.failures[0]).toContain(
      "Upstream job diagnostics unavailable: jobs API unavailable",
    );
  });
  test("only exact supported full matrices and successful gates report full completion", async () => {
    const outputs = fullOutputs();
    // Matrix order is immaterial, but every supported combination is required.
    for (const name of ["platforms", "consumer_matrix", "native_matrix"]) {
      const matrix = JSON.parse(outputs[name]!) as { include: unknown[] };
      outputs[name] = JSON.stringify({ include: matrix.include.reverse() });
    }
    const outcome = await execute(results(outputs));
    expect(outcome.failures).toEqual([]);
    expect(outcome.summaries).toEqual([
      "Full exact-head qualification completed.",
    ]);
  });
  test.each(["failure", "skipped", "missing"])(
    "failed, skipped or missing gates never produce a completion summary: %s",
    async (state) => {
      for (const name of [
        "changes",
        "package-static",
        "package-coverage",
        "package-platform-tests",
        "package-consumers",
        "package-native",
        "website",
      ]) {
        const value = results({ ...fullOutputs(), website: "true" });
        if (state === "missing") delete value[name];
        else value[name]!.result = state;
        const outcome = await execute(value);
        expect(outcome.failures).toHaveLength(1);
        expect(outcome.summaries).toHaveLength(1);
        expect(outcome.summaries[0]).toContain("CI qualification failed.");
        expect(outcome.summaries[0]).not.toContain("completed");
      }
    },
  );
  test.each(["package", "full", "coverage", "website", "consumers", "native"])(
    "missing and malformed selection flags cannot pass as false: %s",
    async (flag) => {
      for (const invalid of [
        undefined,
        null,
        true,
        false,
        0,
        "",
        "TRUE",
        " false ",
      ]) {
        const outputs = fullOutputs();
        for (const name of [
          "package",
          "full",
          "coverage",
          "website",
          "consumers",
          "native",
        ])
          outputs[name] = "false";
        if (invalid === undefined) delete outputs[flag];
        else Object.assign(outputs, { [flag]: invalid });
        const value = results(outputs);
        for (const [name, result] of Object.entries(value))
          if (name !== "changes") result.result = "skipped";
        const outcome = await execute(value);
        expect(outcome.failures.join("\n")).toContain(
          flag + " must be an exact boolean string",
        );
        expect(outcome.summaries).toHaveLength(1);
        expect(outcome.summaries[0]).toContain("CI qualification failed.");
        expect(outcome.summaries[0]).not.toContain("completed");
      }
    },
  );
  test.each(["package", "coverage", "consumers", "native"])(
    "a full label cannot disable a required flag: %s",
    async (flag) => {
      const outcome = await execute(
        results({ ...fullOutputs(), [flag]: "false" }),
      );
      expect(outcome.failures.join("\n")).toContain(
        "Full qualification requires " + flag,
      );
      expect(outcome.summaries.join("\n")).not.toContain(
        "Full exact-head qualification completed.",
      );
    },
  );
  test.each(["platforms", "consumer_matrix", "native_matrix"])(
    "reduced, duplicate, unsupported and malformed full matrix entries fail: %s",
    async (name) => {
      const original = JSON.parse(fullOutputs()[name]!) as {
        include: Record<string, unknown>[];
      };
      const invalid = [
        JSON.stringify({ include: original.include.slice(1) }),
        JSON.stringify({
          include: [...original.include.slice(0, -1), original.include[0]],
        }),
        JSON.stringify({
          include: [
            { ...original.include[0], unsupported: true },
            ...original.include.slice(1),
          ],
        }),
        JSON.stringify({
          include: [
            {
              ...original.include[0],
              ...(name === "consumer_matrix"
                ? { installer: "unsupported" }
                : { os: "unsupported" }),
            },
            ...original.include.slice(1),
          ],
        }),
        JSON.stringify({ include: "not-an-array" }),
        "invalid JSON",
      ];
      for (const matrix of invalid) {
        const outcome = await execute(
          results({ ...fullOutputs(), [name]: matrix }),
        );
        expect(outcome.failures.join("\n")).toContain(
          name + " does not match the full supported matrix",
        );
        expect(outcome.summaries.join("\n")).not.toContain("completed");
      }
    },
  );
  test("selected and no-package acceptance retain their explicit qualification boundaries", async () => {
    const selected = results({
      ...fullOutputs(),
      full: "false",
      coverage: "false",
      consumers: "false",
      native: "false",
    });
    selected["package-consumers"]!.result = "skipped";
    selected["package-native"]!.result = "skipped";
    const partial = await execute(selected);
    expect(partial.failures).toEqual([]);
    expect(partial.summaries).toEqual([
      "Affected scope completed. Full exact-head acceptance remains required before merge/release.",
    ]);
    selected.changes!.outputs!.package = "false";
    for (const name of [
      "package-static",
      "package-coverage",
      "package-platform-tests",
    ])
      selected[name]!.result = "skipped";
    const documentation = await execute(selected);
    expect(documentation.failures).toEqual([]);
    expect(documentation.summaries).toEqual([
      "Documentation/website scope completed; package qualification was not requested.",
    ]);
  });
});
describe("release workflow contracts", () => {
  test("dispatch requires exact commit and forces every cohort", () => {
    expect(ci.on.workflow_dispatch).toEqual({
      inputs: {
        expected_sha: {
          description: "Exact release PR commit to validate",
          required: false,
          type: "string",
        },
        recovery_tag: {
          description: "Published release tag to validate and publish",
          required: false,
          type: "string",
        },
      },
    });
    const changes = job(ci, "changes");
    for (const cohort of ["package", "release", "templates", "website"])
      expect(changes.outputs?.[cohort]).toContain(
        "github.event_name == 'workflow_dispatch' && 'true'",
      );
    expect(
      changes.steps?.find((s) => s.uses?.startsWith("dorny/paths-filter@"))?.if,
    ).toBe("github.event_name != 'workflow_dispatch'");
    const verification = changes.steps?.find((s) => s.env?.EXPECTED_SHA);
    expect(verification?.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(verification?.env?.EXPECTED_SHA).toBe("${{ inputs.expected_sha }}");
    expect(verification?.env?.RECOVERY_TAG).toBe("${{ inputs.recovery_tag }}");
    expect(verification?.run).toContain("git rev-parse HEAD");
    expect(verification?.run).toContain('"$EXPECTED_SHA"');
    expect(verification?.run).toContain('"$GITHUB_REF" = refs/heads/main');
  });
  test("dispatch rejects stale event or checkout commits", async () => {
    const verification = job(ci, "changes").steps?.find(
      (s) => s.env?.EXPECTED_SHA,
    );
    if (!verification?.run) throw new Error("Missing dispatch verification");
    const head = (await $`git rev-parse HEAD`.text()).trim();
    const other = head === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40);
    for (const [event, expected, recovery, ref, exitCode] of [
      [head, head, "", "refs/heads/main", 0],
      [other, head, "", "refs/heads/main", 1],
      [other, other, "", "refs/heads/main", 1],
      [head, "", "ast-mcp-v0.6.1", "refs/heads/main", 0],
      [head, "", "ast-mcp-v0.6.1", "refs/heads/other", 1],
      [head, "", "", "refs/heads/main", 1],
      [head, head, "ast-mcp-v0.6.1", "refs/heads/main", 1],
    ] as const) {
      const result = await $`bash -c ${verification.run}`
        .env({
          ...process.env,
          GITHUB_SHA: event,
          GITHUB_REF: ref,
          EXPECTED_SHA: expected,
          RECOVERY_TAG: recovery,
        })
        .quiet()
        .nothrow();
      expect(result.exitCode).toBe(exitCode);
    }
  });
  test("every CI checkout uses requested head", () => {
    let checkouts = 0;
    for (const candidate of Object.values(ci.jobs))
      for (const step of candidate.steps ?? []) {
        if (!step.uses?.startsWith("actions/checkout@")) continue;
        checkouts++;
        expect(step.with?.ref).toBe(
          "${{ github.event.pull_request.head.sha || inputs.expected_sha || github.sha }}",
        );
      }
    expect(checkouts).toBeGreaterThanOrEqual(6);
  });
  test.each(["true", "false"])(
    "actual platform launcher executes the same single test file in selected=%s mode",
    async (selected) => {
      const launcher = job(ci, "package-platform-tests").steps?.find(
        (step) => step.env?.SELECTED,
      )?.run;
      if (!launcher) throw new Error("Missing platform test launcher");
      const files = discoverTestFiles();
      const testPath = "tests/tooling/test-shard.test.ts";
      const shard = files.indexOf(testPath);
      if (shard < 0)
        throw new Error("Launcher regression test is not discoverable");
      const result = await $`bash -c ${launcher}`
        .env({
          ...process.env,
          AST_MCP_SKIP_PACKAGE_SMOKE: "1",
          AST_MCP_SELECTED_TESTS: JSON.stringify([testPath]),
          SELECTED: selected,
          SHARD: String(shard),
          SHARDS: String(files.length),
        })
        .quiet()
        .nothrow();
      expect({
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
      }).toMatchObject({ exitCode: 0 });
      expect(result.stdout.toString()).toContain(
        selected === "true"
          ? "Running test shard index 0 of 1: 1 files"
          : `Running test shard index ${shard} of ${files.length}: 1 files`,
      );
    },
  );
  test("PR selection preserves full final acceptance and safe selected argv", () => {
    const changes = job(ci, "changes");
    expect(changes.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
      actions: "read",
    });
    expect(
      changes.steps?.find(
        (step) => step.run === "bun scripts/testing/ci-selection.ts",
      )?.env?.GITHUB_TOKEN,
    ).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(job(ci, "package-platform-tests").strategy?.matrix).toBe(
      "${{ fromJSON(needs.changes.outputs.platforms) }}",
    );
    expect(job(ci, "package-native").if).toContain("outputs.native");
    expect(job(ci, "package-consumers").if).toContain("outputs.consumers");
    const coverage = job(ci, "package-coverage").steps ?? [];
    expect(
      coverage.find((step) => step.run?.startsWith("bun run test:coverage "))
        ?.if,
    ).toContain("coverage == 'true'");
    expect(
      coverage.find((step) => step.run?.endsWith("--selected"))?.env
        ?.AST_MCP_SELECTED_TESTS,
    ).toBe("${{ needs.changes.outputs.selected_tests }}");
    const acceptance = job(ci, "ci-acceptance");
    expect(acceptance.if).toBe("always()");
    expect(acceptance).toMatchObject({
      name: "${{ format('{0} CI acceptance [PR {1}; base {2}; website {3}]', needs.changes.outputs.package != 'true' && 'No package' || needs.changes.outputs.full == 'true' && 'Full' || 'Selected', github.event.pull_request.number || 0, github.event.pull_request.base.sha || github.sha, needs.changes.outputs.website == 'true' && 'true' || 'false') }}",
    });
    expect(acceptance.steps?.[0]?.with?.script).toContain(
      "results[key]?.result !== expected",
    );
    expect(job(ci, "release").needs).toContain("ci-acceptance");
  });
  test("release can be suppressed on a main push without skipping qualification", () => {
    expect(job(ci, "release").if).toContain(
      "!contains(github.event.head_commit.message, '[skip release]')",
    );
    for (const name of ["package-static", "package-native", "ci-acceptance"]) {
      expect(job(ci, name).if).not.toContain("[skip release]");
    }
  });
  test("capacity retry uses trusted workflow code and narrowly scoped permissions", async () => {
    const retry = await workflow("ci-capacity-retry");
    expect(retry.on).toEqual({
      workflow_run: { workflows: ["CI"], types: ["completed"] },
    });
    expect(retry.permissions).toEqual({});
    const handler = job(retry, "retry");
    expect(handler.permissions).toEqual({
      actions: "write",
      checks: "read",
      contents: "read",
    });
    const checkout = handler.steps?.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with).toEqual({
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
    });
    expect(
      handler.steps?.some((step) =>
        /download-artifact|bun ci|bun install/.test(
          step.uses ?? step.run ?? "",
        ),
      ),
    ).toBe(false);
    expect(
      handler.steps?.find(
        (step) => step.run === "bun scripts/testing/ci-capacity-retry.ts",
      )?.env?.GITHUB_TOKEN,
    ).toBe("${{ github.token }}");
    expect(job(ci, "ci-acceptance").permissions).toEqual({
      actions: "read",
      checks: "read",
    });
  });
  test("release condition suppresses marked pushes and preserves recovery and qualification", () => {
    const expression = job(ci, "release").if!.replace(
      /needs\.([a-z]+(?:-[a-z]+)+)/g,
      'needs["$1"]',
    );
    const evaluate = new Function(
      "github",
      "inputs",
      "needs",
      "always",
      "contains",
      "return (" + expression.slice(3, -2) + ");",
    );
    const needs: Record<string, unknown> = Object.fromEntries(
      [
        "package-static",
        "package-consumers",
        "package-coverage",
        "package-platform-tests",
        "package-native",
        "ci-acceptance",
        "website",
      ].map((name) => [name, { result: "success" }]),
    );
    needs.changes = { outputs: { release: "true" } };
    const github = {
      ref: "refs/heads/main",
      event_name: "push",
      event: { head_commit: { message: "ci: improve diagnostics" } },
    };
    const inputs = { recovery_tag: "" };
    const check = () =>
      evaluate(
        github,
        inputs,
        needs,
        () => true,
        (text: string, value: string) =>
          text.toLowerCase().includes(value.toLowerCase()),
      );
    expect(check()).toBe(true);
    github.event.head_commit.message += " [skip release]";
    expect(check()).toBe(false);
    github.event_name = "workflow_dispatch";
    inputs.recovery_tag = "ast-mcp-v0.7.1";
    expect(check()).toBe(true);
    needs["package-native"] = { result: "failure" };
    expect(check()).toBe(false);
    needs["package-native"] = { result: "success" };
    github.event_name = "pull_request";
    expect(check()).toBe(false);
  });
  test("release recovery uses the registered CI workflow", () => {
    expect(job(ci, "release").if).toContain("github.event_name == 'push'");
    expect(job(ci, "release").if).toContain("inputs.recovery_tag != ''");
    expect(job(ci, "release").if).toContain("github.ref == 'refs/heads/main'");
    expect(job(ci, "release").uses).toBe("./.github/workflows/release.yml");
    expect(job(ci, "release").with?.recovery_tag).toBe(
      "${{ inputs.recovery_tag }}",
    );
    expect(Object.keys(release.on)).toEqual(["workflow_call"]);
    expect(job(release, "validate").if).toContain(
      "needs.release.outputs.release_created == 'true'",
    );
    expect(job(release, "publish").if).toContain(
      "needs.release.outputs.release_created == 'true'",
    );
    expect(job(release, "publish").if).toContain(
      "needs.validate.result == 'success'",
    );
    for (const qualifier of ["consumers", "standalone", "publish-standalone"])
      expect(job(release, "publish").if).toContain(
        "needs." + qualifier + ".result == 'success'",
      );
    expect(job(ci, "release").if).toContain(
      "needs.package-consumers.result == 'success'",
    );
  });
  test("release recovery verifies a published tag before validation", () => {
    const creator = job(release, "release");
    const steps = creator.steps ?? [];
    const requireMain = steps.find((step) =>
      step.run?.includes('test "$GITHUB_REF" = refs/heads/main'),
    );
    expect(requireMain?.if).toBe("inputs.recovery_tag != ''");
    const action = steps.find((step) =>
      step.uses?.startsWith("googleapis/release-please-action@"),
    );
    expect(action?.if).toBe("inputs.recovery_tag == ''");
    expect(action?.["continue-on-error"]).toBe(true);
    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(steps.indexOf(checkout!)).toBeGreaterThan(steps.indexOf(action!));
    expect(checkout?.if).toContain("steps.release.outcome == 'failure'");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    const recover = steps.find((step) => step.env?.RELEASE_TAG);
    expect(recover?.if).toContain("steps.release.outcome == 'failure'");
    expect(recover?.env?.RELEASE_TAG).toBe("${{ inputs.recovery_tag }}");
    expect(recover?.env?.RECOVERY_TAG).toBe("${{ inputs.recovery_tag }}");
    expect(recover?.run).toContain('if [[ -z "$RECOVERY_TAG" ]]');
    expect(recover?.run).not.toContain("${{ inputs.recovery_tag }}");
    for (const required of [
      "jq -r .draft",
      "jq -r .target_commitish",
      "git rev-list -n 1",
      "git merge-base --is-ancestor",
      'git show "$RELEASE_TAG:package.json"',
      'test "$tag_commit" = "$GITHUB_SHA"',
    ])
      expect(recover?.run).toContain(required);
    expect(creator.outputs?.release_created).toContain(
      "steps.recover.outputs.release_created",
    );
    expect(creator.outputs?.tag_name).toContain(
      "steps.recover.outputs.tag_name",
    );
  });
  test("only dispatch concrete job grants actions write", () => {
    expect(release.permissions).toEqual({});
    expect(
      Object.entries(release.jobs)
        .filter(([, j]) => j.permissions?.actions === "write")
        .map(([name]) => name),
    ).toEqual(["dispatch-ci"]);
    expect(job(release, "dispatch-ci").permissions).toEqual({
      contents: "write",
      "pull-requests": "read",
      actions: "write",
    });
    expect(job(release, "dispatch-ci").if).toContain(
      "needs.release.outputs.prs_created == 'true'",
    );
    expect(job(ci, "release").permissions?.actions).toBe("write");
    expect(ci.permissions?.actions).toBeUndefined();
  });
  test("creator uses a workflow-scoped token and passes PR metadata", () => {
    expect(release.on.workflow_call).toEqual({
      inputs: {
        recovery_tag: {
          description: "Published release tag to validate and publish",
          required: false,
          type: "string",
        },
      },
      secrets: { RELEASE_PLEASE_TOKEN: { required: true } },
    });
    expect(job(ci, "release").secrets).toEqual({
      RELEASE_PLEASE_TOKEN: "${{ secrets.RELEASE_PLEASE_TOKEN }}",
    });
    const creator = job(release, "release");
    expect(
      creator.steps?.find((s) =>
        s.uses?.startsWith("googleapis/release-please-action@"),
      )?.with?.token,
    ).toBe("${{ secrets.RELEASE_PLEASE_TOKEN }}");
    expect(creator.outputs?.prs).toBe("${{ steps.release.outputs.prs }}");
    const dispatch = job(release, "dispatch-ci").steps?.find(
      (s) => s.run === "bun scripts/release/dispatch-release-ci.ts",
    );
    expect(dispatch?.env?.RELEASE_PRS).toBe("${{ needs.release.outputs.prs }}");
    expect(dispatch?.env?.GITHUB_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    const steps = job(release, "dispatch-ci").steps ?? [];
    const checkout = steps.findIndex((s) =>
      s.uses?.startsWith("actions/checkout@"),
    );
    const install = steps.findIndex((s) => s.run === "bun ci");
    const normalize = steps.indexOf(dispatch!);
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(checkout);
    expect(normalize).toBeGreaterThan(install);
    expect(steps[checkout]?.with?.["persist-credentials"]).toBe(false);
    expect(steps[checkout]?.with?.ref).toBeUndefined();
    expect(steps.some((s) => /git push|git checkout/.test(s.run ?? ""))).toBe(
      false,
    );
  });
  test("packed qualification covers actual platforms, installers, and minimum Bun", () => {
    const qualification = job(consumers, "consumers");
    expect(qualification.strategy?.["fail-fast"]).toBe(false);
    expect(qualification.strategy?.matrix).toBe(
      "${{ fromJSON(inputs.matrix) }}",
    );
    const inputs = (
      consumers.on.workflow_call as {
        inputs: Record<
          string,
          { default?: string; required?: boolean; type?: string }
        >;
      }
    ).inputs;
    const combinations = JSON.parse(inputs.matrix!.default!).include as Array<{
      installer: string;
      platform: { os: string; platform: string; arch: string; bun: string };
    }>;
    expect(combinations).toHaveLength(12);
    expect([...new Set(combinations.map((item) => item.installer))]).toEqual([
      "bun",
      "npm",
    ]);
    expect([
      ...new Map(
        combinations.map((item) => [
          JSON.stringify(item.platform),
          item.platform,
        ]),
      ).values(),
    ]).toEqual([
      { os: "macos-15", platform: "darwin", arch: "arm64", bun: "1.4.4" },
      {
        os: "ubuntu-24.04-arm",
        platform: "linux",
        arch: "arm64",
        bun: "1.4.4",
      },
      { os: "ubuntu-24.04", platform: "linux", arch: "x64", bun: "1.4.4" },
      { os: "windows-2025", platform: "win32", arch: "x64", bun: "1.4.4" },
      { os: "macos-15", platform: "darwin", arch: "arm64", bun: "1.4.3" },
      {
        os: "ubuntu-24.04-arm",
        platform: "linux",
        arch: "arm64",
        bun: "1.4.3",
      },
    ]);
    const steps = qualification.steps ?? [];
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe(
      "${{ inputs.checkout_ref || github.sha }}",
    );
    expect(inputs.artifact_name).toEqual({ required: true, type: "string" });
    expect(inputs.checkout_ref).toMatchObject({
      required: false,
      type: "string",
    });
    expect(inputs.matrix).toMatchObject({ required: false, type: "string" });
    expect(job(ci, "package-consumers").with?.matrix).toBe(
      "${{ needs.changes.outputs.consumer_matrix }}",
    );
    expect(job(release, "consumers").with?.matrix).toBeUndefined();
    const architecture = steps.find((s) => s.env?.EXPECTED_ARCH);
    expect(architecture?.run).toContain(
      "process.arch !== process.env.EXPECTED_ARCH",
    );
    expect(architecture?.run).toContain(
      "process.platform !== process.env.EXPECTED_PLATFORM",
    );
    expect(architecture?.run).toContain("glibcVersionRuntime");
    const configure = steps.find((s) => s.env?.CONSUMER_VERSION);
    expect(configure?.run).toContain("AST_MCP_CONSUMER_BUN=");
    expect(configure?.run).toContain("AST_MCP_PACKAGE_ARCHIVE=");
    expect(configure?.run).toContain("Consumer Bun version mismatch");
    const smoke = steps.find(
      (s) => s.name === "Qualify packed production installation",
    );
    expect(smoke?.run).toBeDefined();
    expect(smoke?.env?.AST_MCP_SKIP_PACKAGE_SMOKE).toBe("0");
    expect(smoke?.env?.AST_MCP_CONSUMER_INSTALLER).toBe(
      "${{ matrix.installer }}",
    );
    expect(steps.some((s) => s.run?.includes("checksum mismatch"))).toBe(true);
    for (const [source, name, artifact] of [
      [ci, "package-consumers", "package-candidate"],
      [release, "consumers", "release-candidate"],
    ] as const) {
      expect(job(source, name).uses).toBe(
        "./.github/workflows/package-consumers.yml",
      );
      expect(job(source, name).with?.artifact_name).toBe(artifact);
      expect(job(source, name).with?.ref).toBeUndefined();
    }
  });
  test("publishing uses the qualified archive without rebuilding", () => {
    const matrix = job(release, "validate").strategy?.matrix;
    if (!matrix || typeof matrix === "string")
      throw new Error(
        "Release validation requires an explicit platform matrix",
      );
    expect(matrix.os).toEqual([
      "ubuntu-24.04",
      "ubuntu-24.04-arm",
      "macos-15",
      "windows-2025",
    ]);

    for (const name of ["validate", "build"])
      expect(
        job(release, name).steps?.find((s) =>
          s.uses?.startsWith("actions/checkout@"),
        )?.with?.ref,
      ).toBe("${{ needs.release.outputs.tag_name }}");
    const producer = job(release, "build").steps ?? [];
    expect(producer.filter((s) => s.run?.includes("bun pm pack")).length).toBe(
      1,
    );
    expect(
      producer.some(
        (s) =>
          s.env?.AST_MCP_SKIP_PACKAGE_SMOKE === "1" &&
          s.run === "bun run check",
      ),
    ).toBe(true);
    expect(
      producer.find((s) => s.uses?.startsWith("actions/upload-artifact@"))?.with
        ?.name,
    ).toBe("release-candidate");
    expect(job(release, "publish").permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    const steps = job(release, "publish").steps ?? [];
    expect(steps.some((s) => s.run === "npm install --global npm@12.2.0")).toBe(
      true,
    );
    expect(
      steps.find((s) => s.uses?.startsWith("actions/download-artifact@"))?.with
        ?.name,
    ).toBe("release-candidate");
    const publish = steps.find(
      (s) => s.name === "Publish and verify the qualified npm archives",
    )?.run;
    expect(publish).toContain("scripts/release/publish-npm.ts");
    const legacy = publish?.split("\nelse\n")[1];
    expect(legacy).toContain(
      'test "$digest" = "$(cat package-artifact/ast-mcp.tgz.sha256)"',
    );
    expect(legacy).toContain(
      "npm publish ./package-artifact/ast-mcp.tgz --access public --provenance --ignore-scripts",
    );
    expect(
      steps.some((s) =>
        /bun ci|bun run|bun pm pack|npm pack/.test(s.run ?? ""),
      ),
    ).toBe(false);
    expect(
      steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with,
    ).toMatchObject({
      ref: "${{ needs.release.outputs.tag_name }}",
      "persist-credentials": false,
    });
    const node = steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
    expect(node?.with?.["node-version"]).toBe(24);
    expect(node?.with?.["registry-url"]).toBeUndefined();
    expect(steps.some((s) => s.env?.NODE_AUTH_TOKEN !== undefined)).toBe(false);
  });
  test("actions use major references", () => {
    for (const source of [ci, release, consumers])
      for (const candidate of Object.values(source.jobs))
        for (const step of candidate.steps ?? [])
          if (step.uses) expect(step.uses).toMatch(/^[\w.-]+\/[\w./-]+@v\d+$/);
  });
});
test("Release Please preserves identity with professional copy", async () => {
  const config = await Bun.file(
    new URL("../../release-please-config.json", import.meta.url),
  ).json();
  const root = config.packages["."];
  expect(root["release-type"]).toBe("node");
  expect(root["pull-request-title-pattern"]).toBe(
    "chore: release ast-mcp ${version}",
  );
  expect(root["pull-request-header"]).toBe("🚀 Release candidate");
  expect(root["pull-request-footer"]).toContain("📦");
  expect(JSON.stringify(root)).not.toMatch(/beep|boop/i);
  expect(
    root["changelog-sections"].map((s: { type: string }) => s.type),
  ).toEqual([
    "feat",
    "fix",
    "perf",
    "refactor",
    "build",
    "chore",
    "ci",
    "docs",
    "test",
  ]);
  expect(
    await Bun.file(
      new URL("../../.release-please-manifest.json", import.meta.url),
    ).json(),
  ).toHaveProperty(["."]);
});

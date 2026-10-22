import { describe, expect, test } from "bun:test";

import { $ } from "bun";
type Step = {
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
    matrix?: {
      os?: string[];
      installer?: string[];
      platform?: { os: string; platform: string; arch: string; bun: string }[];
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
function job(source: Workflow, name: string): Job {
  const result = source.jobs[name];
  if (!result) throw new Error(`Missing job ${name}`);
  return result;
}
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
        expect(step.with?.ref).toBe("${{ inputs.expected_sha || github.sha }}");
      }
    expect(checkouts).toBeGreaterThanOrEqual(6);
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
    expect(job(release, "publish").needs).toEqual([
      "release",
      "validate",
      "build",
      "consumers",
    ]);
    expect(job(release, "publish").if).toContain(
      "needs.consumers.result == 'success'",
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
    expect(qualification.strategy?.matrix?.installer).toEqual(["bun", "npm"]);
    expect(qualification.strategy?.matrix?.platform).toEqual([
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
    expect(checkout?.with?.ref).toBe("${{ github.sha }}");
    expect(consumers.on.workflow_call).toEqual({
      inputs: { artifact_name: { required: true, type: "string" } },
    });
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
    const smoke = steps.find((s) => s.run?.startsWith("bun test"));
    expect(smoke?.run).toBe(
      "bun test tests/tooling/package-smoke.test.ts --bail",
    );
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
    expect(job(release, "validate").strategy?.matrix?.os).toEqual([
      "ubuntu-24.04",
      "ubuntu-24.04-arm",
      "macos-15",
      "windows-2025",
    ]);
    const sourceChecks = job(release, "validate").steps ?? [];
    expect(
      sourceChecks.filter((s) =>
        s.run?.startsWith("bun test tests/integration/mcp.test.ts"),
      ).length,
    ).toBe(2);
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
    expect(
      steps.some((s) => s.run?.includes("Package archive checksum mismatch")),
    ).toBe(true);
    expect(
      steps.some(
        (s) =>
          s.run ===
          "npm publish ./package-artifact/ast-mcp.tgz --access public --provenance --ignore-scripts",
      ),
    ).toBe(true);
    expect(
      steps.some((s) =>
        /bun ci|bun run|bun pm pack|npm pack/.test(s.run ?? ""),
      ),
    ).toBe(false);
    expect(steps.some((s) => s.uses?.startsWith("actions/checkout@"))).toBe(
      false,
    );
    expect(
      steps.find((s) => s.uses?.startsWith("actions/setup-node@"))?.with?.[
        "node-version"
      ],
    ).toBe(24);
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

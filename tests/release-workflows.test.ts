import { describe, expect, test } from "bun:test";

import { $ } from "bun";
type Step = {
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  uses?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
  strategy?: { matrix?: { os?: string[] } };
};
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};
async function workflow(name: string): Promise<Workflow> {
  return Bun.YAML.parse(
    await Bun.file(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
    ).text(),
  ) as Workflow;
}
const ci = await workflow("ci");
const release = await workflow("release");
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
          required: true,
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
    expect(verification?.run).toContain("git rev-parse HEAD");
    expect(verification?.run).toContain('"$EXPECTED_SHA"');
  });
  test("dispatch rejects stale event or checkout commits", async () => {
    const verification = job(ci, "changes").steps?.find(
      (s) => s.env?.EXPECTED_SHA,
    );
    if (!verification?.run) throw new Error("Missing dispatch verification");
    const head = (await $`git rev-parse HEAD`.text()).trim();
    const other = head === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40);
    for (const [event, expected, exitCode] of [
      [head, head, 0],
      [other, head, 1],
      [other, other, 1],
    ] as const) {
      const result = await $`${{ raw: verification.run }}`
        .env({ ...process.env, GITHUB_SHA: event, EXPECTED_SHA: expected })
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
  test("dispatch cannot create or publish releases", () => {
    expect(job(ci, "release").if).toContain("github.event_name == 'push'");
    expect(job(ci, "release").if).toContain("github.ref == 'refs/heads/main'");
    expect(job(ci, "release").uses).toBe("./.github/workflows/release.yml");
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
    expect(job(release, "publish").needs).toEqual(["release", "validate"]);
  });
  test("only dispatch concrete job grants actions write", () => {
    expect(release.permissions).toEqual({});
    expect(
      Object.entries(release.jobs)
        .filter(([, j]) => j.permissions?.actions === "write")
        .map(([name]) => name),
    ).toEqual(["dispatch-ci"]);
    expect(job(release, "dispatch-ci").permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
      actions: "write",
    });
    expect(job(release, "dispatch-ci").if).toContain(
      "needs.release.outputs.prs_created == 'true'",
    );
    expect(job(ci, "release").permissions?.actions).toBe("write");
    expect(ci.permissions?.actions).toBeUndefined();
  });
  test("creator hands PR metadata and GITHUB_TOKEN to dispatcher", () => {
    const creator = job(release, "release");
    expect(
      creator.steps?.find((s) =>
        s.uses?.startsWith("googleapis/release-please-action@"),
      )?.with?.token,
    ).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(creator.outputs?.prs).toBe("${{ steps.release.outputs.prs }}");
    const dispatch = job(release, "dispatch-ci").steps?.find(
      (s) => s.run === "bun scripts/dispatch-release-ci.ts",
    );
    expect(dispatch?.env?.RELEASE_PRS).toBe("${{ needs.release.outputs.prs }}");
    expect(dispatch?.env?.GITHUB_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
  });
  test("publishing preserves tags platforms and provenance", () => {
    expect(job(release, "validate").strategy?.matrix?.os).toEqual([
      "ubuntu-latest",
      "macos-latest",
      "windows-latest",
    ]);
    for (const name of ["validate", "publish"])
      expect(
        job(release, name).steps?.find((s) =>
          s.uses?.startsWith("actions/checkout@"),
        )?.with?.ref,
      ).toBe("${{ needs.release.outputs.tag_name }}");
    expect(job(release, "publish").permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    const steps = job(release, "publish").steps ?? [];
    expect(steps.some((s) => s.run === "npm install --global npm@12.2.0")).toBe(
      true,
    );
    expect(
      steps.some((s) =>
        s.run?.includes(
          "npm publish --access public --provenance --ignore-scripts",
        ),
      ),
    ).toBe(true);
    expect(
      steps.find((s) => s.uses?.startsWith("actions/setup-node@"))?.with?.[
        "node-version"
      ],
    ).toBe(24);
  });
  test("actions use major references", () => {
    for (const source of [ci, release])
      for (const candidate of Object.values(source.jobs))
        for (const step of candidate.steps ?? [])
          if (step.uses) expect(step.uses).toMatch(/^[\w.-]+\/[\w./-]+@v\d+$/);
  });
});
test("Release Please preserves identity with professional copy", async () => {
  const config = await Bun.file(
    new URL("../release-please-config.json", import.meta.url),
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
      new URL("../.release-please-manifest.json", import.meta.url),
    ).json(),
  ).toHaveProperty(["."]);
});

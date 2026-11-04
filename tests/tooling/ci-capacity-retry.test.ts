import { describe, expect, test, spyOn } from "bun:test";

import {
  capacityRetryRequest,
  runCapacityRetry,
  runCapacityRetryCli,
  type RetryRequest,
} from "../../scripts/testing/ci-capacity-retry.ts";

const repository = "owner/repo";
const endpoint = "/repos/owner/repo/actions/runs/17";
const capacityMessage =
  "The job was not acquired by Runner of type hosted even after multiple attempts";
const annotation = {
  annotation_level: "failure",
  message: capacityMessage,
};
const run = {
  id: 17,
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  status: "completed",
  conclusion: "failure",
  run_attempt: 1,
  head_sha: "a".repeat(40),
  repository: { full_name: repository },
};
const capacity = {
  id: 21,
  name: "Native package qualification (macos-latest)",
  status: "completed",
  conclusion: "cancelled",
  steps: [],
};
const acceptance = {
  id: 22,
  name: `Full CI acceptance [PR 1; base ${"b".repeat(40)}; website true]`,
  status: "completed",
  conclusion: "failure",
  steps: [{ name: "Check qualification" }],
};
function event(overrides = {}) {
  return {
    action: "completed",
    repository: { full_name: repository },
    workflow_run: { ...run, ...overrides },
  };
}
function fixture(
  jobs: readonly unknown[] = [capacity, acceptance],
  overrides: Record<string, unknown> = {},
) {
  const calls: Array<[string, string]> = [];
  const responses: Record<string, unknown> = {
    [endpoint]: run,
    [`${endpoint}/attempts/1/jobs?per_page=100&page=1`]: {
      total_count: jobs.length,
      jobs,
    },
    "/repos/owner/repo/check-runs/21/annotations?per_page=100&page=1": [
      annotation,
    ],
    ...overrides,
  };
  const request: RetryRequest = async (path, method = "GET") => {
    calls.push([path, method]);
    if (method === "POST") return undefined;
    if (!(path in responses)) throw new Error(`Unexpected request: ${path}`);
    return responses[path];
  };
  return { request, calls };
}
describe("hosted runner capacity retry", () => {
  test("retries only failed jobs and dependents after positive runner evidence", async () => {
    const { request, calls } = fixture([
      { ...capacity, conclusion: "abandoned" },
      acceptance,
      { ...capacity, id: 23, conclusion: "success", steps: [{ name: "Test" }] },
      { ...capacity, id: 24, conclusion: "skipped" },
      { ...capacity, id: 25, conclusion: "neutral" },
    ]);
    expect(await runCapacityRetry(event(), repository, request)).toEqual({
      retried: true,
      reason:
        "Requested capacity retry 1 of 3; failed jobs and dependents will rerun.",
      capacityJobs: [capacity.name],
    });
    expect(calls.at(-1)).toEqual([`${endpoint}/rerun-failed-jobs`, "POST"]);
    expect(calls.filter(([path]) => path === endpoint)).toHaveLength(2);
  });
  test("allows the third retry and stops after it", async () => {
    const third = { ...run, run_attempt: 3 };
    const { request, calls } = fixture(undefined, {
      [endpoint]: third,
      [`${endpoint}/attempts/3/jobs?per_page=100&page=1`]: {
        total_count: 2,
        jobs: [capacity, acceptance],
      },
    });
    expect(
      (await runCapacityRetry(event(third), repository, request)).retried,
    ).toBe(true);
    expect(calls.at(-1)?.[1]).toBe("POST");
    const exhausted = fixture();
    expect(
      (
        await runCapacityRetry(
          event({ run_attempt: 4 }),
          repository,
          exhausted.request,
        )
      ).reason,
    ).toContain("Three capacity retries exhausted");
    expect(exhausted.calls).toEqual([]);
  });
  test.each([
    { status: "in_progress" },
    { conclusion: "success" },
    { path: ".github/workflows/release.yml" },
    { name: "Other workflow" },
    { event: "workflow_run" },
    { repository: { full_name: "attacker/repo" } },
  ])("ignores non-eligible completion %j", async (overrides) => {
    const { request, calls } = fixture();
    expect(
      (await runCapacityRetry(event(overrides), repository, request)).retried,
    ).toBe(false);
    expect(calls).toEqual([]);
  });
  test.each([
    { run_attempt: 2 },
    { id: 18 },
    { head_sha: "c".repeat(40) },
    { event: "push" },
    { status: "in_progress" },
  ])("ignores stale event %j", async (overrides) => {
    const { request, calls } = fixture(undefined, {
      [endpoint]: { ...run, ...overrides },
    });
    expect(
      (await runCapacityRetry(event(), repository, request)).reason,
    ).toContain("stale");
    expect(calls).toHaveLength(1);
  });
  test("rechecks the run after inspection to avoid overlapping manual reruns", async () => {
    const fixtureApi = fixture();
    let reads = 0;
    const request: RetryRequest = async (path, method) =>
      path === endpoint && ++reads === 2
        ? { ...run, run_attempt: 2 }
        : fixtureApi.request(path, method);
    expect(
      (await runCapacityRetry(event(), repository, request)).reason,
    ).toContain("changed during inspection");
    expect(fixtureApi.calls.some(([, method]) => method === "POST")).toBe(
      false,
    );
  });
  test.each([
    { ...capacity, steps: [{ name: "Test" }] },
    { ...capacity, conclusion: "timed_out" },
  ])(
    "does not retry executed jobs or unrelated conclusions %j",
    async (job) => {
      const { request, calls } = fixture([job, acceptance]);
      expect(
        (await runCapacityRetry(event(), repository, request)).reason,
      ).toContain("without hosted runner capacity evidence");
      expect(calls.some(([path]) => path.includes("annotations"))).toBe(false);
      expect(calls.some(([, method]) => method === "POST")).toBe(false);
    },
  );
  test("does not hide a genuine test failure beside a capacity failure", async () => {
    const { request, calls } = fixture([
      capacity,
      acceptance,
      {
        ...capacity,
        id: 99,
        name: "Tests",
        conclusion: "failure",
        steps: [{ name: "Test" }],
      },
    ]);
    expect((await runCapacityRetry(event(), repository, request)).retried).toBe(
      false,
    );
    expect(calls.some(([, method]) => method === "POST")).toBe(false);
  });
  test.each([
    { annotations: [] },
    { annotations: [{ ...annotation, annotation_level: "notice" }] },
    {
      annotations: [
        {
          ...annotation,
          message:
            "Due to capacity constraints, jobs may experience longer queue times.",
        },
      ],
    },
    { annotations: [{ ...annotation, message: "Runner lost communication" }] },
  ])(
    "does not treat notices or unrelated runner failures as capacity proof %j",
    async ({ annotations }) => {
      const { request } = fixture(undefined, {
        "/repos/owner/repo/check-runs/21/annotations?per_page=100&page=1":
          annotations,
      });
      expect(
        (await runCapacityRetry(event(), repository, request)).retried,
      ).toBe(false);
    },
  );
  test("requires a capacity failure even when acceptance failed", async () => {
    const { request } = fixture([acceptance]);
    expect(
      (await runCapacityRetry(event(), repository, request)).reason,
    ).toContain("No hosted runner capacity failure");
  });
  test("does not trust an arbitrary acceptance-like name", async () => {
    const { request } = fixture([
      { ...acceptance, name: "Other CI acceptance" },
    ]);
    expect((await runCapacityRetry(event(), repository, request)).retried).toBe(
      false,
    );
  });
  test("paginates complete attempt jobs and annotations", async () => {
    const successful = Array.from({ length: 100 }, (_, index) => ({
      ...capacity,
      id: 100 + index,
      conclusion: "success",
    }));
    const notices = Array.from({ length: 100 }, () => ({
      ...annotation,
      annotation_level: "notice",
    }));
    const { request, calls } = fixture(undefined, {
      [`${endpoint}/attempts/1/jobs?per_page=100&page=1`]: {
        total_count: 102,
        jobs: successful,
      },
      [`${endpoint}/attempts/1/jobs?per_page=100&page=2`]: {
        total_count: 102,
        jobs: [capacity, acceptance],
      },
      "/repos/owner/repo/check-runs/21/annotations?per_page=100&page=1":
        notices,
      "/repos/owner/repo/check-runs/21/annotations?per_page=100&page=2": [
        annotation,
      ],
    });
    expect((await runCapacityRetry(event(), repository, request)).retried).toBe(
      true,
    );
    expect(calls.filter(([path]) => path.includes("page=2"))).toHaveLength(2);
  });
  test.each([
    { total_count: 3, jobs: [capacity] },
    { total_count: -1, jobs: [] },
    { total_count: 2, jobs: [capacity, capacity] },
    { total_count: 1, jobs: [{ ...capacity, status: "queued" }] },
    { total_count: 1, jobs: [{ ...capacity, steps: undefined }] },
    { total_count: 0, jobs: [capacity] },
  ])("fails closed on invalid or incomplete jobs %j", async (response) => {
    const { request } = fixture(undefined, {
      [`${endpoint}/attempts/1/jobs?per_page=100&page=1`]: response,
    });
    await expect(
      runCapacityRetry(event(), repository, request),
    ).rejects.toThrow();
  });
  test.each([null, {}, { ...annotation, message: 5 }])(
    "fails visibly on malformed annotations %j",
    async (response) => {
      const { request } = fixture(undefined, {
        "/repos/owner/repo/check-runs/21/annotations?per_page=100&page=1":
          response === null ? null : [response],
      });
      await expect(
        runCapacityRetry(event(), repository, request),
      ).rejects.toThrow();
    },
  );
  test.each([
    null,
    { action: "requested", repository: { full_name: repository } },
    { action: "completed", repository: { full_name: "attacker/repo" } },
    event({ run_attempt: 0 }),
    event({ head_sha: "invalid" }),
    event({ id: -1 }),
  ])("rejects malformed provenance %j", async (payload) => {
    const { request, calls } = fixture();
    await expect(
      runCapacityRetry(payload, repository, request),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  test("rejects attempt jobs that exceed the complete pagination budget", async () => {
    const api = fixture();
    const request: RetryRequest = async (path, method) => {
      if (!path.includes("/attempts/")) return api.request(path, method);
      const page = Number(
        new URL(path, "https://api.github.com").searchParams.get("page"),
      );
      return {
        total_count: 10001,
        jobs: Array.from({ length: 100 }, (_, index) => ({
          ...capacity,
          id: page * 100 + index,
          conclusion: "success",
        })),
      };
    };
    await expect(
      runCapacityRetry(event(), repository, request),
    ).rejects.toThrow("attempt jobs exceeded pagination limit");
    expect(api.calls.some(([, method]) => method === "POST")).toBe(false);
  });
  test("rejects annotations that exceed the complete pagination budget", async () => {
    const api = fixture();
    const request: RetryRequest = async (path, method) =>
      path.includes("/annotations?")
        ? Array.from({ length: 100 }, () => ({
            ...annotation,
            annotation_level: "notice",
          }))
        : api.request(path, method);
    await expect(
      runCapacityRetry(event(), repository, request),
    ).rejects.toThrow("annotations exceeded pagination limit");
    expect(api.calls.some(([, method]) => method === "POST")).toBe(false);
  });
  test("rejects repository endpoint injection", async () => {
    await expect(
      runCapacityRetry(event(), "../attacker/repo", fixture().request),
    ).rejects.toThrow("Invalid repository");
  });
  test("propagates API errors without requesting a retry", async () => {
    const request: RetryRequest = async () => {
      throw new Error("Forbidden");
    };
    await expect(
      runCapacityRetry(event(), repository, request),
    ).rejects.toThrow("Forbidden");
  });
});

describe("capacity retry transport and CLI", () => {
  test("uses the fixed API origin and token for GET and POST", async () => {
    const timeoutMock = spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (
      input,
      init,
    ) => {
      expect(String(input)).toBe(
        "https://api.github.com/repos/owner/repo/actions/runs/17",
      );
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer fixture-token",
      });
      return init?.method === "POST"
        ? new Response(null, { status: 201 })
        : Response.json(run);
    }) as typeof fetch);
    try {
      const request = capacityRetryRequest("fixture-token");
      expect(await request(endpoint)).toEqual(run);
      expect(await request(endpoint, "POST")).toBeUndefined();
    } finally {
      fetchMock.mockRestore();
      timeoutMock.mockRestore();
    }
  });
  test("reports API status without exposing token", async () => {
    const timeoutMock = spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("private", { status: 403 }),
    );
    try {
      await expect(capacityRetryRequest("secret")(endpoint)).rejects.toThrow(
        "HTTP 403",
      );
      await expect(
        capacityRetryRequest("secret")("https://attacker.invalid"),
      ).rejects.toThrow("Invalid GitHub endpoint");
      await expect(
        capacityRetryRequest("secret")("/repos/../secret"),
      ).rejects.toThrow("Invalid GitHub endpoint");
    } finally {
      fetchMock.mockRestore();
      timeoutMock.mockRestore();
    }
  });
  test("rejects malformed JSON from the actual event file reader before API access", async () => {
    await expect(
      runCapacityRetryCli({
        GITHUB_EVENT_PATH: import.meta.path,
        GITHUB_REPOSITORY: repository,
        GITHUB_TOKEN: "fixture-token",
      }),
    ).rejects.toThrow();
  });
  test("reads only event data and emits retry summary", async () => {
    const summary: string[] = [];
    const consoleMock = spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await runCapacityRetryCli(
        {
          GITHUB_EVENT_PATH: "/event.json",
          GITHUB_REPOSITORY: repository,
          GITHUB_TOKEN: "token",
          GITHUB_STEP_SUMMARY: "/summary",
        },
        async (path) => {
          expect(path).toBe("/event.json");
          return event();
        },
        (path, value) => {
          expect(path).toBe("/summary");
          summary.push(value);
        },
        (token) => {
          expect(token).toBe("token");
          return fixture().request;
        },
      );
      expect(result.retried).toBe(true);
      expect(summary.join("")).toContain(capacity.name);
      expect(consoleMock).toHaveBeenCalledTimes(1);
    } finally {
      consoleMock.mockRestore();
    }
  });
  test("allows absent summary and rejects missing CLI inputs", async () => {
    const consoleMock = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(
        (
          await runCapacityRetryCli(
            {
              GITHUB_EVENT_PATH: "/event.json",
              GITHUB_REPOSITORY: repository,
              GITHUB_TOKEN: "token",
            },
            async () => event({ conclusion: "success" }),
            () => {
              throw new Error("No summary expected");
            },
            () => fixture().request,
          )
        ).retried,
      ).toBe(false);
      await expect(runCapacityRetryCli({})).rejects.toThrow("required");
    } finally {
      consoleMock.mockRestore();
    }
  });
});

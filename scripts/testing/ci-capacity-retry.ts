import { appendFileSync } from "node:fs";

export type RetryRequest = (
  endpoint: string,
  method?: "GET" | "POST",
) => Promise<unknown>;

interface Run {
  id: number;
  name: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  head_sha: string;
  repository: { full_name: string };
}
interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: unknown[];
}
export interface CapacityRetryResult {
  retried: boolean;
  reason: string;
  capacityJobs: string[];
}
const maximumRetries = 3;
const capacityMessage =
  "The job was not acquired by Runner of type hosted even after multiple attempts";
const acceptanceName =
  /^(?:Full|Selected|No package) CI acceptance(?: \[PR \d+; base [a-f0-9]{40}; website (?:true|false)\])?$/;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid GitHub response object");
  return value as Record<string, unknown>;
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function parseRun(value: unknown): Run {
  const run = object(value);
  const repository = object(run.repository);
  if (
    !positiveInteger(run.id) ||
    !positiveInteger(run.run_attempt) ||
    typeof run.name !== "string" ||
    typeof run.path !== "string" ||
    typeof run.event !== "string" ||
    typeof run.status !== "string" ||
    (run.conclusion !== null && typeof run.conclusion !== "string") ||
    typeof run.head_sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(run.head_sha) ||
    typeof repository.full_name !== "string"
  )
    throw new Error("Invalid GitHub workflow run");
  return run as unknown as Run;
}
function eligibleRun(run: Run, repository: string): boolean {
  return (
    run.name === "CI" &&
    run.path === ".github/workflows/ci.yml" &&
    run.repository.full_name === repository &&
    ["pull_request", "push", "workflow_dispatch"].includes(run.event) &&
    run.status === "completed" &&
    ["failure", "cancelled"].includes(run.conclusion ?? "")
  );
}
function matchesRun(expected: Run, actual: Run): boolean {
  return (
    actual.id === expected.id &&
    actual.run_attempt === expected.run_attempt &&
    actual.head_sha === expected.head_sha &&
    actual.event === expected.event &&
    eligibleRun(actual, expected.repository.full_name)
  );
}
async function jobsForAttempt(
  endpoint: string,
  request: RetryRequest,
): Promise<Job[]> {
  const jobs: Job[] = [];
  const identifiers = new Set<number>();
  let expectedTotal: number | undefined;
  for (let page = 1; page <= 100; page++) {
    const response = object(
      await request(`${endpoint}?per_page=100&page=${page}`),
    );
    const total = response.total_count;
    if (
      !Number.isSafeInteger(total) ||
      (total as number) < 0 ||
      !Array.isArray(response.jobs) ||
      response.jobs.length > 100 ||
      (expectedTotal !== undefined && total !== expectedTotal)
    )
      throw new Error("Incomplete GitHub attempt jobs");
    expectedTotal = total as number;
    for (const value of response.jobs) {
      const job = object(value);
      if (
        !positiveInteger(job.id) ||
        identifiers.has(job.id) ||
        typeof job.name !== "string" ||
        job.status !== "completed" ||
        typeof job.conclusion !== "string" ||
        !Array.isArray(job.steps)
      )
        throw new Error("Invalid or duplicate GitHub attempt job");
      identifiers.add(job.id);
      jobs.push(job as unknown as Job);
    }
    if (jobs.length === expectedTotal) return jobs;
    if (response.jobs.length < 100 || jobs.length > expectedTotal)
      throw new Error("Incomplete GitHub attempt jobs");
  }
  throw new Error("GitHub attempt jobs exceeded pagination limit");
}
async function capacityFailure(
  endpoint: string,
  request: RetryRequest,
): Promise<boolean> {
  let capacity = false;
  for (let page = 1; page <= 100; page++) {
    const response = await request(`${endpoint}?per_page=100&page=${page}`);
    if (!Array.isArray(response) || response.length > 100)
      throw new Error("Invalid GitHub check annotations");
    for (const value of response) {
      const annotation = object(value);
      if (
        typeof annotation.annotation_level !== "string" ||
        typeof annotation.message !== "string"
      )
        throw new Error("Invalid GitHub check annotation");
      if (
        annotation.annotation_level === "failure" &&
        annotation.message.trim() === capacityMessage
      )
        capacity = true;
    }
    if (response.length < 100) return capacity;
  }
  throw new Error("GitHub annotations exceeded pagination limit");
}

export async function runCapacityRetry(
  event: unknown,
  repository: string,
  request: RetryRequest,
): Promise<CapacityRetryResult> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Invalid repository identity");
  const payload = object(event);
  if (
    payload.action !== "completed" ||
    object(payload.repository).full_name !== repository
  )
    throw new Error("Invalid workflow completion provenance");
  const run = parseRun(payload.workflow_run);
  const result = (
    reason: string,
    capacityJobs: string[] = [],
  ): CapacityRetryResult => ({
    retried: false,
    reason,
    capacityJobs,
  });
  if (!eligibleRun(run, repository))
    return result("Run does not require a CI capacity retry.");
  if (run.run_attempt > maximumRetries)
    return result(
      "Three capacity retries exhausted; manual investigation required.",
    );
  const runEndpoint = `/repos/${repository}/actions/runs/${run.id}`;
  if (!matchesRun(run, parseRun(await request(runEndpoint))))
    return result("Completion event is stale; no retry requested.");
  const jobs = await jobsForAttempt(
    `${runEndpoint}/attempts/${run.run_attempt}/jobs`,
    request,
  );
  const capacityJobs: string[] = [];
  for (const job of jobs) {
    if (["success", "skipped", "neutral"].includes(job.conclusion!)) continue;
    if (job.conclusion === "failure" && acceptanceName.test(job.name)) continue;
    if (
      !["failure", "cancelled", "abandoned"].includes(job.conclusion!) ||
      job.steps.length !== 0 ||
      !(await capacityFailure(
        `/repos/${repository}/check-runs/${job.id}/annotations`,
        request,
      ))
    )
      return result("A job failed without hosted runner capacity evidence.");
    capacityJobs.push(job.name);
  }
  if (!capacityJobs.length)
    return result("No hosted runner capacity failure found.");
  // API inspection can overlap a manual rerun. Recheck immediately before mutation.
  if (!matchesRun(run, parseRun(await request(runEndpoint))))
    return result(
      "Run changed during inspection; no retry requested.",
      capacityJobs,
    );
  await request(`${runEndpoint}/rerun-failed-jobs`, "POST");
  return {
    retried: true,
    reason: `Requested capacity retry ${run.run_attempt} of ${maximumRetries}; failed jobs and dependents will rerun.`,
    capacityJobs,
  };
}

export function capacityRetryRequest(token: string): RetryRequest {
  return async (endpoint, method = "GET") => {
    if (!endpoint.startsWith("/repos/") || endpoint.includes(".."))
      throw new Error("Invalid GitHub endpoint");
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(
        `GitHub capacity retry request failed with HTTP ${response.status}`,
      );
    return method === "POST" ? undefined : response.json();
  };
}

export async function runCapacityRetryCli(
  environment: Record<string, string | undefined>,
  read: (path: string) => Promise<unknown> = async (path) =>
    Bun.file(path).json(),
  append: (path: string, text: string) => void = appendFileSync,
  requestFactory: (token: string) => RetryRequest = capacityRetryRequest,
): Promise<CapacityRetryResult> {
  const eventPath = environment.GITHUB_EVENT_PATH;
  const repository = environment.GITHUB_REPOSITORY;
  const token = environment.GITHUB_TOKEN;
  if (!eventPath || !repository || !token)
    throw new Error("GitHub event path, repository, and token are required");
  const result = await runCapacityRetry(
    await read(eventPath),
    repository,
    requestFactory(token),
  );
  const summary = [
    result.reason,
    ...result.capacityJobs.map(
      (name) => `Capacity failure: ${name.replace(/[\r\n]/g, " ")}`,
    ),
    "",
  ].join("\n");
  if (environment.GITHUB_STEP_SUMMARY)
    append(environment.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  return result;
}

if (import.meta.main) await runCapacityRetryCli(process.env);

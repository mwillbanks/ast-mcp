function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed GitHub pull request");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Malformed GitHub pull request");
  return value;
}
function releasePullRequest(value: unknown): ReleasePullRequest {
  const pr = object(value);
  const base = object(pr.base);
  const head = object(pr.head);
  if (!Array.isArray(pr.labels))
    throw new Error("Malformed GitHub pull request");
  return {
    state: string(pr.state),
    base: { ref: string(base.ref) },
    head: {
      ref: string(head.ref),
      sha: string(head.sha),
      repo:
        head.repo === null
          ? null
          : { full_name: string(object(head.repo).full_name) },
    },
    labels: pr.labels.map((label) => ({ name: string(object(label).name) })),
  };
}
interface ReleasePullRequest {
  base: { ref: string };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  labels: Array<{ name: string }>;
  state: string;
}

export interface ReleaseCiApi {
  pullRequest(number: number): Promise<ReleasePullRequest>;
  dispatch(ref: string, sha: string): Promise<void>;
}

export async function dispatchReleaseCi(
  repository: string,
  output: string,
  api: ReleaseCiApi,
): Promise<string[]> {
  const prs: unknown = JSON.parse(output);
  if (!Array.isArray(prs))
    throw new Error("Release Please PR output must be an array");
  const dispatched: string[] = [];
  const seen = new Set<number>();
  for (const entry of prs) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("number" in entry) ||
      !Number.isSafeInteger(entry.number) ||
      Number(entry.number) <= 0
    )
      throw new Error("Release Please PR output has an invalid number");
    const number = Number(entry.number);
    if (seen.has(number)) continue;
    seen.add(number);
    const pr = await api.pullRequest(number);
    if (
      pr.state !== "open" ||
      pr.base.ref !== "main" ||
      pr.head.repo?.full_name !== repository ||
      !pr.head.ref.startsWith("release-please--") ||
      !pr.labels.some(({ name }) => name === "autorelease: pending") ||
      !/^[a-f0-9]{40}$/.test(pr.head.sha)
    )
      throw new Error(
        `Refusing CI dispatch for unexpected release PR ${number}`,
      );
    await api.dispatch(pr.head.ref, pr.head.sha);
    dispatched.push(pr.head.sha);
  }
  return dispatched;
}

export async function runReleaseCi(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token)
    throw new Error("GitHub repository and token are required");
  const origin = env.GITHUB_API_URL ?? "https://api.github.com";
  const request = async (suffix: string, body?: unknown) => {
    const response = await fetch(`${origin}/repos/${repository}/${suffix}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`GitHub request failed with status ${response.status}`);
    return response;
  };
  return dispatchReleaseCi(repository, env.RELEASE_PRS ?? "[]", {
    async pullRequest(number) {
      return releasePullRequest(
        await (await request(`pulls/${number}`)).json(),
      );
    },
    async dispatch(ref, sha) {
      await request("actions/workflows/ci.yml/dispatches", {
        ref,
        inputs: { expected_sha: sha },
      });
    },
  });
}

if (import.meta.main) {
  const shas = await runReleaseCi();
  console.log(`Dispatched CI for ${shas.length} release PR heads`);
}

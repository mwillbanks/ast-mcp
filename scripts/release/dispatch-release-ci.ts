import path from "node:path";

const maximumChangelogBytes = 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed GitHub response");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Malformed GitHub response");
  return value;
}
function commitOid(value: unknown): string {
  const oid = string(value);
  if (!/^[a-f0-9]{40}$/.test(oid))
    throw new Error("Malformed GitHub commit SHA");
  return oid;
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
  changelog(sha: string): Promise<string>;
  commitChangelog(
    ref: string,
    expectedSha: string,
    content: string,
  ): Promise<string>;
  dispatch(ref: string, sha: string): Promise<void>;
}

function validatePullRequest(
  repository: string,
  number: number,
  pr: ReleasePullRequest,
  expectedHead?: ReleasePullRequest["head"],
) {
  if (
    pr.state !== "open" ||
    pr.base.ref !== "main" ||
    pr.head.repo?.full_name !== repository ||
    !pr.head.ref.startsWith("release-please--") ||
    !pr.labels.some(({ name }) => name === "autorelease: pending") ||
    !/^[a-f0-9]{40}$/.test(pr.head.sha)
  )
    throw new Error(`Refusing CI dispatch for unexpected release PR ${number}`);
  if (
    expectedHead &&
    (pr.head.ref !== expectedHead.ref || pr.head.sha !== expectedHead.sha)
  )
    throw new Error(`Release PR ${number} head changed during normalization`);
}

/** Use only the installed formatter and configuration from this trusted checkout. */
export async function formatReleaseChangelog(content: string): Promise<string> {
  const root = path.resolve(import.meta.dir, "../..");
  const executable = path.join(
    path.dirname(Bun.resolveSync("oxfmt/package.json", root)),
    "bin/oxfmt",
  );
  const child = Bun.spawn(
    [
      process.execPath,
      executable,
      "--stdin-filepath=CHANGELOG.md",
      `--config=${path.join(root, ".oxfmtrc.json")}`,
      "--disable-nested-config",
    ],
    {
      cwd: root,
      stdin: Buffer.from(content),
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(30_000),
    },
  );
  const [status, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error("Oxfmt changelog formatting failed");
  return stdout;
}

export async function dispatchReleaseCi(
  repository: string,
  output: string,
  api: ReleaseCiApi,
  format: (content: string) => Promise<string> = formatReleaseChangelog,
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
    validatePullRequest(repository, number, pr);
    const original = await api.changelog(pr.head.sha);
    const formatted = await format(original);
    // Oxfmt cannot combine --check and stdin. A second pass verifies canonical bytes.
    if (!formatted || (await format(formatted)) !== formatted)
      throw new Error(
        "Formatted release changelog failed its formatting check",
      );
    const current = await api.pullRequest(number);
    validatePullRequest(repository, number, current, pr.head);
    let expectedHead = pr.head;
    if (formatted !== original) {
      const sha = commitOid(
        await api.commitChangelog(pr.head.ref, pr.head.sha, formatted),
      );
      expectedHead = { ...pr.head, sha };
      const normalized = await api.pullRequest(number);
      validatePullRequest(repository, number, normalized, expectedHead);
    }
    await api.dispatch(expectedHead.ref, expectedHead.sha);
    dispatched.push(expectedHead.sha);
  }
  return dispatched;
}

function changelogContents(value: unknown): string {
  const file = object(value);
  if (
    file.type !== "file" ||
    file.path !== "CHANGELOG.md" ||
    file.encoding !== "base64" ||
    !Number.isSafeInteger(file.size) ||
    Number(file.size) < 0 ||
    Number(file.size) > maximumChangelogBytes
  )
    throw new Error("Invalid release changelog metadata");
  const encoded = string(file.content).replaceAll("\n", "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.byteLength !== file.size)
    throw new Error("Invalid release changelog encoding");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function runReleaseCi(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token)
    throw new Error("GitHub repository and token are required");
  const origin = env.GITHUB_API_URL ?? "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const request = async (url: string, body?: unknown) => {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`GitHub request failed with status ${response.status}`);
    return response;
  };
  const rest = (suffix: string, body?: unknown) =>
    request(`${origin}/repos/${repository}/${suffix}`, body);
  return dispatchReleaseCi(repository, env.RELEASE_PRS ?? "[]", {
    async pullRequest(number) {
      return releasePullRequest(await (await rest(`pulls/${number}`)).json());
    },
    async changelog(sha) {
      return changelogContents(
        await (await rest(`contents/CHANGELOG.md?ref=${sha}`)).json(),
      );
    },
    async commitChangelog(ref, expectedSha, content) {
      const response = object(
        await (
          await request(env.GITHUB_GRAPHQL_URL ?? `${origin}/graphql`, {
            query: `mutation($input: CreateCommitOnBranchInput!) {
              createCommitOnBranch(input: $input) { commit { oid } }
            }`,
            variables: {
              input: {
                branch: {
                  repositoryNameWithOwner: repository,
                  branchName: ref,
                },
                expectedHeadOid: expectedSha,
                message: { headline: "style: format generated changelog" },
                fileChanges: {
                  additions: [
                    {
                      path: "CHANGELOG.md",
                      contents: Buffer.from(content).toString("base64"),
                    },
                  ],
                },
              },
            },
          })
        ).json(),
      );
      if (response.errors !== undefined)
        throw new Error("GitHub changelog commit was rejected");
      const data = object(response.data);
      const mutation = object(data.createCommitOnBranch);
      return commitOid(object(mutation.commit).oid);
    },
    async dispatch(ref, sha) {
      await rest("actions/workflows/ci.yml/dispatches", {
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

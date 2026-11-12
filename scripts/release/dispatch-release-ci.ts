import path from "node:path";

import {
  isReleaseInput,
  prepareReleaseContent,
  type ReleaseFileChanges,
} from "./prepare-release-content.ts";

const maximumReleaseInputBytes = 1024 * 1024;
const maximumReleaseInputs = 1_000;
const releaseReadConcurrency = 8;
const headVisibilityRetries = 20;
const headVisibilityDelayMs = 250;

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
  releaseFiles(sha: string): Promise<ReadonlyMap<string, string>>;
  commitReleaseFiles(
    ref: string,
    expectedSha: string,
    changes: ReleaseFileChanges,
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
  const child = Bun.spawn(
    [
      process.execPath,
      "fmt",
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
  if (status !== 0) throw new Error("Bun changelog formatting failed");
  return stdout;
}

export async function dispatchReleaseCi(
  repository: string,
  output: string,
  api: ReleaseCiApi,
  format: (content: string) => Promise<string> = formatReleaseChangelog,
  delay: (milliseconds: number) => Promise<void> = Bun.sleep,
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
    const files = await api.releaseFiles(pr.head.sha);
    const changes = await prepareReleaseContent(files, format);
    const current = await api.pullRequest(number);
    validatePullRequest(repository, number, current, pr.head);
    let expectedHead = pr.head;
    if (changes.additions.size > 0 || changes.deletions.length > 0) {
      const sha = commitOid(
        await api.commitReleaseFiles(pr.head.ref, pr.head.sha, changes),
      );
      expectedHead = { ...pr.head, sha };
      let normalized = await api.pullRequest(number);
      // GitHub can return the previous PR head briefly after committing.
      for (
        let attempt = 0;
        attempt < headVisibilityRetries && normalized.head.sha === pr.head.sha;
        attempt++
      ) {
        validatePullRequest(repository, number, normalized, pr.head);
        await delay(headVisibilityDelayMs);
        normalized = await api.pullRequest(number);
      }
      validatePullRequest(repository, number, normalized, expectedHead);
    }
    await api.dispatch(expectedHead.ref, expectedHead.sha);
    dispatched.push(expectedHead.sha);
  }
  return dispatched;
}

function releaseInputContents(value: unknown, path: string): string {
  const file = object(value);
  if (
    file.type !== "file" ||
    file.path !== path ||
    file.encoding !== "base64" ||
    !Number.isSafeInteger(file.size) ||
    Number(file.size) < 0 ||
    Number(file.size) > maximumReleaseInputBytes
  )
    throw new Error("Invalid release input metadata: " + path);
  const encoded = string(file.content).replaceAll("\n", "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.byteLength !== file.size)
    throw new Error("Invalid release input encoding: " + path);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function releaseInputPaths(value: unknown): string[] {
  const response = object(value);
  if (response.truncated !== false || !Array.isArray(response.tree))
    throw new Error("Release tree is incomplete");
  const paths = new Set<string>();
  for (const entry of response.tree) {
    const file = object(entry);
    const path = string(file.path);
    if (!isReleaseInput(path)) continue;
    if (
      file.type !== "blob" ||
      file.mode !== "100644" ||
      !Number.isSafeInteger(file.size) ||
      Number(file.size) < 0 ||
      Number(file.size) > maximumReleaseInputBytes ||
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..") ||
      paths.has(path)
    )
      throw new Error("Invalid release tree entry: " + path);
    paths.add(path);
    if (paths.size > maximumReleaseInputs)
      throw new Error("Too many release inputs");
  }
  return [...paths].sort();
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
    async releaseFiles(sha) {
      const paths = releaseInputPaths(
        await (await rest(`git/trees/${sha}?recursive=1`)).json(),
      );
      const files = new Map<string, string>();
      for (
        let start = 0;
        start < paths.length;
        start += releaseReadConcurrency
      ) {
        const batch = paths.slice(start, start + releaseReadConcurrency);
        const results = await Promise.all(
          batch.map(async (path) => {
            const encoded = path.split("/").map(encodeURIComponent).join("/");
            const response = await rest(`contents/${encoded}?ref=${sha}`);
            return [
              path,
              releaseInputContents(await response.json(), path),
            ] as const;
          }),
        );
        for (const [path, content] of results) files.set(path, content);
      }
      return files;
    },
    async commitReleaseFiles(ref, expectedSha, changes) {
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
                message: { headline: "docs: stamp authored release content" },
                fileChanges: {
                  additions: Array.from(
                    changes.additions,
                    ([path, content]) => ({
                      path,
                      contents: Buffer.from(content).toString("base64"),
                    }),
                  ),
                  deletions: changes.deletions.map((path) => ({ path })),
                },
              },
            },
          })
        ).json(),
      );
      if (response.errors !== undefined)
        throw new Error("GitHub release content commit was rejected");
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

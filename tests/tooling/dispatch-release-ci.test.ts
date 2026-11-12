import { describe, expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  dispatchReleaseCi,
  formatReleaseChangelog,
  runReleaseCi,
} from "../../scripts/release/dispatch-release-ci";
import {
  releaseChangelog,
  releaseDraft,
  releaseManifest,
  releasePage,
  prepareReleaseContent,
} from "../../scripts/release/prepare-release-content.ts";
import {
  releaseNotesCommand,
  renderReleaseNotes,
} from "../../scripts/release/render-release-notes.ts";

const repository = "mwillbanks/ast-mcp";
const version = "0.9.0";
const page = releasePage(version);
const authoredNotes = "---\ntitle: NEXT_RELEASE\n---\n\nRelease notes.\n";
const versionedNotes = authoredNotes.replace("NEXT_RELEASE", version);
const draftChangelog = "# Changelog\n\n## NEXT_RELEASE\n\n- entry\n";
const readme = "README.md";
const draftReadme = "# AST-MCP\n\nAvailable since NEXT_RELEASE.\n";
const versionedReadme = draftReadme.replace("NEXT_RELEASE", version);
const sha = "a".repeat(40);
const normalizedSha = "b".repeat(40);
const formatted = draftChangelog.replace("NEXT_RELEASE", version);
const unformatted = "# Changelog\n\n## 0.9.0\n\n\n* entry\n";
type Api = Parameters<typeof dispatchReleaseCi>[2];
function releasePr(headSha = sha) {
  return {
    state: "open",
    base: { ref: "main" },
    head: {
      ref: "release-please--branches--main",
      sha: headSha,
      repo: { full_name: repository },
    },
    labels: [{ name: "autorelease: pending" }],
  };
}
function harness(pr = releasePr(), initial = formatted) {
  const reads: number[] = [];
  const contents: string[] = [];
  const commits: [string, string, string][] = [];
  const dispatches: [string, string][] = [];
  const waits: number[] = [];
  let content = initial;
  const api: Api = {
    pullRequest: async (number) => {
      reads.push(number);
      return structuredClone(pr);
    },
    releaseFiles: async (commit) => {
      contents.push(commit);
      return new Map([
        [releaseChangelog, content],
        [releaseManifest, JSON.stringify({ ".": version })],
        [page, versionedNotes],
      ]);
    },
    commitReleaseFiles: async (ref, expected, changes) => {
      const next = changes.additions.get(releaseChangelog)!;
      commits.push([ref, expected, next]);
      expect(pr.head.sha).toBe(expected);
      pr.head.sha = normalizedSha;
      content = next;
      return normalizedSha;
    },
    dispatch: async (ref, commit) => {
      dispatches.push([ref, commit]);
    },
  };
  const run = (
    output = '[{"number":24}]',
    format = async (value: string) => value,
  ) =>
    dispatchReleaseCi(repository, output, api, format, async (milliseconds) => {
      waits.push(milliseconds);
    });
  return { api, reads, contents, commits, dispatches, waits, run, pr };
}
describe("release PR normalization and dispatch", () => {
  test("checks unchanged canonical bytes and targets current heads once per PR", async () => {
    const h = harness();
    expect(await h.run('[{"number":24},{"number":24},{"number":27}]')).toEqual([
      sha,
      sha,
    ]);
    expect(h.reads).toEqual([24, 24, 27, 27]);
    expect(h.contents).toEqual([sha, sha]);
    expect(h.commits).toEqual([]);
    expect(h.dispatches).toEqual([
      ["release-please--branches--main", sha],
      ["release-please--branches--main", sha],
    ]);
  });
  test("formats and checks before committing only changed bytes, then rereads the committed head", async () => {
    const h = harness(releasePr(), unformatted);
    const inputs: string[] = [];
    const format = async (value: string) => {
      inputs.push(value);
      expect(h.commits).toEqual([]);
      return formatted;
    };
    expect(await h.run(undefined, format)).toEqual([normalizedSha]);
    expect(inputs).toEqual([unformatted, formatted]);
    expect(h.commits).toEqual([
      ["release-please--branches--main", sha, formatted],
    ]);
    expect(h.reads).toEqual([24, 24, 24]);
    expect(h.dispatches).toEqual([
      ["release-please--branches--main", normalizedSha],
    ]);
    expect(await h.run()).toEqual([normalizedSha]);
    expect(h.commits).toHaveLength(1);
  });
  test("waits for the normalized head to become visible", async () => {
    const h = harness(releasePr(), unformatted);
    const read = h.api.pullRequest;
    let staleReads = 2;
    h.api.pullRequest = async (number) => {
      const pr = await read(number);
      if (h.commits.length > 0 && staleReads-- > 0) pr.head.sha = sha;
      return pr;
    };
    expect(await h.run(undefined, async () => formatted)).toEqual([
      normalizedSha,
    ]);
    expect(h.waits).toEqual([250, 250]);
    expect(h.dispatches).toEqual([
      ["release-please--branches--main", normalizedSha],
    ]);
  });
  test("rejects a normalized head that never becomes visible", async () => {
    const h = harness(releasePr(), unformatted);
    const read = h.api.pullRequest;
    h.api.pullRequest = async (number) => {
      const pr = await read(number);
      if (h.commits.length > 0) pr.head.sha = sha;
      return pr;
    };
    await expect(h.run(undefined, async () => formatted)).rejects.toThrow(
      "head changed",
    );
    expect(h.waits).toHaveLength(20);
    expect(h.dispatches).toEqual([]);
  });
  test("handles empty output", async () => {
    const h = harness();
    expect(await h.run("[]")).toEqual([]);
    expect(h.reads).toEqual([]);
  });
  test.each([
    "{",
    "null",
    "{}",
    "1",
    '"release"',
    "[null]",
    "[{}]",
    '[{"number":"24"}]',
    '[{"number":0}]',
    '[{"number":-1}]',
    '[{"number":1.5}]',
    '[{"number":9007199254740992}]',
  ])("rejects malformed output %s", async (output) => {
    const h = harness();
    await expect(h.run(output)).rejects.toThrow();
    expect(h.dispatches).toEqual([]);
    expect(h.commits).toEqual([]);
  });
  const changes: Array<[string, (pr: ReturnType<typeof releasePr>) => void]> = [
    [
      "closed PR",
      (pr) => {
        pr.state = "closed";
      },
    ],
    [
      "different base",
      (pr) => {
        pr.base.ref = "develop";
      },
    ],
    [
      "fork",
      (pr) => {
        pr.head.repo.full_name = "attacker/ast-mcp";
      },
    ],
    [
      "ordinary branch",
      (pr) => {
        pr.head.ref = "chore/dependencies";
      },
    ],
    [
      "missing pending label",
      (pr) => {
        pr.labels = [];
      },
    ],
    [
      "short SHA",
      (pr) => {
        pr.head.sha = "abc123";
      },
    ],
    [
      "nonhex SHA",
      (pr) => {
        pr.head.sha = "z".repeat(40);
      },
    ],
  ];
  test.each(changes)(
    "rejects %s before fetching or committing",
    async (_name, change) => {
      const pr = releasePr();
      change(pr);
      const h = harness(pr);
      await expect(h.run()).rejects.toThrow("unexpected release PR");
      expect(h.contents).toEqual([]);
      expect(h.commits).toEqual([]);
      expect(h.dispatches).toEqual([]);
    },
  );
  test.each(["lookup", "changelog", "commit", "dispatch"])(
    "propagates %s failures without later operations",
    async (operation) => {
      const h = harness(releasePr(), unformatted);
      const failure = async () => {
        throw new Error("operation unavailable");
      };
      if (operation === "lookup") h.api.pullRequest = failure;
      if (operation === "changelog") h.api.releaseFiles = failure;
      if (operation === "commit") h.api.commitReleaseFiles = failure;
      if (operation === "dispatch") h.api.dispatch = failure;
      await expect(h.run(undefined, async () => formatted)).rejects.toThrow(
        "operation unavailable",
      );
      expect(h.dispatches).toEqual([]);
      if (operation !== "dispatch") expect(h.commits).toEqual([]);
    },
  );
  test.each(["format", "check", "empty", "unstable"])(
    "does not commit or dispatch after %s failure",
    async (failure) => {
      const h = harness(releasePr(), unformatted);
      let calls = 0;
      await expect(
        h.run(undefined, async () => {
          calls++;
          if (failure === "format" || (failure === "check" && calls === 2))
            throw new Error("formatter failed");
          if (failure === "empty") return "";
          return failure === "unstable" && calls === 2 ? "unstable" : formatted;
        }),
      ).rejects.toThrow();
      expect(h.commits).toEqual([]);
      expect(h.dispatches).toEqual([]);
    },
  );
  test.each(["sha", "ref", "label"])(
    "rejects changed %s before committing",
    async (field) => {
      const h = harness(releasePr(), unformatted);
      const read = h.api.pullRequest;
      h.api.pullRequest = async (number) => {
        const pr = await read(number);
        if (h.reads.length > 1) {
          if (field === "sha") pr.head.sha = normalizedSha;
          if (field === "ref") pr.head.ref += "-changed";
          if (field === "label") pr.labels = [];
        }
        return pr;
      };
      await expect(h.run(undefined, async () => formatted)).rejects.toThrow();
      expect(h.commits).toEqual([]);
      expect(h.dispatches).toEqual([]);
    },
  );
  test("rejects branch movement after the normalization commit", async () => {
    const h = harness(releasePr(), unformatted);
    const commit = h.api.commitReleaseFiles;
    h.api.commitReleaseFiles = async (...args) => {
      const result = await commit(...args);
      h.pr.head.sha = "c".repeat(40);
      return result;
    };
    await expect(h.run(undefined, async () => formatted)).rejects.toThrow(
      "head changed",
    );
    expect(h.dispatches).toEqual([]);
  });
  test.each(["invalid", ""])(
    "rejects malformed resulting commit %j",
    async (oid) => {
      const h = harness(releasePr(), unformatted);
      h.api.commitReleaseFiles = async () => oid;
      await expect(h.run(undefined, async () => formatted)).rejects.toThrow(
        "commit SHA",
      );
      expect(h.dispatches).toEqual([]);
    },
  );
});

function fileContent(content = formatted, path = releaseChangelog) {
  return {
    type: "file",
    path,
    encoding: "base64",
    size: Buffer.byteLength(content),
    content: Buffer.from(content).toString("base64"),
  };
}
type RequestRecord = {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
};
function apiServer(
  options: {
    pr?: unknown;
    status?: number;
    content?: unknown;
    graphql?: unknown;
    fail?: string;
    initial?: string;
    commitHead?: string;
    draft?: boolean;
    tree?: unknown;
  } = {},
) {
  let head = sha;
  const files = new Map([
    [
      releaseChangelog,
      options.initial ?? (options.draft ? draftChangelog : formatted),
    ],
    [releaseManifest, JSON.stringify({ ".": version })],
    options.draft ? [releaseDraft, authoredNotes] : [page, versionedNotes],
  ]);
  if (options.draft) files.set(readme, draftReadme);
  const requests: RequestRecord[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body: unknown =
        request.method === "POST" ? await request.json() : null;
      requests.push({
        method: request.method,
        path: url.pathname + url.search,
        authorization: request.headers.get("authorization"),
        body,
      });
      if (options.fail && url.pathname.endsWith(options.fail))
        return new Response(null, { status: 503 });
      if (url.pathname.endsWith("/pulls/24"))
        return Response.json(
          options.pr === undefined ? releasePr(head) : options.pr,
          { status: options.status ?? 200 },
        );
      if (url.pathname.includes("/git/trees/")) {
        expect(url.pathname.endsWith("/" + head)).toBe(true);
        expect(url.searchParams.get("recursive")).toBe("1");
        return Response.json(
          "tree" in options
            ? options.tree
            : {
                truncated: false,
                tree: [...files].map(([path, content]) => ({
                  path,
                  type: "blob",
                  mode: "100644",
                  size: Buffer.byteLength(content),
                })),
              },
        );
      }
      if (url.pathname.includes("/contents/")) {
        expect(url.searchParams.get("ref")).toBe(head);
        const path = decodeURIComponent(url.pathname.split("/contents/")[1]!);
        const content = files.get(path);
        if (content === undefined) return new Response(null, { status: 404 });
        return Response.json(
          path === releaseChangelog && "content" in options
            ? options.content
            : fileContent(content, path),
        );
      }
      if (url.pathname === "/graphql") {
        const input = (
          body as {
            variables: {
              input: {
                expectedHeadOid: string;
                fileChanges: {
                  additions: Array<{ path: string; contents: string }>;
                  deletions: Array<{ path: string }>;
                };
              };
            };
          }
        ).variables.input;
        expect(input.expectedHeadOid).toBe(head);
        for (const { path, contents } of input.fileChanges.additions)
          files.set(path, Buffer.from(contents, "base64").toString("utf8"));
        for (const { path } of input.fileChanges.deletions) files.delete(path);
        head = options.commitHead ?? normalizedSha;
        return Response.json(
          options.graphql ?? {
            data: { createCommitOnBranch: { commit: { oid: normalizedSha } } },
          },
        );
      }
      return new Response(null, { status: 204 });
    },
  });
  const env = {
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORY: repository,
    GITHUB_API_URL: server.url.origin,
    GITHUB_GRAPHQL_URL: new URL("/graphql", server.url).href,
    RELEASE_PRS: '[{"number":24}]',
  };
  return { server, requests, env, files };
}
describe("release normalization GitHub adapter", () => {
  test("requires valid repository credentials", async () => {
    await expect(runReleaseCi({})).rejects.toThrow("required");
  });
  test.each([
    ["null", null, 200],
    ["array", [], 200],
    ["invalid state", { ...releasePr(), state: 1 }, 200],
    ["invalid labels", { ...releasePr(), labels: null }, 200],
    [
      "deleted head repository",
      { ...releasePr(), head: { ...releasePr().head, repo: null } },
      200,
    ],
    ["HTTP failure", releasePr(), 503],
  ])("validates %s before normalization", async (_name, pr, status) => {
    const h = apiServer({ pr, status });
    try {
      await expect(runReleaseCi(h.env)).rejects.toThrow();
      expect(h.requests).toHaveLength(1);
    } finally {
      h.server.stop(true);
    }
  });
  test("unchanged content dispatches without a commit", async () => {
    const h = apiServer();
    try {
      expect(await runReleaseCi(h.env)).toEqual([sha]);
      expect(h.requests.map((r) => r.method)).toEqual([
        "GET",
        "GET",
        "GET",
        "GET",
        "GET",
        "GET",
        "POST",
      ]);
      expect(h.requests.at(-1)?.body).toEqual({
        ref: "release-please--branches--main",
        inputs: { expected_sha: sha },
      });
    } finally {
      h.server.stop(true);
    }
  });
  test("stamps and moves authored release content in one expected-head commit", async () => {
    const h = apiServer({ draft: true });
    try {
      const env = { ...h.env };
      delete (env as Partial<typeof env>).GITHUB_GRAPHQL_URL;
      expect(await runReleaseCi(env)).toEqual([normalizedSha]);
      const commit = h.requests.find((r) => r.path === "/graphql")!;
      expect(commit.method).toBe("POST");
      expect(commit.authorization).toBe("Bearer test-token");
      const body = commit.body as {
        query: string;
        variables: { input: unknown };
      };
      expect(body.query).toContain("createCommitOnBranch");
      expect(body.variables.input).toEqual({
        branch: {
          repositoryNameWithOwner: repository,
          branchName: "release-please--branches--main",
        },
        expectedHeadOid: sha,
        message: { headline: "docs: stamp authored release content" },
        fileChanges: {
          additions: [
            {
              path: page,
              contents: Buffer.from(versionedNotes).toString("base64"),
            },
            {
              path: readme,
              contents: Buffer.from(versionedReadme).toString("base64"),
            },
            {
              path: releaseChangelog,
              contents: Buffer.from(formatted).toString("base64"),
            },
          ],
          deletions: [{ path: releaseDraft }],
        },
      });
      expect(h.requests.at(-1)?.body).toEqual({
        ref: "release-please--branches--main",
        inputs: { expected_sha: normalizedSha },
      });
      expect(
        h.requests.filter((r) => r.path.endsWith("/pulls/24")),
      ).toHaveLength(3);
      expect(h.files.has(releaseDraft)).toBe(false);
      expect(h.files.get(page)).toBe(versionedNotes);
      expect(h.files.get(readme)).toBe(versionedReadme);
      expect(await runReleaseCi(env)).toEqual([normalizedSha]);
      expect(h.requests.filter((r) => r.path === "/graphql")).toHaveLength(1);
    } finally {
      h.server.stop(true);
    }
  });
  test.each([
    null,
    { truncated: true, tree: [] },
    {
      truncated: false,
      tree: [
        { path: releaseChangelog, type: "blob", mode: "120000", size: 12 },
      ],
    },
  ])("rejects invalid release tree %j", async (tree) => {
    const h = apiServer({ tree });
    try {
      await expect(runReleaseCi(h.env)).rejects.toThrow();
      expect(h.requests.map((r) => r.method)).toEqual(["GET", "GET"]);
    } finally {
      h.server.stop(true);
    }
  });
  test.each(
    [
      null,
      [],
      { ...fileContent(), type: "symlink" },
      { ...fileContent(), path: "other.md" },
      { ...fileContent(), encoding: "none" },
      { ...fileContent(), size: -1 },
      { ...fileContent(), size: 2 * 1024 * 1024 },
      { ...fileContent(), size: 0.5 },
      { ...fileContent(), content: 1 },
      { ...fileContent(), content: "!notbase64" },
      { ...fileContent(), size: 1 },
      {
        ...fileContent(),
        size: 1,
        content: Buffer.from([255]).toString("base64"),
      },
    ].map((content) => ({ content })),
  )("rejects invalid changelog response %j", async ({ content }) => {
    const h = apiServer({ content });
    try {
      await expect(runReleaseCi(h.env)).rejects.toThrow();
      expect(h.requests.every((r) => r.method === "GET")).toBe(true);
    } finally {
      h.server.stop(true);
    }
  });
  test.each([
    { errors: [{ message: "expectedHeadOid did not match; test-token" }] },
    { data: null },
    { data: { createCommitOnBranch: { commit: { oid: "bad" } } } },
  ])("rejects malformed or failed atomic commit %j", async (graphql) => {
    const h = apiServer({ initial: unformatted, graphql });
    try {
      await expect(runReleaseCi(h.env)).rejects.toThrow();
      expect(h.requests.some((r) => r.path.endsWith("/dispatches"))).toBe(
        false,
      );
    } finally {
      h.server.stop(true);
    }
  });
  test.each(["CHANGELOG.md", "graphql", "dispatches"])(
    "propagates API failure at %s",
    async (fail) => {
      const h = apiServer({ initial: unformatted, fail });
      try {
        await expect(runReleaseCi(h.env)).rejects.toThrow("503");
        if (fail !== "dispatches")
          expect(h.requests.some((r) => r.path.endsWith("/dispatches"))).toBe(
            false,
          );
      } finally {
        h.server.stop(true);
      }
    },
  );
  test("does not dispatch a concurrently changed normalized head", async () => {
    const h = apiServer({ initial: unformatted, commitHead: "c".repeat(40) });
    try {
      await expect(runReleaseCi(h.env)).rejects.toThrow("head changed");
      expect(h.requests.some((r) => r.path.endsWith("/dispatches"))).toBe(
        false,
      );
    } finally {
      h.server.stop(true);
    }
  });
});
describe("installed changelog formatter", () => {
  test("normalizes the authored changelog and is idempotent", async () => {
    expect(await formatReleaseChangelog(unformatted)).toBe(formatted);
    expect(await formatReleaseChangelog(formatted)).toBe(formatted);
  });
  test("fails closed when the installed formatter rejects input", async () => {
    const spawn = Bun.spawn;
    const failure = spyOn(Bun, "spawn").mockImplementation((() =>
      spawn([process.execPath, "-e", "process.exit(2)"], {
        stdout: "pipe",
        stderr: "pipe",
      })) as typeof Bun.spawn);
    try {
      await expect(formatReleaseChangelog(unformatted)).rejects.toThrow(
        "Bun changelog formatting failed",
      );
    } finally {
      failure.mockRestore();
    }
  });
});
async function runCli(env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL(
          "../../scripts/release/dispatch-release-ci.ts",
          import.meta.url,
        ),
      ),
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}
describe("release dispatch CLI", () => {
  test.each([
    {},
    { GITHUB_REPOSITORY: repository },
    {
      GITHUB_TOKEN: "test-token",
      GITHUB_REPOSITORY: "invalid/repository/path",
    },
  ])("rejects invalid credentials %j", async (env) => {
    const result = await runCli(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("test-token");
  });
  test.each([200, 503])(
    "uses GitHub contracts and handles HTTP %s",
    async (status) => {
      const h = apiServer({ status });
      try {
        const result = await runCli(h.env);
        expect(h.requests[0]).toEqual({
          method: "GET",
          path: `/repos/${repository}/pulls/24`,
          authorization: "Bearer test-token",
          body: null,
        });
        if (status === 200) {
          expect(result.status).toBe(0);
          expect(result.stdout).toContain(
            "Dispatched CI for 1 release PR heads",
          );
          expect(h.requests.at(-1)?.body).toEqual({
            ref: "release-please--branches--main",
            inputs: { expected_sha: sha },
          });
        } else {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("503");
          expect(h.requests).toHaveLength(1);
        }
        expect(result.stderr).not.toContain("test-token");
      } finally {
        h.server.stop(true);
      }
    },
  );
});

describe("authored release content", () => {
  const historicalPage = releasePage("0.8.0");
  const historicalNotes = "---\ntitle: 0.8.0\n---\n\nHistorical notes.\n";
  const history = "## 0.8.0\n\n- Historical entry.\n";
  const repoDoc = "docs/ci.md";
  const siteDoc = "website/content/docs/reference/configuration.mdx";
  function files() {
    return new Map([
      [releaseManifest, JSON.stringify({ ".": version })],
      [releaseChangelog, draftChangelog + "\n" + history],
      [releaseDraft, authoredNotes],
      [readme, draftReadme],
      [repoDoc, "Available since NEXT_RELEASE.\n"],
      [siteDoc, "Deprecated since NEXT_RELEASE. Removed since NEXT_RELEASE.\n"],
      [historicalPage, historicalNotes],
    ]);
  }
  const identity = async (value: string) => value;

  test("stamps the README and both docs trees while preserving historical release bytes", async () => {
    const source = files();
    const changes = await prepareReleaseContent(source, identity);
    expect(changes.additions).toEqual(
      new Map([
        [page, versionedNotes],
        [readme, versionedReadme],
        [repoDoc, "Available since 0.9.0.\n"],
        [siteDoc, "Deprecated since 0.9.0. Removed since 0.9.0.\n"],
        [releaseChangelog, formatted + "\n" + history],
      ]),
    );
    expect(changes.deletions).toEqual([releaseDraft]);
    for (const path of changes.deletions) source.delete(path);
    for (const [path, content] of changes.additions) source.set(path, content);
    expect(source.get(historicalPage)).toBe(historicalNotes);
    expect(await prepareReleaseContent(source, identity)).toEqual({
      additions: new Map(),
      deletions: [],
    });
  });

  test.each([
    [page, versionedNotes, "already exists"],
    [releaseManifest, '{".":"../0.9.0"}', "Invalid AST-MCP release version"],
    [releaseManifest, "null", "Invalid release manifest"],
    [releaseManifest, "{}", "Invalid release manifest"],
    [
      releaseChangelog,
      "# Changelog\n\n- Missing heading.\n",
      "The first changelog section",
    ],
    [releaseChangelog, formatted, "The first changelog section"],
    [releaseDraft, historicalNotes, "title must match"],
    [
      historicalPage,
      "Historical NEXT_RELEASE.",
      "Unresolved release placeholder",
    ],
    [
      repoDoc,
      "Incorrectly suffixed NEXT_RELEASE_OLD.",
      "Unresolved release placeholder",
    ],
    [
      releaseChangelog,
      draftChangelog + "\n" + history + "NEXT_RELEASE\n",
      "historical changelog section",
    ],
  ])("rejects invalid release content in %s", async (path, content, error) => {
    const source = files();
    source.set(path, content);
    await expect(prepareReleaseContent(source, identity)).rejects.toThrow(
      error,
    );
  });

  test("rejects formatting that changes an earlier changelog section", async () => {
    await expect(
      prepareReleaseContent(files(), async (value) =>
        value.replace("Historical entry.", "Different entry."),
      ),
    ).rejects.toThrow("historical changelog entries");
  });

  test.each([false, true])(
    "rejects a partially stamped branch, page present: %s",
    async (hasPage) => {
      const source = files();
      source.delete(releaseDraft);
      if (hasPage) source.set(page, versionedNotes);
      else source.set(releaseChangelog, formatted);
      await expect(prepareReleaseContent(source, identity)).rejects.toThrow(
        "Missing authored release draft or changelog",
      );
    },
  );

  test("rejects unresolved placeholders on a previously stamped branch", async () => {
    const source = files();
    source.delete(releaseDraft);
    source.set(page, versionedNotes);
    source.set(releaseChangelog, formatted);
    await expect(prepareReleaseContent(source, identity)).rejects.toThrow(
      "Unresolved release placeholder",
    );
  });
});

describe("GitHub release notes renderer", () => {
  const delimiter = String.fromCharCode(96).repeat(3);
  test("keeps prose, links, tables and ordinary code while linking diagrams to the website", () => {
    const notes =
      '---\ntitle: "AST-MCP 0.9.0"\n---\n\n' +
      "See [configuration](/docs/reference/configuration/#index) or [npm](https://npmjs.com/).\n\n" +
      "| Workload | p95 |\n| --- | ---: |\n| Exact lookup | 43 ms |\n\n" +
      delimiter +
      "mermaid\nflowchart LR\nA --> B\n" +
      delimiter +
      "\n\n" +
      delimiter +
      "text\nimport thing\n[example](/docs/)\n" +
      delimiter +
      "\n";
    const output = renderReleaseNotes(notes, version);
    expect(output).toContain(
      "[configuration](https://mwillbanks.github.io/ast-mcp/docs/reference/configuration/#index)",
    );
    expect(output).toContain("[npm](https://npmjs.com/)");
    expect(output).toContain("| Exact lookup | 43 ms |");
    expect(output).toContain("[example](/docs/)");
    expect(output).not.toContain("flowchart");
    expect(output).not.toContain("title:");
    expect(output).toEndWith(
      "(https://mwillbanks.github.io/ast-mcp/docs/releases/0.9.0/).\n",
    );
    expect(renderReleaseNotes(notes.replaceAll("\n", "\r\n"), version)).toBe(
      output,
    );
  });

  test.each([
    ["missing metadata", "Release notes."],
    ["pending metadata", authoredNotes],
    ["missing prose", "---\ntitle: 0.9.0\n---\n"],
    ["website-only component", versionedNotes + "\n<Chart />"],
    ["unterminated diagram", versionedNotes + "\n~~~mermaid\nA --> B"],
  ])("rejects %s", (_label, notes) => {
    expect(() => renderReleaseNotes(notes, version)).toThrow();
  });
});

describe("release notes CLI boundary", () => {
  const byteLimit = 1024 * 1024;

  test.each([
    [[version], page],
    [[version, "supplied.mdx"], "supplied.mdx"],
  ] as const)(
    "opens the resolved source for %j",
    async (args, expectedPath) => {
      const opens: string[] = [];
      const ranges: [number, number][] = [];
      const result = await releaseNotesCommand(args, (filename) => {
        opens.push(filename);
        return {
          exists: async () => true,
          slice(start, end) {
            ranges.push([start, end]);
            return new Blob([versionedNotes]);
          },
        };
      });
      expect(opens).toEqual([expectedPath]);
      expect(ranges).toEqual([[0, byteLimit + 1]]);
      expect(result).toBe(renderReleaseNotes(versionedNotes, version));
    },
  );

  test.each([
    [[], "Invalid AST-MCP release version"],
    [["../0.9.0"], "Invalid AST-MCP release version"],
    [[version, "supplied.mdx", "extra"], "Usage: render-release-notes"],
  ] as const)(
    "rejects invalid arguments %j before opening a file",
    async (args, message) => {
      await expect(
        releaseNotesCommand(args, () => {
          throw new Error("Unexpected source read");
        }),
      ).rejects.toThrow(message);
    },
  );

  test("does not read a missing file", async () => {
    await expect(
      releaseNotesCommand([version], () => ({
        exists: async () => false,
        slice() {
          throw new Error("Unexpected source read");
        },
      })),
    ).rejects.toThrow("Release notes source is missing");
  });

  test("rejects an oversized source using one bounded read", async () => {
    await expect(
      releaseNotesCommand([version], () => ({
        exists: async () => true,
        slice(start, end) {
          expect([start, end]).toEqual([0, byteLimit + 1]);
          return new Blob([new Uint8Array(end)]);
        },
      })),
    ).rejects.toThrow("Release notes source is too large");
  });

  test("the executable renders the released page to stdout", async () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const child = Bun.spawn(
      [process.execPath, "scripts/release/render-release-notes.ts", "0.8.0"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(
      "https://mwillbanks.github.io/ast-mcp/docs/releases/0.8.0/",
    );
    expect(stdout).not.toContain("---\ntitle:");
  });
});

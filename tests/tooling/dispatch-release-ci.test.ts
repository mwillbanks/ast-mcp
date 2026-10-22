import { describe, expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  dispatchReleaseCi,
  formatReleaseChangelog,
  runReleaseCi,
} from "../../scripts/release/dispatch-release-ci";

const repository = "mwillbanks/ast-mcp";
const sha = "a".repeat(40);
const normalizedSha = "b".repeat(40);
const formatted = "# Changelog\n\n- entry\n";
const unformatted = "# Changelog\n\n\n* entry\n";
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
    changelog: async (commit) => {
      contents.push(commit);
      return content;
    },
    commitChangelog: async (ref, expected, next) => {
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
      if (operation === "changelog") h.api.changelog = failure;
      if (operation === "commit") h.api.commitChangelog = failure;
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
    const commit = h.api.commitChangelog;
    h.api.commitChangelog = async (...args) => {
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
      h.api.commitChangelog = async () => oid;
      await expect(h.run(undefined, async () => formatted)).rejects.toThrow(
        "commit SHA",
      );
      expect(h.dispatches).toEqual([]);
    },
  );
});

function fileContent(content = formatted) {
  return {
    type: "file",
    path: "CHANGELOG.md",
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
  } = {},
) {
  let head = sha;
  let changelog = options.initial ?? formatted;
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
      if (url.pathname.endsWith("/contents/CHANGELOG.md")) {
        expect(url.searchParams.get("ref")).toBe(head);
        return Response.json(
          "content" in options ? options.content : fileContent(changelog),
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
                };
              };
            };
          }
        ).variables.input;
        expect(input.expectedHeadOid).toBe(head);
        const addition = input.fileChanges.additions[0]!;
        changelog = Buffer.from(addition.contents, "base64").toString("utf8");
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
  return { server, requests, env };
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
  test("uses an atomic expected-head append containing only canonical CHANGELOG bytes", async () => {
    const h = apiServer({ initial: unformatted });
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
        message: { headline: "style: format generated changelog" },
        fileChanges: {
          additions: [
            {
              path: "CHANGELOG.md",
              contents: Buffer.from(formatted).toString("base64"),
            },
          ],
        },
      });
      expect(h.requests.at(-1)?.body).toEqual({
        ref: "release-please--branches--main",
        inputs: { expected_sha: normalizedSha },
      });
      expect(
        h.requests.filter((r) => r.path.endsWith("/pulls/24")),
      ).toHaveLength(3);
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
  test("normalizes Release Please Markdown and is idempotent", async () => {
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

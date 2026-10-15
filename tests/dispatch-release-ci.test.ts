import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  dispatchReleaseCi,
  runReleaseCi,
} from "../scripts/dispatch-release-ci";
const repository = "mwillbanks/ast-mcp";
const sha = "a".repeat(40);
type Api = Parameters<typeof dispatchReleaseCi>[2];
function releasePr() {
  return {
    state: "open",
    base: { ref: "main" },
    head: {
      ref: "release-please--branches--main",
      sha,
      repo: { full_name: repository },
    },
    labels: [{ name: "autorelease: pending" }],
  };
}
function harness(pr = releasePr()) {
  const reads: number[] = [];
  const dispatches: [string, string][] = [];
  const api: Api = {
    pullRequest: async (number) => {
      reads.push(number);
      return pr;
    },
    dispatch: async (ref, commit) => {
      dispatches.push([ref, commit]);
    },
  };
  return { api, reads, dispatches };
}
describe("release PR CI dispatch", () => {
  test("targets current heads once per PR", async () => {
    const h = harness();
    expect(
      await dispatchReleaseCi(
        repository,
        JSON.stringify([{ number: 24 }, { number: 24 }, { number: 27 }]),
        h.api,
      ),
    ).toEqual([sha, sha]);
    expect(h.reads).toEqual([24, 27]);
    expect(h.dispatches).toEqual([
      ["release-please--branches--main", sha],
      ["release-please--branches--main", sha],
    ]);
  });
  test("handles empty output", async () => {
    const h = harness();
    expect(await dispatchReleaseCi(repository, "[]", h.api)).toEqual([]);
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
    await expect(
      dispatchReleaseCi(repository, output, h.api),
    ).rejects.toThrow();
    expect(h.dispatches).toEqual([]);
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
  test.each(changes)("rejects %s", async (_name, change) => {
    const pr = releasePr();
    change(pr);
    const h = harness(pr);
    await expect(
      dispatchReleaseCi(repository, '[{"number":24}]', h.api),
    ).rejects.toThrow();
    expect(h.dispatches).toEqual([]);
  });
  test("propagates lookup and dispatch failures", async () => {
    const h = harness();
    h.api.pullRequest = async () => {
      throw new Error("lookup unavailable");
    };
    await expect(
      dispatchReleaseCi(repository, '[{"number":24}]', h.api),
    ).rejects.toThrow("lookup unavailable");
    expect(h.dispatches).toEqual([]);
    const next = harness();
    next.api.dispatch = async () => {
      throw new Error("dispatch unavailable");
    };
    await expect(
      dispatchReleaseCi(repository, '[{"number":24},{"number":27}]', next.api),
    ).rejects.toThrow("dispatch unavailable");
    expect(next.reads).toEqual([24]);
  });
});
async function runCli(env: Record<string, string>) {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL("../scripts/dispatch-release-ci.ts", import.meta.url),
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
describe("release dispatch API adapter", () => {
  test("requires valid repository credentials", async () => {
    await expect(runReleaseCi({})).rejects.toThrow("required");
  });
  test.each([
    ["valid", releasePr(), 200, true],
    ["null", null, 200, false],
    ["array", [], 200, false],
    ["invalid state", { ...releasePr(), state: 1 }, 200, false],
    ["invalid labels", { ...releasePr(), labels: null }, 200, false],
    [
      "deleted head repository",
      { ...releasePr(), head: { ...releasePr().head, repo: null } },
      200,
      false,
    ],
    ["HTTP failure", releasePr(), 503, false],
  ])("validates %s before dispatch", async (_name, response, status, valid) => {
    let dispatched = false;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        if (request.method === "GET")
          return Response.json(response, { status });
        dispatched = true;
        return new Response(null, { status: 204 });
      },
    });
    try {
      const result = runReleaseCi({
        GITHUB_TOKEN: "test-token",
        GITHUB_REPOSITORY: repository,
        GITHUB_API_URL: server.url.origin,
        RELEASE_PRS: '[{"number":24}]',
      });
      if (valid) expect(await result).toEqual([sha]);
      else await expect(result).rejects.toThrow();
      expect(dispatched).toBe(valid);
    } finally {
      server.stop(true);
    }
  });
});
describe("release dispatch CLI", () => {
  const invalidEnvironments: Record<string, string>[] = [
    {},
    { GITHUB_REPOSITORY: repository },
    {
      GITHUB_TOKEN: "test-token",
      GITHUB_REPOSITORY: "invalid/repository/path",
    },
  ];
  test.each(invalidEnvironments)(
    "rejects invalid credentials %j",
    async (env) => {
      const result = await runCli(env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain("test-token");
    },
  );
  test.each([200, 503])(
    "uses GitHub contracts and handles HTTP %s",
    async (lookupStatus) => {
      const requests: {
        method: string;
        path: string;
        authorization: string | null;
        body: unknown;
      }[] = [];
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          requests.push({
            method: request.method,
            path: new URL(request.url).pathname,
            authorization: request.headers.get("authorization"),
            body: request.method === "POST" ? await request.json() : null,
          });
          return request.method === "GET"
            ? Response.json(releasePr(), { status: lookupStatus })
            : new Response(null, { status: 204 });
        },
      });
      try {
        const result = await runCli({
          GITHUB_TOKEN: "test-token",
          GITHUB_REPOSITORY: repository,
          GITHUB_API_URL: server.url.origin,
          RELEASE_PRS: '[{"number":24}]',
        });
        expect(requests[0]).toEqual({
          method: "GET",
          path: `/repos/${repository}/pulls/24`,
          authorization: "Bearer test-token",
          body: null,
        });
        if (lookupStatus === 200) {
          expect(result.status).toBe(0);
          expect(requests[1]).toEqual({
            method: "POST",
            path: `/repos/${repository}/actions/workflows/ci.yml/dispatches`,
            authorization: "Bearer test-token",
            body: {
              ref: "release-please--branches--main",
              inputs: { expected_sha: sha },
            },
          });
        } else {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("503");
          expect(requests).toHaveLength(1);
        }
        expect(result.stderr).not.toContain("test-token");
      } finally {
        server.stop(true);
      }
    },
  );
});

import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  candidateCommand,
  legacyRelease,
  previousStable,
  releaseVersion,
  selectCandidate,
  type CandidateRelease,
  type CandidateIo,
} from "../../scripts/release/candidate-policy.ts";

const first = "a".repeat(40);
const second = "b".repeat(40);
function release(overrides: Partial<CandidateRelease> = {}): CandidateRelease {
  return {
    id: 123,
    tag_name: "ast-mcp-v0.9.2",
    target_commitish: first,
    draft: true,
    prerelease: false,
    assets: [],
    ...overrides,
  };
}

describe("release candidate identity", () => {
  test("drafts use the exact qualified commit and allow same-commit retries", () => {
    expect(selectCandidate(release(), first, false)).toBe(first);
    expect(selectCandidate(release(), first, true)).toBe(first);
    expect(selectCandidate(release(), first, false, first)).toBe(first);
    expect(() => selectCandidate(release(), second, false)).toThrow(
      "another commit",
    );
  });

  test("only explicit recovery can retarget an untagged draft", () => {
    expect(selectCandidate(release(), second, true)).toBe(second);
    expect(() => selectCandidate(release(), second, true, first)).toThrow(
      "already points",
    );
    expect(() =>
      selectCandidate(release({ target_commitish: "main" }), first, true),
    ).toThrow("immutable");
  });

  test("published recovery retains the existing immutable target", () => {
    const published = release({ draft: false });
    expect(selectCandidate(published, second, true, first)).toBe(first);
    expect(() => selectCandidate(published, second, false, first)).toThrow(
      "another commit",
    );
    expect(() => selectCandidate(published, first, true, second)).toThrow(
      "target and tag differ",
    );
    expect(() => selectCandidate(published, first, true)).toThrow(
      "target and tag differ",
    );
  });

  test("malformed and prerelease candidates cannot publish", () => {
    for (const candidate of [
      release({ id: 0 }),
      release({ id: 1.5 }),
      release({ prerelease: true }),
      release({ tag_name: "ast-mcp-v0.9.2-rc.1" }),
    ])
      expect(() => selectCandidate(candidate, first, true)).toThrow();
    expect(() => selectCandidate(release(), "main", false)).toThrow();
  });

  test("legacy drafts cannot bypass the hosted gate", () => {
    expect(() =>
      selectCandidate(release({ tag_name: "ast-mcp-v0.9.1" }), first, true),
    ).toThrow("Legacy draft");
  });

  test("legacy recovery excludes versions after the hosted baseline boundary", () => {
    expect(legacyRelease("ast-mcp-v0.8.0")).toBe(true);
    expect(legacyRelease("ast-mcp-v0.9.1")).toBe(true);
    expect(legacyRelease("ast-mcp-v0.9.2")).toBe(false);
    expect(legacyRelease("ast-mcp-v0.10.0")).toBe(false);
    expect(() => releaseVersion("ast-mcp-v00.9.2")).toThrow();
    expect(() => releaseVersion("ast-mcp-v0.9.2\n")).toThrow();
  });

  test("selects the immediately preceding stable version numerically", () => {
    const versions = [
      release({ tag_name: "ast-mcp-v0.9.1", draft: false }),
      release({ tag_name: "ast-mcp-v0.10.0", draft: false }),
      release({ tag_name: "ast-mcp-v0.11.0" }),
      release({ tag_name: "ast-mcp-v0.10.1", draft: false, prerelease: true }),
      release({ tag_name: "ast-mcp-v1.0.0", draft: false }),
    ];
    expect(previousStable(versions, "ast-mcp-v0.11.0").tag_name).toBe(
      "ast-mcp-v0.10.0",
    );
    expect(previousStable(versions, "ast-mcp-v0.9.2").tag_name).toBe(
      "ast-mcp-v0.9.1",
    );
    expect(() => previousStable([], "ast-mcp-v0.9.2")).toThrow("missing");
  });
});

type RunOptions = NonNullable<Parameters<CandidateIo["run"]>[1]>;
const fixtureDirectory = path.resolve("benchmark-fixture");
const matrix = path.join(fixtureDirectory, "matrix");
const evidence = path.join(fixtureDirectory, "evidence");
const report = path.join(evidence, "release-benchmarks.json");
const packages = path.join(fixtureDirectory, "packages");
const rootPackage = path.join(packages, "ast-mcp.tgz");
const platforms = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "linux-arm64-musl",
  "linux-x64-musl",
  "windows-x64",
];
function digest(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
function runtime() {
  const current = release();
  const previous = release({
    id: 122,
    tag_name: "ast-mcp-v0.9.1",
    target_commitish: second,
    draft: false,
  });
  const files = new Map<string, string>([
    ["package.json", JSON.stringify({ version: "0.9.2" })],
    [report, "qualified-report"],
    [rootPackage, "root-package"],
    [rootPackage + ".sha256", digest("root-package") + "\n"],
  ]);
  for (const platform of platforms) {
    const directory = path.join(matrix, "standalone-bun-" + platform);
    const archive = "ast-mcp-" + platform + ".tar.gz";
    files.set(path.join(directory, archive), "standalone-" + platform);
    files.set(
      path.join(directory, archive) + ".sha256",
      digest("standalone-" + platform) + "  " + archive + "\n",
    );
    const npm = path.join(directory, "ast-mcp-npm-" + platform + ".tgz");
    files.set(npm, "npm-" + platform);
    files.set(npm + ".sha256", digest("npm-" + platform) + "\n");
  }
  const assetContents = new Map<number, string>();
  let nextAsset = 500;
  function asset(owner: CandidateRelease, name: string, content: string) {
    const entry = {
      id: nextAsset++,
      name,
      digest: "sha256:" + digest(content),
    };
    owner.assets.push(entry);
    assetContents.set(entry.id, content);
    return entry;
  }
  const state = {
    current,
    previous,
    all: [current, previous],
    files,
    assetContents,
    tags: new Map<string, string>([[previous.tag_name, second]]),
    calls: [] as Array<{ args: string[]; options: RunOptions }>,
    uploads: [] as string[],
    bodies: [] as Record<string, unknown>[],
    printed: [] as string[],
    deleted: [] as number[],
    tarEntries: "ast-mcp-bytecode\nruntime/addon.node",
    verifyFailure: false,
    benchmarkCode: 0,
    collectCode: 0,
    collectError: "",
    uploadStatus: 201,
    uploadDigestWrong: false,
    downloadFailure: false,
    commandFailure: false,
    apiFailure: false,
    publishedSha: first,
    checkoutSha: first,
    promotedTarget: first,
    manifestVersion: "0.9.2",
    remoteTag: undefined as string | undefined,
    remoteTagStatus: 200,
    annotatedTag: false,
    beforePromotion: undefined as (() => void) | undefined,
  };
  const ok = (output = "") => ({ code: 0, output, error: "" });
  const io: CandidateIo = {
    executable: "/runtime/bun",
    env: {
      GITHUB_REPOSITORY: "owner/ast-mcp",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: first,
      GITHUB_OUTPUT: "/outputs",
      GITHUB_STEP_SUMMARY: "/summary",
      RELEASE_TAG: current.tag_name,
      CANDIDATE_SHA: first,
      RELEASE_ID: String(current.id),
      RELEASE_DRAFT: "true",
    },
    file: (filename) => ({
      text: async () => {
        const value = files.get(filename);
        if (value === undefined) throw new Error("Missing fixture " + filename);
        return value;
      },
      json: async () => JSON.parse(files.get(filename)!),
      stream: () => {
        const value = files.get(filename);
        if (value === undefined) throw new Error("Missing fixture " + filename);
        return new Response(value).body!;
      },
    }),
    append: async (filename, content) => {
      files.set(filename, (files.get(filename) ?? "") + content);
    },
    write: (content) => {
      state.printed.push(content);
    },
    upload: async (url, filename) => {
      state.uploads.push(url);
      const name = new URL(url).searchParams.get("name")!;
      const value = files.get(filename)!;
      const entry = asset(current, name, value);
      return {
        ok: state.uploadStatus === 201,
        status: state.uploadStatus,
        body: JSON.stringify({
          digest: state.uploadDigestWrong ? "wrong" : entry.digest,
        }),
      };
    },
    run: async (args, options = {}) => {
      state.calls.push({ args, options });
      if (state.commandFailure)
        return { code: 1, output: "", error: "command unavailable" };
      if (args[0] === "mkdir") return ok();
      if (args[0] === "tar")
        return ok(args[1] === "-tzf" ? state.tarEntries : "");
      if (args[0] === "git") {
        if (args[1] === "rev-parse") {
          if (args.at(-1) === "HEAD") return ok(state.checkoutSha);
          const tag = args
            .at(-1)!
            .slice("refs/tags/".length, -"^{commit}".length);
          const sha = state.tags.get(tag);
          return sha ? ok(sha) : { code: 1, output: "", error: "missing tag" };
        }
        if (args[1] === "show")
          return ok(
            args.at(-1)!.endsWith(":package.json")
              ? JSON.stringify({ version: state.manifestVersion })
              : "---\ntitle: 0.9.2\ndescription: Release.\n---\n\n## Changes\n\nQualified runtime.\n",
          );
        return ok();
      }
      if (args[0] === "gh") {
        if (args.includes("--include")) {
          const status =
            state.remoteTagStatus !== 200
              ? state.remoteTagStatus
              : state.remoteTag
                ? 200
                : 404;
          return {
            code: status === 200 ? 0 : 1,
            output:
              "HTTP/2.0 " +
              status +
              "\r\n\r\n" +
              JSON.stringify({
                object: {
                  type: state.annotatedTag ? "tag" : "commit",
                  sha: state.remoteTag,
                },
              }),
            error: status === 403 ? "API denied" : "",
          };
        }
        if (args.includes("--paginate")) return ok(JSON.stringify([state.all]));
        if (args.includes("--method")) {
          if (state.apiFailure)
            return { code: 1, output: "", error: "API denied" };
          const method = args[3]!;
          const endpoint = args[4]!;
          if (method === "DELETE") {
            const id = Number(endpoint.split("/").at(-1));
            state.deleted.push(id);
            current.assets = current.assets.filter((entry) => entry.id !== id);
            return ok();
          }
          if (method === "PATCH") {
            const body = JSON.parse(options.input!) as Record<string, unknown>;
            state.bodies.push(body);
            if (body.draft === false) {
              current.draft = false;
              current.target_commitish = state.promotedTarget;
              state.tags.set(current.tag_name, state.publishedSha);
            }
            return ok(JSON.stringify(current));
          }
          if (method === "POST") return ok();
          if (endpoint.includes("/git/tags/"))
            return ok(
              JSON.stringify({
                object: { type: "commit", sha: state.remoteTag },
              }),
            );
          if (endpoint.includes("/commits/"))
            return ok(JSON.stringify({ sha: state.publishedSha }));
          return ok(JSON.stringify(current));
        }
        if (state.downloadFailure)
          return { code: 1, output: "", error: "asset unavailable" };
        const id = Number(args.at(-1)!.split("/").at(-1));
        files.set(options.outputFile!, assetContents.get(id)!);
        return ok();
      }
      if (args[1] === "scripts/benchmark/shared-runtime-baseline.ts") {
        files.set(options.outputFile!, "{}");
        return {
          code: state.benchmarkCode,
          output: "",
          error: "workload diagnostics",
        };
      }
      if (args[1] === "scripts/release/release-benchmarks.ts") {
        if (args[2] === "verify" && state.verifyFailure)
          return { code: 1, output: "", error: "invalid report" };
        if (args[2] === "collect") {
          files.set(args[4]!, "qualified-report");
          return {
            code: state.collectCode,
            output: "Benchmark gate summary\n",
            error: state.collectError,
          };
        }
        if (args[2] === "render") state.beforePromotion?.();
        return ok(
          args[2] === "render"
            ? "## Benchmark comparison\n\nMeasured results."
            : "",
        );
      }
      throw new Error("Unexpected fixture command " + JSON.stringify(args));
    },
  };
  const run = (args: string[]) => candidateCommand(args, io);
  const published = () => {
    current.draft = false;
    io.env.RELEASE_DRAFT = "false";
    state.tags.set(current.tag_name, first);
  };
  const previousHosted = () => {
    previous.tag_name = "ast-mcp-v0.9.2";
    current.tag_name = "ast-mcp-v0.9.3";
    io.env.RELEASE_TAG = current.tag_name;
    state.tags.set(previous.tag_name, second);
    asset(previous, "release-benchmarks.json", "previous-report");
    asset(previous, "ast-mcp-linux-x64.tar.gz", "previous-binary");
    asset(
      previous,
      "ast-mcp-linux-x64.tar.gz.sha256",
      digest("previous-binary") + "  ast-mcp-linux-x64.tar.gz\n",
    );
  };
  const retain = () => {
    current.assets = [];
    for (const [filename, content] of files)
      if (
        filename.startsWith(matrix + path.sep) ||
        filename.startsWith(packages + path.sep)
      )
        asset(current, path.basename(filename), content);
    asset(current, "release-benchmarks.json", "qualified-report");
  };
  return { state, io, asset, run, published, previousHosted, retain };
}

describe("release orchestration", () => {
  test("resolves new candidates and published recoveries with immutable outputs", async () => {
    const fixture = runtime();
    await fixture.run(["resolve"]);
    expect(fixture.state.files.get("/outputs")).toContain(
      "candidate_sha=" + first,
    );
    expect(fixture.state.files.get("/outputs")).toContain(
      "published_recovery=false",
    );
    fixture.published();
    fixture.io.env.RECOVERY_TAG = fixture.state.current.tag_name;
    fixture.io.env.GITHUB_SHA = second;
    await fixture.run(["resolve"]);
    expect(fixture.state.files.get("/outputs")).toContain(
      "published_recovery=true",
    );
  });

  test("an ordinary push without a new release leaves publication disabled", async () => {
    const fixture = runtime();
    fixture.state.all = [];
    await fixture.run(["resolve"]);
    expect(fixture.state.files.get("/outputs")).toBe(
      "release_created=false\npending_draft=false\n",
    );
    fixture.state.all = [release({ target_commitish: second })];
    await fixture.run(["resolve"]);
    expect(fixture.state.files.get("/outputs")).toBe(
      "release_created=false\npending_draft=false\nrelease_created=false\npending_draft=true\n",
    );
  });

  test("only managed stable drafts prevent preparing another release", async () => {
    for (const candidate of [
      release({ tag_name: "ast-mcp-v0.9.1" }),
      release({ tag_name: "ast-mcp-v0.9.3", prerelease: true }),
      release({ tag_name: "another-v1.0.0" }),
    ]) {
      const fixture = runtime();
      fixture.state.all = [candidate];
      await fixture.run(["resolve"]);
      expect(fixture.state.files.get("/outputs")).toContain(
        "pending_draft=false",
      );
    }
  });

  test("failed creation, missing recovery and mismatched manifest block resolution", async () => {
    const fixture = runtime();
    fixture.state.all = [];
    fixture.io.env.CREATED_TAG = "ast-mcp-v0.9.2";
    await expect(fixture.run(["resolve"])).rejects.toThrow("missing");
    delete fixture.io.env.CREATED_TAG;
    fixture.io.env.RELEASE_OUTCOME = "failure";
    await expect(fixture.run(["resolve"])).rejects.toThrow("missing");
    fixture.state.all = [release({ target_commitish: second })];
    await expect(fixture.run(["resolve"])).rejects.toThrow(
      "without a matching release",
    );
    fixture.state.all = [fixture.state.current];
    fixture.state.manifestVersion = "0.9.3";
    await expect(fixture.run(["resolve"])).rejects.toThrow(
      "version does not match",
    );
  });

  test("rejects invalid workflow environment and unavailable commands", async () => {
    for (const [key, value, message] of [
      ["GITHUB_REF", "refs/heads/other", "require main"],
      ["GITHUB_SHA", "main", "event commit"],
      ["GITHUB_REPOSITORY", "owner/repo\n", "repository"],
      ["GITHUB_OUTPUT", "", "GITHUB_OUTPUT"],
    ]) {
      const fixture = runtime();
      fixture.io.env[key!] = value!;
      await expect(fixture.run(["resolve"])).rejects.toThrow(message!);
    }
    const fixture = runtime();
    fixture.state.commandFailure = true;
    await expect(fixture.run(["resolve"])).rejects.toThrow(
      "command unavailable",
    );
  });

  test("the first hosted release measures its qualified archive and publishes the gate summary", async () => {
    const fixture = runtime();
    await fixture.run(["benchmark", matrix, evidence]);
    const measure = fixture.state.calls.find(
      ({ args }) => args[1] === "scripts/benchmark/shared-runtime-baseline.ts",
    )!;
    expect(
      fixture.state.calls.some(
        ({ args }) =>
          args[0] === "gh" &&
          args[3] === "GET" &&
          args[4] === "repos/owner/ast-mcp/releases/123",
      ),
    ).toBe(false);
    expect(measure.args).toContain("--rounds=5");
    expect(measure.args).toContain("--samples=2");
    expect(measure.args).toContain("--clients=1,4,16");
    expect(
      measure.args.some((arg) => arg.startsWith("--compare-command")),
    ).toBe(false);
    expect(measure.args.join(" ")).toContain("--shared-stdio");
    expect(fixture.state.files.get("/summary")).toBe(
      "Benchmark gate summary\n",
    );
    expect(fixture.state.printed).toEqual(["Benchmark gate summary\n"]);
  });

  test("draft benchmarks require the resolved identity and exact event checkout", async () => {
    for (const [key, value] of [
      ["RELEASE_DRAFT", ""],
      ["RELEASE_DRAFT", "TRUE"],
      ["RELEASE_TAG", "invalid"],
      ["RELEASE_ID", "0"],
      ["RELEASE_ID", "9007199254740992"],
      ["CANDIDATE_SHA", "main"],
      ["GITHUB_SHA", second],
      ["GITHUB_REF", "refs/heads/other"],
    ]) {
      const fixture = runtime();
      fixture.io.env[key!] = value!;
      await expect(
        fixture.run(["benchmark", matrix, "/evidence"]),
      ).rejects.toThrow();
      expect(fixture.state.calls.some(({ args }) => args[0] === "gh")).toBe(
        false,
      );
    }
    const fixture = runtime();
    fixture.state.checkoutSha = second;
    await expect(
      fixture.run(["benchmark", matrix, "/evidence"]),
    ).rejects.toThrow("qualified event commit");
    fixture.state.checkoutSha = first;
    fixture.io.env.RELEASE_DRAFT = "false";
    await expect(
      fixture.run(["benchmark", matrix, "/evidence"]),
    ).rejects.toThrow("requires a published release");
  });

  test("later releases verify the previous report and archive before interleaved comparison", async () => {
    const fixture = runtime();
    fixture.previousHosted();
    await fixture.run(["benchmark", matrix, evidence]);
    const measure = fixture.state.calls.find(
      ({ args }) => args[1] === "scripts/benchmark/shared-runtime-baseline.ts",
    )!;
    expect(
      measure.args.some((arg) => arg.startsWith("--compare-command=")),
    ).toBe(true);
    const collect = fixture.state.calls.find(
      ({ args }) => args[2] === "collect",
    )!;
    expect(collect.args.slice(-2)).toEqual(["ast-mcp-v0.9.2", second]);
    expect(
      fixture.state.calls.findIndex(({ args }) => args[2] === "verify"),
    ).toBeLessThan(
      fixture.state.calls.findIndex(
        ({ args }) =>
          args[1] === "scripts/benchmark/shared-runtime-baseline.ts",
      ),
    );
  });

  test("invalid workloads and failed thresholds preserve summaries and fail the gate", async () => {
    const fixture = runtime();
    fixture.state.benchmarkCode = 1;
    await expect(fixture.run(["benchmark", matrix, evidence])).rejects.toThrow(
      "workloads failed",
    );
    expect(fixture.state.files.get("/summary")).toContain(
      "workload diagnostics",
    );
    expect(fixture.state.calls.some(({ args }) => args[2] === "collect")).toBe(
      false,
    );
    fixture.state.benchmarkCode = 0;
    fixture.state.collectCode = 1;
    fixture.state.files.delete(report);
    fixture.state.collectError = "Malformed observations: missing indexed cell";
    await expect(fixture.run(["benchmark", matrix, evidence])).rejects.toThrow(
      "gate failed",
    );
    expect(fixture.state.files.get(report)).toBe("qualified-report");
    expect(fixture.state.files.get("/summary")).toContain(
      fixture.state.collectError,
    );
    expect(fixture.state.printed.at(-1)).toContain(fixture.state.collectError);
    const collection = fixture.state.calls.find(
      ({ args }) => args[2] === "collect",
    )!;
    expect(collection.options.inheritStderr).toBeUndefined();
    delete fixture.io.env.GITHUB_STEP_SUMMARY;
    fixture.state.collectCode = 0;
    await fixture.run(["benchmark", matrix, evidence]);
  });

  test("published recovery reuses a verified report and preserves authored historical notes", async () => {
    const fixture = runtime();
    fixture.published();
    fixture.asset(
      fixture.state.current,
      "release-benchmarks.json",
      "qualified-report",
    );
    await fixture.run(["benchmark", matrix, evidence]);
    expect(
      fixture.state.calls.some(
        ({ args }) =>
          args[1] === "scripts/benchmark/shared-runtime-baseline.ts",
      ),
    ).toBe(false);
    await fixture.run(["notes", report]);
    expect(fixture.state.bodies).toEqual([]);
    expect(
      fixture.state.calls.some(({ args }) =>
        args[4]?.includes("/actions/workflows/docs.yml/dispatches"),
      ),
    ).toBe(true);
    fixture.state.current.tag_name = "ast-mcp-v0.9.1";
    fixture.io.env.RELEASE_TAG = fixture.state.current.tag_name;
    fixture.state.tags.set(fixture.state.current.tag_name, first);
    fixture.state.current.assets = [];
    await fixture.run(["benchmark", matrix, evidence]);
    await fixture.run(["notes", report]);
    expect(fixture.state.bodies).toEqual([]);
  });

  test("identity or report failures stop published recovery", async () => {
    const fixture = runtime();
    fixture.published();
    await expect(fixture.run(["benchmark", matrix, evidence])).rejects.toThrow(
      "Missing checksum",
    );
    fixture.asset(
      fixture.state.current,
      "release-benchmarks.json",
      "qualified-report",
    );
    fixture.state.verifyFailure = true;
    await expect(fixture.run(["benchmark", matrix, evidence])).rejects.toThrow(
      "invalid report",
    );
    fixture.state.verifyFailure = false;
    fixture.state.tags.set(fixture.state.current.tag_name, second);
    await expect(fixture.run(["benchmark", matrix, evidence])).rejects.toThrow(
      "identity changed",
    );
  });

  test("archives require valid digests and safe extraction paths", async () => {
    for (const [contents, message] of [
      ["malformed", "Invalid standalone checksum"],
      ["0".repeat(64) + "  ast-mcp-linux-x64.tar.gz", "checksum mismatch"],
    ]) {
      const fixture = runtime();
      fixture.state.files.set(
        path.join(
          matrix,
          "standalone-bun-linux-x64",
          "ast-mcp-linux-x64.tar.gz.sha256",
        ),
        contents!,
      );
      await expect(
        fixture.run(["benchmark", matrix, evidence]),
      ).rejects.toThrow(message!);
    }
    for (const entries of ["/escape", "runtime/../../escape"]) {
      const fixture = runtime();
      fixture.state.tarEntries = entries;
      await expect(
        fixture.run(["benchmark", matrix, evidence]),
      ).rejects.toThrow("Unsafe standalone");
    }
  });

  test("previous release evidence cannot be missing, corrupt or unavailable", async () => {
    for (const issue of ["target", "missing", "digest", "download"]) {
      const fixture = runtime();
      fixture.previousHosted();
      if (issue === "target") fixture.state.previous.target_commitish = first;
      if (issue === "missing") fixture.state.previous.assets = [];
      if (issue === "digest")
        fixture.state.previous.assets[0]!.digest = "sha256:" + "0".repeat(64);
      if (issue === "download") fixture.state.downloadFailure = true;
      await expect(
        fixture.run(["benchmark", matrix, evidence]),
      ).rejects.toThrow(
        {
          target: "target and tag differ",
          missing: "Missing checksum",
          digest: "digest mismatch",
          download: "download failed",
        }[issue]!,
      );
    }
  });

  test("attachment preserves identical assets and replaces only draft artifacts", async () => {
    const fixture = runtime();
    fixture.retain();
    await fixture.run(["attach", matrix, report, rootPackage]);
    expect(fixture.state.uploads).toEqual([]);
    fixture.state.current.assets[0]!.digest = "sha256:" + "0".repeat(64);
    await fixture.run(["attach", matrix, report, rootPackage]);
    expect(fixture.state.deleted).toHaveLength(1);
    expect(fixture.state.uploads[0]).toStartWith(
      "https://uploads.github.com/repos/owner/ast-mcp/releases/123/assets?name=",
    );
    fixture.published();
    await fixture.run(["attach", matrix, report, rootPackage]);
    expect(fixture.state.uploads).toHaveLength(1);
  });

  test("missing reports and failed uploads stop draft publication", async () => {
    const fixture = runtime();
    fixture.state.verifyFailure = true;
    await expect(
      fixture.run(["attach", matrix, report, rootPackage]),
    ).rejects.toThrow("invalid report");
    fixture.state.verifyFailure = false;
    fixture.state.uploadStatus = 403;
    await expect(
      fixture.run(["attach", matrix, report, rootPackage]),
    ).rejects.toThrow("upload failed");
    const digestFailure = runtime();
    digestFailure.state.uploadDigestWrong = true;
    await expect(
      digestFailure.run(["attach", matrix, report, rootPackage]),
    ).rejects.toThrow("Uploaded release asset digest mismatch");
  });

  test("a draft requires every qualified asset and report before promotion", async () => {
    const fixture = runtime();
    await expect(
      fixture.run(["promote", matrix, report, rootPackage]),
    ).rejects.toThrow("Qualified release assets");
    fixture.retain();
    fixture.state.current.assets = fixture.state.current.assets.filter(
      (entry) => entry.name !== "release-benchmarks.json",
    );
    await expect(
      fixture.run(["promote", matrix, report, rootPackage]),
    ).rejects.toThrow("report is missing");
    fixture.asset(
      fixture.state.current,
      "release-benchmarks.json",
      "qualified-report",
    );
    fixture.state.current.assets = fixture.state.current.assets.filter(
      (entry) => entry.name !== "ast-mcp.tgz",
    );
    await expect(
      fixture.run(["promote", matrix, report, rootPackage]),
    ).rejects.toThrow("npm release assets");
    fixture.retain();
    await fixture.run(["promote", matrix, report, rootPackage]);
    expect(fixture.state.bodies[0]).toMatchObject({
      target_commitish: first,
      draft: false,
    });
    expect(fixture.state.bodies[0]!.body).toContain("## Benchmark comparison");
    await fixture.run(["promote", matrix, report, rootPackage]);
    expect(fixture.state.bodies).toHaveLength(1);
  });

  test("publication verifies both the release response and resulting tag", async () => {
    for (const issue of ["release", "tag"]) {
      const fixture = runtime();
      fixture.retain();
      if (issue === "release") fixture.state.promotedTarget = second;
      else fixture.state.publishedSha = second;
      await expect(
        fixture.run(["promote", matrix, report, rootPackage]),
      ).rejects.toThrow(
        issue === "release"
          ? "Published release does not match"
          : "Published tag does not match",
      );
    }
  });

  test("promotion rejects changed remote assets before publishing", async () => {
    for (const name of [
      "ast-mcp-linux-x64.tar.gz",
      "ast-mcp-linux-x64.tar.gz.sha256",
      "ast-mcp-npm-linux-x64.tgz",
      "ast-mcp-npm-linux-x64.tgz.sha256",
      "ast-mcp.tgz",
      "ast-mcp.tgz.sha256",
      "release-benchmarks.json",
    ]) {
      const fixture = runtime();
      fixture.retain();
      fixture.state.current.assets.find(
        (asset) => asset.name === name,
      )!.digest = "sha256:" + "0".repeat(64);
      await expect(
        fixture.run(["promote", matrix, report, rootPackage]),
      ).rejects.toThrow("digest mismatch");
      expect(fixture.state.bodies).toEqual([]);
    }
  });

  test("promotion verifies existing remote tags and fails closed on lookup errors", async () => {
    for (const annotated of [false, true]) {
      const fixture = runtime();
      fixture.retain();
      fixture.state.remoteTag = first;
      fixture.state.annotatedTag = annotated;
      await fixture.run(["promote", matrix, report, rootPackage]);
      expect(fixture.state.bodies).toHaveLength(1);
    }
    for (const issue of ["mismatch", "unavailable"]) {
      const fixture = runtime();
      fixture.retain();
      fixture.state.remoteTag = second;
      if (issue === "unavailable") fixture.state.remoteTagStatus = 403;
      await expect(
        fixture.run(["promote", matrix, report, rootPackage]),
      ).rejects.toThrow(
        issue === "mismatch"
          ? "Remote release tag differs"
          : "Cannot verify remote release tag",
      );
      expect(fixture.state.bodies).toEqual([]);
    }
  });

  test("promotion revalidates draft identity and digests after rendering notes", async () => {
    for (const issue of ["tag", "target", "published", "asset"]) {
      const fixture = runtime();
      fixture.retain();
      fixture.io.env.RECOVERY_TAG = fixture.state.current.tag_name;
      fixture.state.beforePromotion = () => {
        if (issue === "tag") fixture.state.current.tag_name = "ast-mcp-v0.9.3";
        if (issue === "target") fixture.state.current.target_commitish = second;
        if (issue === "published") fixture.published();
        if (issue === "asset") fixture.state.current.assets[0]!.digest = null;
      };
      await expect(
        fixture.run(["promote", matrix, report, rootPackage]),
      ).rejects.toThrow();
      expect(fixture.state.bodies).toEqual([]);
    }
  });

  test("published recovery restores exact archives before existing qualifications", async () => {
    const fixture = runtime();
    fixture.published();
    fixture.retain();
    const restoredRoot = path.join(fixtureDirectory, "restored-root");
    const restoredMatrix = path.join(fixtureDirectory, "restored-matrix");
    await fixture.run(["restore-root", restoredRoot]);
    await fixture.run(["restore-matrix", restoredMatrix]);
    expect(
      fixture.state.files.get(path.join(restoredRoot, "ast-mcp.tgz")),
    ).toBe("root-package");
    expect(
      fixture.state.files.get(
        path.join(
          restoredMatrix,
          "standalone-bun-linux-x64",
          "ast-mcp-npm-linux-x64.tgz",
        ),
      ),
    ).toBe("npm-linux-x64");
    expect(
      fixture.state.files.get(
        path.join(
          restoredMatrix,
          "standalone-bun-darwin-arm64",
          "ast-mcp-darwin-arm64.tar.gz",
        ),
      ),
    ).toBe("standalone-darwin-arm64");
    const draft = runtime();
    await expect(draft.run(["restore-root", restoredRoot])).rejects.toThrow(
      "managed published",
    );
  });

  test("invalid command arguments and remote identity are rejected", async () => {
    for (const args of [
      [],
      ["unknown"],
      ["resolve", "extra"],
      ["benchmark"],
      ["attach", matrix, report],
      ["promote"],
      ["promote", report, "extra"],
      ["notes"],
      ["restore-root"],
      ["restore-matrix", "/directory", "extra"],
      ["resolve", "a", "b", "c", "d"],
    ])
      await expect(runtime().run(args)).rejects.toThrow();
    const fixture = runtime();
    await expect(fixture.run(["notes", report])).rejects.toThrow("draft");
    fixture.state.current.id = 999;
    await expect(
      fixture.run(["attach", matrix, report, rootPackage]),
    ).rejects.toThrow("identity changed");
    fixture.state.current.id = 123;
    fixture.state.current.target_commitish = second;
    await expect(
      fixture.run(["attach", matrix, report, rootPackage]),
    ).rejects.toThrow("without explicit recovery");
    fixture.io.env.RECOVERY_TAG = fixture.state.current.tag_name;
    await fixture.run(["attach", matrix, report, rootPackage]);
  });

  test("legacy drafts cannot bypass evidence checks through direct commands", async () => {
    const fixture = runtime();
    fixture.state.current.tag_name = "ast-mcp-v0.9.1";
    fixture.io.env.RELEASE_TAG = fixture.state.current.tag_name;
    await expect(
      fixture.run(["attach", matrix, report, rootPackage]),
    ).rejects.toThrow("Legacy draft");
    await expect(
      fixture.run(["promote", matrix, report, rootPackage]),
    ).rejects.toThrow("Legacy draft");
  });

  test("GitHub authorization failures stop orchestration before external changes", async () => {
    const fixture = runtime();
    fixture.state.apiFailure = true;
    await expect(fixture.run(["notes", report])).rejects.toThrow("API denied");
    expect(fixture.state.bodies).toEqual([]);
  });
});

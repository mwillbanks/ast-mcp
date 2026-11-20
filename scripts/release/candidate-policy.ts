import path from "node:path";

import { renderReleaseNotes } from "./render-release-notes.ts";

const tagPattern = /^ast-mcp-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[a-f0-9]{40}$/;
const targets = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "linux-arm64-musl",
  "linux-x64-musl",
  "windows-x64",
];

export type CandidateRelease = {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{ id: number; name: string; digest: string | null }>;
};

export function releaseVersion(tag: string): string {
  if (tag !== tag.trim() || !tagPattern.test(tag))
    throw new Error("Invalid release tag");
  return tag.slice("ast-mcp-v".length);
}

export function legacyRelease(tag: string): boolean {
  return compareVersions(releaseVersion(tag), "0.9.1") <= 0;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

export function previousStable(
  releases: CandidateRelease[],
  tag: string,
): CandidateRelease {
  const version = releaseVersion(tag);
  const candidates = releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        tagPattern.test(release.tag_name) &&
        compareVersions(releaseVersion(release.tag_name), version) < 0,
    )
    .sort((a, b) =>
      compareVersions(releaseVersion(b.tag_name), releaseVersion(a.tag_name)),
    );
  if (!candidates[0]) throw new Error("Previous stable release is missing");
  return candidates[0];
}

export function selectCandidate(
  release: CandidateRelease,
  head: string,
  recovery: boolean,
  tagCommit?: string,
): string {
  releaseVersion(release.tag_name);
  if (
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.prerelease ||
    head.length !== 40 ||
    !shaPattern.test(head)
  )
    throw new Error("Invalid release candidate");
  if (
    release.target_commitish.length !== 40 ||
    !shaPattern.test(release.target_commitish)
  )
    throw new Error("Release target must be an immutable commit");
  if (release.draft) {
    if (legacyRelease(release.tag_name))
      throw new Error("Legacy draft releases require a new version");
    if (!recovery && release.target_commitish !== head)
      throw new Error("Draft release belongs to another commit");
    if (tagCommit && tagCommit !== head)
      throw new Error("Draft tag already points to another commit");
    return recovery ? head : release.target_commitish;
  }
  if (!tagCommit || release.target_commitish !== tagCommit)
    throw new Error("Published release target and tag differ");
  if (!recovery && tagCommit !== head)
    throw new Error("Published release belongs to another commit");
  return tagCommit;
}

export type CandidateIo = {
  executable: string;
  env: Record<string, string | undefined>;
  run: (
    args: string[],
    options?: {
      cwd?: string;
      input?: string;
      outputFile?: string;
      inheritStderr?: boolean;
      timeoutMs?: number;
    },
  ) => Promise<{ code: number; output: string; error: string }>;
  file: (filename: string) => {
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    stream: () => ReadableStream<Uint8Array>;
  };
  append: (filename: string, content: string) => Promise<unknown>;
  write: (content: string) => void;
  upload: (
    url: string,
    filename: string,
  ) => Promise<{ ok: boolean; status: number; body: string }>;
};

export async function candidateCommand(
  args: string[],
  io: CandidateIo,
): Promise<void> {
  async function command(args: string[], cwd?: string): Promise<string> {
    const result = await io.run(args, { cwd });
    if (result.code)
      throw new Error(args[0] + " failed: " + result.error.trim());
    return result.output.trim();
  }

  function repository(): string {
    const value = io.env.GITHUB_REPOSITORY ?? "";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
      throw new Error("Invalid GitHub repository");
    return value;
  }

  async function api<T>(
    endpoint: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const args = ["gh", "api", "--method", method, endpoint];
    if (body !== undefined) args.push("--input", "-");
    const result = await io.run(args, {
      input: body === undefined ? undefined : JSON.stringify(body),
    });
    if (result.code)
      throw new Error("GitHub request failed: " + result.error.trim());
    return (result.output.trim() ? JSON.parse(result.output) : null) as T;
  }

  async function releases(): Promise<CandidateRelease[]> {
    const pages = JSON.parse(
      await command([
        "gh",
        "api",
        "--paginate",
        "--slurp",
        "repos/" + repository() + "/releases?per_page=100",
      ]),
    ) as CandidateRelease[][];
    return pages.flat();
  }

  async function output(values: Record<string, string>): Promise<void> {
    const destination = io.env.GITHUB_OUTPUT;
    if (!destination) throw new Error("GITHUB_OUTPUT is missing");
    for (const [key, value] of Object.entries(values))
      if (!/^[a-z_]+$/.test(key) || /[\r\n]/.test(value))
        throw new Error("Invalid workflow output");
    await io.append(
      destination,
      Object.entries(values)
        .map(([key, value]) => key + "=" + value + "\n")
        .join(""),
    );
  }

  async function tagCommit(tag: string): Promise<string | undefined> {
    releaseVersion(tag);
    const result = await io.run([
      "git",
      "rev-parse",
      "--verify",
      "refs/tags/" + tag + "^{commit}",
    ]);
    return result.code === 0 ? result.output.trim() : undefined;
  }

  async function resolveCandidate(): Promise<void> {
    if (io.env.GITHUB_REF !== "refs/heads/main")
      throw new Error("Releases require main");
    const head = io.env.GITHUB_SHA ?? "";
    if (head.length !== 40 || !shaPattern.test(head))
      throw new Error("Invalid event commit");
    const recovery = io.env.RECOVERY_TAG ?? "";
    const created = io.env.CREATED_TAG ?? "";
    const tag =
      recovery ||
      created ||
      "ast-mcp-v" +
        ((await io.file("package.json").json()) as { version: string }).version;
    releaseVersion(tag);
    const knownReleases = await releases();
    const pendingDraft = knownReleases.some(
      (item) =>
        item.draft &&
        !item.prerelease &&
        tagPattern.test(item.tag_name) &&
        !legacyRelease(item.tag_name),
    );
    const release = knownReleases.find((item) => item.tag_name === tag);
    if (!release) {
      if (recovery || created || io.env.RELEASE_OUTCOME === "failure")
        throw new Error("Release candidate is missing");
      await output({
        release_created: "false",
        pending_draft: String(pendingDraft),
      });
      return;
    }
    if (!recovery && !created && release.target_commitish !== head) {
      if (io.env.RELEASE_OUTCOME === "failure")
        throw new Error("Release Please failed without a matching release");
      await output({
        release_created: "false",
        pending_draft: String(pendingDraft),
      });
      return;
    }
    const commit = selectCandidate(
      release,
      head,
      Boolean(recovery),
      await tagCommit(tag),
    );
    await command(["git", "merge-base", "--is-ancestor", commit, head]);
    const manifest = JSON.parse(
      await command(["git", "show", commit + ":package.json"]),
    ) as { version: string };
    if (manifest.version !== releaseVersion(tag))
      throw new Error("Candidate version does not match the release");
    await output({
      release_created: "true",
      pending_draft: String(pendingDraft),
      tag_name: tag,
      candidate_sha: commit,
      release_id: String(release.id),
      draft: String(release.draft),
      legacy: String(legacyRelease(tag)),
      published_recovery: String(!release.draft && !legacyRelease(tag)),
    });
  }

  async function identity(localDraft = false): Promise<{
    release: CandidateRelease;
    tag: string;
    sha: string;
  }> {
    const tag = io.env.RELEASE_TAG ?? "";
    const sha = io.env.CANDIDATE_SHA ?? "";
    const id = io.env.RELEASE_ID ?? "";
    releaseVersion(tag);
    if (
      sha.length !== 40 ||
      !shaPattern.test(sha) ||
      !/^[1-9]\d*$/.test(id) ||
      id !== id.trim()
    )
      throw new Error("Invalid candidate identity");
    if (localDraft) {
      if (legacyRelease(tag))
        throw new Error("Legacy draft releases require a new version");
      if (
        !Number.isSafeInteger(Number(id)) ||
        io.env.GITHUB_REF !== "refs/heads/main" ||
        io.env.GITHUB_SHA !== sha ||
        (await command(["git", "rev-parse", "HEAD"])) !== sha
      )
        throw new Error(
          "Draft benchmark must match the qualified event commit",
        );
      return {
        release: {
          id: Number(id),
          tag_name: tag,
          target_commitish: sha,
          draft: true,
          prerelease: false,
          assets: [],
        },
        tag,
        sha,
      };
    }
    const release = await api<CandidateRelease>(
      "repos/" + repository() + "/releases/" + id,
    );
    if (
      release.tag_name !== tag ||
      String(release.id) !== id ||
      release.prerelease
    )
      throw new Error("Release identity changed");
    if (release.draft && legacyRelease(tag))
      throw new Error("Legacy draft releases require a new version");
    if (
      !release.draft &&
      (release.target_commitish !== sha || (await tagCommit(tag)) !== sha)
    )
      throw new Error("Published release identity changed");
    if (
      release.draft &&
      release.target_commitish !== sha &&
      io.env.RECOVERY_TAG !== tag
    )
      throw new Error("Draft target changed without explicit recovery");
    return { release, tag, sha };
  }

  async function benchmarkTool(args: string[]): Promise<string> {
    return command([
      io.executable,
      "scripts/release/release-benchmarks.ts",
      ...args,
    ]);
  }

  async function download(
    release: CandidateRelease,
    name: string,
    destination: string,
  ): Promise<void> {
    const asset = release.assets.find((item) => item.name === name);
    if (!asset?.digest || !/^sha256:[a-f0-9]{64}$/.test(asset.digest))
      throw new Error("Missing checksum-backed release asset " + name);
    const result = await io.run(
      [
        "gh",
        "api",
        "-H",
        "Accept: application/octet-stream",
        "repos/" + repository() + "/releases/assets/" + asset.id,
      ],
      { outputFile: destination },
    );
    if (result.code)
      throw new Error("Release asset download failed: " + result.error.trim());
    const hash = new Bun.CryptoHasher("sha256");
    for await (const chunk of io.file(destination).stream()) hash.update(chunk);
    if ("sha256:" + hash.digest("hex") !== asset.digest)
      throw new Error("Release asset digest mismatch");
  }

  async function extract(archive: string, destination: string): Promise<void> {
    const entries = (await command(["tar", "-tzf", archive])).split("\n");
    if (
      entries.some(
        (entry) => entry.startsWith("/") || entry.split("/").includes(".."),
      )
    )
      throw new Error("Unsafe standalone archive paths");
    await command(["mkdir", "-p", destination]);
    await command(["tar", "-xzf", archive, "-C", destination]);
  }

  async function verifyLocalArchive(
    archive: string,
    named = true,
  ): Promise<void> {
    const checksum = (await io.file(archive + ".sha256").text()).trim();
    const match = /^([a-f0-9]{64})(?:\s+\*?([^\r\n]+))?$/.exec(checksum);
    if (
      !match ||
      (named && match[2] !== path.basename(archive)) ||
      (match[2] && match[2] !== path.basename(archive))
    )
      throw new Error("Invalid standalone checksum");
    const hash = new Bun.CryptoHasher("sha256");
    for await (const chunk of io.file(archive).stream()) hash.update(chunk);
    if (hash.digest("hex") !== match[1])
      throw new Error("Standalone checksum mismatch");
  }

  async function benchmark(matrix: string, directory: string): Promise<void> {
    const draft = io.env.RELEASE_DRAFT;
    if (draft !== "true" && draft !== "false")
      throw new Error("Missing or invalid resolved release draft status");
    const { release, tag, sha } = await identity(draft === "true");
    if (draft === "false" && release.draft)
      throw new Error(
        "Published benchmark recovery requires a published release",
      );
    await command(["mkdir", "-p", directory]);
    const report = path.join(directory, "release-benchmarks.json");
    if (!release.draft) {
      if (legacyRelease(tag)) return;
      await download(release, "release-benchmarks.json", report);
      await benchmarkTool(["verify", report, tag, sha]);
      return;
    }
    const previous = previousStable(await releases(), tag);
    const previousSha = await tagCommit(previous.tag_name);
    if (!previousSha || previous.target_commitish !== previousSha)
      throw new Error("Previous release target and tag differ");
    const bootstrap = previous.tag_name === "ast-mcp-v0.9.1";
    if (!bootstrap) {
      const previousReport = path.join(
        directory,
        "previous-release-benchmarks.json",
      );
      await download(previous, "release-benchmarks.json", previousReport);
      await benchmarkTool([
        "verify",
        previousReport,
        previous.tag_name,
        previousSha,
      ]);
    }
    const currentArchive = path.resolve(
      matrix,
      "standalone-bun-linux-x64/ast-mcp-linux-x64.tar.gz",
    );
    await verifyLocalArchive(currentArchive);
    const candidateDirectory = path.resolve(directory, "candidate");
    await extract(currentArchive, candidateDirectory);
    const candidateCommand = JSON.stringify([
      path.join(candidateDirectory, "ast-mcp-bytecode"),
      "mcp",
      "--shared-stdio",
    ]);
    const args = [
      io.executable,
      "scripts/benchmark/shared-runtime-baseline.ts",
      "--clients=1,4,16",
      "--layout=same,mixed",
      "--workloads=read,write,indexed",
      "--rounds=5",
      "--samples=2",
    ];
    if (bootstrap) args.push("--command=" + candidateCommand);
    else {
      const previousArchive = path.resolve(
        directory,
        "ast-mcp-linux-x64.tar.gz",
      );
      await download(previous, "ast-mcp-linux-x64.tar.gz", previousArchive);
      await download(
        previous,
        "ast-mcp-linux-x64.tar.gz.sha256",
        previousArchive + ".sha256",
      );
      await verifyLocalArchive(previousArchive);
      const previousDirectory = path.resolve(directory, "previous");
      await extract(previousArchive, previousDirectory);
      args.push(
        "--command=" +
          JSON.stringify([
            path.join(previousDirectory, "ast-mcp-bytecode"),
            "mcp",
            "--shared-stdio",
          ]),
      );
      args.push("--compare-command=" + candidateCommand);
    }
    const raw = path.join(directory, "raw.json");
    const result = await io.run(args, {
      outputFile: raw,
      timeoutMs: 40 * 60_000,
    });
    if (result.code) {
      const failure =
        "Benchmark workloads failed with exit " +
        result.code +
        "\n\n" +
        result.error.slice(-6000) +
        "\n";
      if (io.env.GITHUB_STEP_SUMMARY)
        await io.append(io.env.GITHUB_STEP_SUMMARY, failure);
      io.write(failure);
      throw new Error("Benchmark workloads failed with exit " + result.code);
    }
    const collection = [
      io.executable,
      "scripts/release/release-benchmarks.ts",
      "collect",
      raw,
      report,
      tag,
      sha,
      ...(bootstrap ? [] : [previous.tag_name, previousSha]),
    ];
    const collected = await io.run(collection);
    let summary = collected.output;
    const diagnostic = collected.error.trim();
    if (collected.code && diagnostic && !summary.includes(diagnostic))
      summary += "\n" + diagnostic.slice(-6000) + "\n";
    if (io.env.GITHUB_STEP_SUMMARY)
      await io.append(io.env.GITHUB_STEP_SUMMARY, summary);
    io.write(summary);
    if (collected.code) throw new Error("Release benchmark gate failed");
  }

  async function upload(
    release: CandidateRelease,
    filename: string,
  ): Promise<void> {
    const name = path.basename(filename);
    const hash = new Bun.CryptoHasher("sha256");
    for await (const chunk of io.file(filename).stream()) hash.update(chunk);
    const digest = "sha256:" + hash.digest("hex");
    const existing = release.assets.find((asset) => asset.name === name);
    if (existing?.digest === digest) return;
    if (existing) {
      if (!release.draft)
        throw new Error("Published asset differs from qualified artifact");
      await api(
        "repos/" + repository() + "/releases/assets/" + existing.id,
        "DELETE",
      );
    }
    const result = await io.upload(
      "https://uploads.github.com/repos/" +
        repository() +
        "/releases/" +
        release.id +
        "/assets?name=" +
        encodeURIComponent(name),
      filename,
    );
    if (!result.ok)
      throw new Error("Release upload failed with status " + result.status);
    const asset = JSON.parse(result.body) as { digest?: string };
    if (asset.digest !== digest)
      throw new Error("Uploaded release asset digest mismatch");
  }

  async function attach(
    matrix: string,
    report: string,
    rootPackage: string,
  ): Promise<void> {
    const { release, tag, sha } = await identity();
    if (!legacyRelease(tag)) {
      await benchmarkTool(["verify", report, tag, sha]);
      if (!release.draft) return;
    }
    for (const target of targets) {
      const archive = path.join(
        matrix,
        "standalone-bun-" + target,
        "ast-mcp-" + target + ".tar.gz",
      );
      await verifyLocalArchive(archive);
      await upload(release, archive);
      await upload(release, archive + ".sha256");
      if (!legacyRelease(tag)) {
        const npm = path.join(
          matrix,
          "standalone-bun-" + target,
          "ast-mcp-npm-" + target + ".tgz",
        );
        await verifyLocalArchive(npm, false);
        await upload(release, npm);
        await upload(release, npm + ".sha256");
      }
    }
    if (!legacyRelease(tag)) {
      await verifyLocalArchive(rootPackage, false);
      await upload(release, rootPackage);
      await upload(release, rootPackage + ".sha256");
      await upload(release, report);
    }
  }

  async function notes(report: string): Promise<string> {
    const { tag, sha } = await identity();
    const version = releaseVersion(tag);
    const source = await command([
      "git",
      "show",
      sha + ":website/content/docs/releases/" + version + ".mdx",
    ]);
    const authored = renderReleaseNotes(source, version);
    return (
      authored.trimEnd() +
      "\n\n" +
      (await benchmarkTool(["render", report, tag, sha])) +
      "\n"
    );
  }

  async function promote(
    matrix: string,
    report: string,
    rootPackage: string,
  ): Promise<void> {
    const initial = await identity();
    const { tag, sha } = initial;
    if (!legacyRelease(tag)) await benchmarkTool(["verify", report, tag, sha]);
    if (!initial.release.draft) return;
    const body = await notes(report);
    const files: string[] = [];
    const npmFiles = [rootPackage, rootPackage + ".sha256"];
    await verifyLocalArchive(rootPackage, false);
    for (const target of targets) {
      const directory = path.join(matrix, "standalone-bun-" + target);
      const archive = path.join(directory, "ast-mcp-" + target + ".tar.gz");
      const npm = path.join(directory, "ast-mcp-npm-" + target + ".tgz");
      await verifyLocalArchive(archive);
      await verifyLocalArchive(npm, false);
      files.push(archive, archive + ".sha256");
      npmFiles.push(npm, npm + ".sha256");
    }
    files.push(report, ...npmFiles);
    const qualified = new Map<string, string>();
    for (const filename of files) {
      const hash = new Bun.CryptoHasher("sha256");
      for await (const chunk of io.file(filename).stream()) hash.update(chunk);
      qualified.set(path.basename(filename), "sha256:" + hash.digest("hex"));
    }
    const remoteTag = await io.run([
      "gh",
      "api",
      "--include",
      "repos/" + repository() + "/git/ref/tags/" + tag,
    ]);
    const status = /^HTTP\/[\d.]+\s+(\d+)/m.exec(remoteTag.output)?.[1];
    if (status !== "404") {
      if (remoteTag.code || status !== "200")
        throw new Error(
          "Cannot verify remote release tag: " + remoteTag.error.trim(),
        );
      let object = (
        JSON.parse(
          remoteTag.output
            .split(/\r?\n\r?\n/)
            .slice(1)
            .join("\n\n"),
        ) as {
          object: { type: string; sha: string };
        }
      ).object;
      for (let depth = 0; object.type === "tag" && depth < 8; depth++) {
        if (!shaPattern.test(object.sha))
          throw new Error("Invalid remote tag object");
        object = (
          await api<{ object: { type: string; sha: string } }>(
            "repos/" + repository() + "/git/tags/" + object.sha,
          )
        ).object;
      }
      if (object.type !== "commit" || object.sha !== sha)
        throw new Error(
          "Remote release tag differs from the qualified candidate",
        );
    }
    const { release } = await identity();
    if (
      !release.draft ||
      release.id !== initial.release.id ||
      release.target_commitish !== initial.release.target_commitish
    )
      throw new Error("Draft release changed before promotion");
    for (const [name, digest] of qualified) {
      const assets = release.assets.filter((asset) => asset.name === name);
      if (!assets.length) {
        if (name === "release-benchmarks.json")
          throw new Error("Release benchmark report is missing");
        if (name.endsWith(".tgz") || name.endsWith(".tgz.sha256"))
          throw new Error("Qualified npm release assets are missing");
        throw new Error("Qualified release assets are missing");
      }
      if (assets.length !== 1 || assets[0]!.digest !== digest)
        throw new Error("Qualified release asset digest mismatch: " + name);
    }
    const published = await api<CandidateRelease>(
      "repos/" + repository() + "/releases/" + release.id,
      "PATCH",
      { target_commitish: sha, body, draft: false },
    );
    if (
      published.draft ||
      published.tag_name !== tag ||
      published.target_commitish !== sha
    )
      throw new Error(
        "Published release does not match the qualified candidate",
      );
    const commit = await api<{ sha: string }>(
      "repos/" + repository() + "/commits/" + encodeURIComponent(tag),
    );
    if (commit.sha !== sha)
      throw new Error("Published tag does not match the qualified candidate");
  }

  async function publishNotes(report: string): Promise<void> {
    const { release, tag, sha } = await identity();
    if (release.draft) throw new Error("Cannot finalize notes for a draft");
    if (!legacyRelease(tag)) await benchmarkTool(["verify", report, tag, sha]);
    await api(
      "repos/" + repository() + "/actions/workflows/docs.yml/dispatches",
      "POST",
      { ref: "main" },
    );
  }

  async function restore(directory: string, matrix: boolean): Promise<void> {
    const { release, tag, sha } = await identity();
    if (release.draft || legacyRelease(tag))
      throw new Error("Only managed published releases can reuse artifacts");
    await command(["mkdir", "-p", directory]);
    const report = path.join(directory, "release-benchmarks.json");
    await download(release, "release-benchmarks.json", report);
    await benchmarkTool(["verify", report, tag, sha]);
    const entries = matrix
      ? targets.map((target) => ({
          directory: path.join(directory, "standalone-bun-" + target),
          archives: [
            "ast-mcp-" + target + ".tar.gz",
            "ast-mcp-npm-" + target + ".tgz",
          ],
        }))
      : [{ directory, archives: ["ast-mcp.tgz"] }];
    for (const entry of entries) {
      await command(["mkdir", "-p", entry.directory]);
      for (const name of entry.archives) {
        const filename = path.join(entry.directory, name);
        await download(release, name, filename);
        await download(release, name + ".sha256", filename + ".sha256");
        await verifyLocalArchive(filename, name.endsWith(".tar.gz"));
      }
    }
  }

  const [action, first, second, third, ...extra] = args;
  if (extra.length || (third && action !== "attach" && action !== "promote"))
    throw new Error("Unexpected release candidate arguments");
  switch (action) {
    case "resolve":
      if (first || second) throw new Error("resolve accepts no arguments");
      return resolveCandidate();
    case "benchmark":
      if (!first || !second)
        throw new Error("benchmark requires matrix and report directory");
      return benchmark(first, second);
    case "attach":
      if (!first || !second || !third)
        throw new Error("attach requires matrix and report and root package");
      return attach(first, second, third);
    case "promote":
      if (!first || !second || !third)
        throw new Error("promote requires matrix and report and root package");
      return promote(first, second, third);
    case "restore-root":
    case "restore-matrix":
      if (!first || second) throw new Error("restore requires directory");
      return restore(first, action === "restore-matrix");
    case "notes":
      if (!first || second) throw new Error("notes requires report");
      return publishNotes(first);
    default:
      throw new Error("Unknown release candidate command");
  }
}

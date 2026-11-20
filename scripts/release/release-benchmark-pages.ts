import { createHash } from "node:crypto";

import { renderVerifiedBenchmarkReport } from "./release-benchmarks.ts";
import { usesHostedBenchmarks } from "./render-release-notes.ts";

export const benchmarkAssetName = "release-benchmarks.json";
const maximumReportBytes = 1024 * 1024;
const releasePage = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.mdx$/;
const oid = /^[a-f0-9]{40}$/;

type ReportSource = {
  tagCommit(tag: string): Promise<string>;
  asset(id: number): Promise<Uint8Array>;
};

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid GitHub release metadata");
  return value as Record<string, unknown>;
}

function publishedReleases(metadata: unknown) {
  if (!Array.isArray(metadata))
    throw new Error("Invalid GitHub releases response");
  const releases = new Map<string, Record<string, unknown>>();
  for (const item of metadata) {
    const release = object(item);
    if (
      typeof release.tag_name !== "string" ||
      typeof release.draft !== "boolean" ||
      typeof release.prerelease !== "boolean"
    )
      throw new Error("GitHub release metadata is incomplete");
    if (release.draft || release.prerelease) continue;
    if (releases.has(release.tag_name))
      throw new Error("Duplicate GitHub release " + release.tag_name);
    releases.set(release.tag_name, release);
  }
  return releases;
}

async function readReport(
  tag: string,
  release: Record<string, unknown>,
  source: ReportSource,
) {
  if (!Array.isArray(release.assets))
    throw new Error("Missing release assets for " + tag);
  const assets = release.assets
    .map(object)
    .filter((asset) => asset.name === benchmarkAssetName);
  const [asset] = assets;
  const id = asset?.id;
  const size = asset?.size;
  const digest = asset?.digest;
  if (
    assets.length !== 1 ||
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > maximumReportBytes ||
    typeof digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(digest)
  )
    throw new Error("Missing or invalid benchmark asset for " + tag);
  const sha = await source.tagCommit(tag);
  if (!oid.test(sha)) throw new Error("Invalid tag commit for " + tag);
  const bytes = await source.asset(id);
  if (
    bytes.byteLength !== size ||
    "sha256:" + createHash("sha256").update(bytes).digest("hex") !== digest
  )
    throw new Error("Benchmark asset checksum mismatch for " + tag);
  const report: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  return { report, sha };
}

export function hostedReleasePageVersion(filename: string): string | undefined {
  const version = releasePage.exec(filename)?.[1];
  return version && usesHostedBenchmarks(version) ? version : undefined;
}

export async function prepareBenchmarkedReleasePages(
  authored: ReadonlyMap<string, string>,
  metadata: unknown,
  source: ReportSource,
  render = renderVerifiedBenchmarkReport,
) {
  const published = publishedReleases(metadata);
  const updates = new Map<string, string | null>();
  for (const [filename, content] of authored) {
    const version = hostedReleasePageVersion(filename);
    if (!version) continue;
    const tag = "ast-mcp-v" + version;
    const release = published.get(tag);
    if (!release) {
      updates.set(filename, null);
      continue;
    }
    const { report, sha } = await readReport(tag, release, source);
    const section = render(report, tag, sha).trim();
    if (content.trimEnd().endsWith(section)) continue;
    if (/^## Benchmark comparison\s*$/m.test(content))
      throw new Error("Duplicate benchmark section for " + tag);
    updates.set(filename, content.trimEnd() + "\n\n" + section + "\n");
  }
  return updates;
}

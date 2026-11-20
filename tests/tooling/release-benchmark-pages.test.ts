import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  benchmarkAssetName,
  prepareBenchmarkedReleasePages,
} from "../../scripts/release/release-benchmark-pages.ts";
import { renderReleaseNotes } from "../../scripts/release/render-release-notes.ts";

const sha = "a".repeat(40);
const version = "0.9.2";
const tag = "ast-mcp-v" + version;
const page = version + ".mdx";
const authored = "---\ntitle: " + version + "\n---\n\nAuthored release.\n";
const chart = [
  "```mermaid",
  "xychart-beta",
  '    title "Workflow latency"',
  '    x-axis ["Prior", "Current"]',
  '    y-axis "Milliseconds" 0 --> 50',
  "    bar [30, 20]",
  "```",
].join("\n");
const section = "## Benchmark comparison\n\n" + chart;
const payload = { schemaVersion: 1 };
const bytes = new TextEncoder().encode(JSON.stringify(payload));
const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");

function release() {
  return {
    draft: false,
    prerelease: false,
    tag_name: tag,
    assets: [{ name: benchmarkAssetName, id: 40, size: bytes.length, digest }],
  };
}

function fixture() {
  const calls: string[] = [];
  const source = {
    async tagCommit(value: string) {
      calls.push(value);
      return sha;
    },
    async asset(id: number) {
      calls.push(String(id));
      return bytes;
    },
  };
  const render = (value: unknown, reportTag: string, commit: string) => {
    expect(value).toEqual(payload);
    expect(reportTag).toBe(tag);
    expect(commit).toBe(sha);
    return section;
  };
  return { source, render, calls };
}

describe("published release benchmark documentation", () => {
  test("loads the verified report and adds the same section once", async () => {
    const { source, render, calls } = fixture();
    const releases = [release()];
    const pages = new Map([[page, authored]]);
    const changes = await prepareBenchmarkedReleasePages(
      pages,
      releases,
      source,
      render,
    );
    expect(changes.get(page)).toBe(authored + "\n" + section + "\n");
    expect(calls).toEqual([tag, "40"]);
    pages.set(page, changes.get(page)!);
    expect(
      await prepareBenchmarkedReleasePages(pages, releases, source, render),
    ).toEqual(new Map());
  });

  test.each([
    ["missing", []],
    ["draft", [{ ...release(), draft: true }]],
    ["prerelease", [{ ...release(), prerelease: true }]],
  ])(
    "omits the %s page and preserves historical pages",
    async (_, releases) => {
      const { source, render, calls } = fixture();
      const pages = new Map([
        ["0.9.1.mdx", "historical macOS benchmark"],
        [page, authored],
        ["meta.json", "{}"],
      ]);
      expect(
        await prepareBenchmarkedReleasePages(pages, releases, source, render),
      ).toEqual(new Map([[page, null]]));
      expect(calls).toEqual([]);
    },
  );

  test("rejects a missing report for a published version", async () => {
    const { source, render, calls } = fixture();
    await expect(
      prepareBenchmarkedReleasePages(
        new Map([[page, authored]]),
        [{ ...release(), assets: [] }],
        source,
        render,
      ),
    ).rejects.toThrow("Missing or invalid benchmark asset");
    expect(calls).toEqual([]);
  });

  test("rejects a report with a mismatched checksum before rendering", async () => {
    const { source } = fixture();
    const unexpectedRender = () => {
      throw new Error("Unexpected render");
    };
    const asset = {
      ...release().assets[0]!,
      digest: "sha256:" + "0".repeat(64),
    };
    await expect(
      prepareBenchmarkedReleasePages(
        new Map([[page, authored]]),
        [{ ...release(), assets: [asset] }],
        source,
        unexpectedRender,
      ),
    ).rejects.toThrow("checksum mismatch");
  });

  test.each([
    ["non-list metadata", null, "Invalid GitHub releases response"],
    ["invalid release", [null], "Invalid GitHub release metadata"],
    [
      "incomplete release",
      [{ tag_name: tag }],
      "release metadata is incomplete",
    ],
    ["duplicate releases", [release(), release()], "Duplicate GitHub release"],
    [
      "missing assets",
      [{ ...release(), assets: undefined }],
      "Missing release assets",
    ],
  ])("rejects %s before fetching an asset", async (_, metadata, message) => {
    const { source, render, calls } = fixture();
    await expect(
      prepareBenchmarkedReleasePages(
        new Map([[page, authored]]),
        metadata,
        source,
        render,
      ),
    ).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  test("rejects an unresolved release commit before reading the asset", async () => {
    const { source, render, calls } = fixture();
    source.tagCommit = async () => "main";
    await expect(
      prepareBenchmarkedReleasePages(
        new Map([[page, authored]]),
        [release()],
        source,
        render,
      ),
    ).rejects.toThrow("Invalid tag commit");
    expect(calls).toEqual([]);
  });

  test("rejects a conflicting benchmark section in the authored page", async () => {
    const { source, render } = fixture();
    const pages = new Map([
      [page, authored + "\n## Benchmark comparison\n\nOld data.\n"],
    ]);
    await expect(
      prepareBenchmarkedReleasePages(pages, [release()], source, render),
    ).rejects.toThrow("Duplicate benchmark section");
  });

  test("preserves benchmark charts and filters other diagrams in GitHub notes", () => {
    const flow = "```mermaid\nflowchart LR\n    A --> B\n```";
    const notes = renderReleaseNotes(
      authored + "\n" + flow + "\n" + section,
      version,
    );
    expect(notes).toContain(chart);
    expect(notes).toContain("## Benchmark comparison");
    expect(notes).not.toContain("flowchart");
    expect(notes).toContain("docs/releases/" + version + "/");
  });
});
